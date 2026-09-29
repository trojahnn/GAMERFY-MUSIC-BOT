// Resolves a search or a URL into a playable track and opens its audio as an
// Ogg Opus stream (what the SDK's `voice.play` expects from a stream). yt-dlp
// gives the raw audio, ffmpeg transcodes it to Ogg Opus. Everything
// YouTube-specific is behind the `Resolver` interface, so swapping YouTube for a
// licensed source later is a new class, not a rewrite.
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';

export interface Track {
  readonly title: string;
  readonly durationSec: number | null;
  /** The canonical page URL the audio is opened from. */
  readonly url: string;
  /** The username who asked for it. */
  readonly requestedBy: string;
}

export interface Resolver {
  /** A search text or a URL becomes a track (title, duration, canonical URL). */
  resolve(query: string, requestedBy: string): Promise<Track>;
  /** The track's audio as an Ogg Opus stream to hand to the SDK's `voice.play`. */
  open(track: Track): NodeJS.ReadableStream;
}

/** The part of a spawned child this module drives — a test doubles it. */
export interface ResolverChild {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (command: string, args: readonly string[]) => ResolverChild;

const SEARCH_PREFIX = 'ytsearch1:';
/** yt-dlp's YouTube search does an anti-bot handshake that takes ~20-30 s; a
 * truly hung one is killed after this generous ceiling. */
export const RESOLVE_TIMEOUT_MS = 60_000;

export function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/** `yt-dlp`'s `%(duration)s` is seconds, `NA` when it has none. */
export function parseDuration(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

/** Closes a stream and, with it, the processes behind it. Exported for the player's opened-ahead track. */
export function destroyStream(stream: NodeJS.ReadableStream): void {
  const maybe = stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
  if (typeof maybe.destroy === 'function') maybe.destroy();
}

const defaultSpawn: SpawnFn = (command, args) => spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ResolverChild;

export class YtDlpResolver implements Resolver {
  readonly #ytdlp: string;
  readonly #ffmpeg: string;
  readonly #extra: readonly string[];
  readonly #spawn: SpawnFn;

  constructor(options: { ytdlpPath?: string; ffmpegPath?: string; extraArgs?: readonly string[]; spawn?: SpawnFn } = {}) {
    this.#ytdlp = options.ytdlpPath ?? 'yt-dlp';
    this.#ffmpeg = options.ffmpegPath ?? 'ffmpeg';
    // Operator escape hatch for YouTube's anti-bot (e.g. --cookies, a PO token),
    // so a blocked datacenter IP can be worked around without a rebuild.
    this.#extra = options.extraArgs ?? [];
    this.#spawn = options.spawn ?? defaultSpawn;
  }

  buildResolveArgs(query: string): string[] {
    const target = isUrl(query) ? query.trim() : `${SEARCH_PREFIX}${query.trim()}`;
    return ['--no-playlist', ...this.#extra, '--skip-download', '--print', '%(title)s\t%(duration)s\t%(webpage_url)s', target];
  }

  buildYtdlpArgs(url: string): string[] {
    return ['--no-playlist', ...this.#extra, '-f', 'bestaudio', '-o', '-', url];
  }

  buildFfmpegArgs(): string[] {
    // Transcode whatever yt-dlp yields (WebM/Opus, M4A/AAC) into Ogg Opus at
    // 48 kHz stereo — what LiveKit and the SDK's demuxer expect.
    return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg', 'pipe:1'];
  }

  async resolve(query: string, requestedBy: string): Promise<Track> {
    const q = query.trim();
    if (q === '') throw new Error('diga o que tocar. Ex.: /play numb - linkin park');

    const child = this.#spawn(this.#ytdlp, this.buildResolveArgs(q));
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: unknown) => { out += String(chunk); });
    child.stderr?.on('data', (chunk: unknown) => { err += String(chunk); });

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new Error(`a busca por "${q}" demorou demais.`));
      }, RESOLVE_TIMEOUT_MS);
      const clear = (): void => clearTimeout(timer);
      child.once('error', (error) => { clear(); reject(error); });
      child.once('close', (value) => { clear(); resolve(value); });
    });

    if (code !== 0) {
      const tail = lastLine(err);
      throw new Error(`não encontrei nada para "${q}".${tail === '' ? '' : ` (${tail})`}`);
    }
    const line = out.split('\n').map((piece) => piece.trim()).find((piece) => piece !== '');
    if (line === undefined) throw new Error(`não encontrei nada para "${q}".`);

    const parts = line.split('\t');
    const title = parts[0] ?? q;
    const parsedUrl = parts[2];
    const url = parsedUrl !== undefined && parsedUrl !== '' ? parsedUrl : isUrl(q) ? q : '';
    if (url === '') throw new Error(`o yt-dlp não devolveu a URL de "${q}".`);
    return { title, durationSec: parseDuration(parts[1]), url, requestedBy };
  }

  open(track: Track): NodeJS.ReadableStream {
    const ytdlp = this.#spawn(this.#ytdlp, this.buildYtdlpArgs(track.url));
    const ffmpeg = this.#spawn(this.#ffmpeg, this.buildFfmpegArgs());

    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      try { ytdlp.kill('SIGKILL'); } catch { /* already gone */ }
      try { ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
    };

    const out = ffmpeg.stdout;
    if (out === null || ffmpeg.stdin === null || ytdlp.stdout === null) {
      cleanup();
      throw new Error('não consegui abrir o áudio da faixa (yt-dlp/ffmpeg).');
    }

    // Every 'error' path is handled, or an unhandled EventEmitter error would
    // crash the whole bot: a missing binary, an EPIPE when one side dies first,
    // a read failure. On any of them: kill both children and end the stream, so
    // the player's own catch treats it as "pulei a faixa".
    ytdlp.on('error', () => { cleanup(); destroyStream(out); });
    ffmpeg.on('error', () => { cleanup(); destroyStream(out); });
    ytdlp.stdout.on('error', () => cleanup());
    ffmpeg.stdin.on('error', () => cleanup());
    out.on('error', () => cleanup());
    // play() destroys the stream when the track ends or is skipped → kill both.
    out.on('close', () => cleanup());
    ytdlp.stderr?.resume();
    ffmpeg.stderr?.resume();

    ytdlp.stdout.pipe(ffmpeg.stdin);
    return out;
  }
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((piece) => piece.trim()).filter((piece) => piece !== '');
  return lines.length === 0 ? '' : (lines[lines.length - 1] as string);
}

/**
 * The resolver of the end-to-end proof: every query becomes ONE local Ogg/Opus
 * file (`MUSIC_TEST_TRACK`), so the proof exercises the whole chain — command,
 * the asker's room, the join, the audio reaching a listener — without yt-dlp
 * or the network in the way. Never used in service (config.ts).
 */
export class FileResolver implements Resolver {
  constructor(private readonly path: string) {}

  resolve(query: string, requestedBy: string): Promise<Track> {
    return Promise.resolve({ title: `teste: ${query.trim()}`, durationSec: null, url: this.path, requestedBy });
  }

  open(_track: Track): NodeJS.ReadableStream {
    return createReadStream(this.path);
  }
}
