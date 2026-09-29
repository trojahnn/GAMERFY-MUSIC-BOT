// The per-guild player: a queue, the track in flight, and the voice connection.
// One `#run` loop per guild advances the queue and hangs up when it empties.
import { destroyStream, type Resolver, type Track } from './resolver.js';

/** The slice of the SDK's `VoiceConnection` this needs — a test doubles it. */
export interface Connection {
  play(input: NodeJS.ReadableStream | string): Promise<void>;
  stop(): void;
  /** Holds the audio where it is, source open; `resume()` carries on from the same packet. */
  pause(): boolean;
  resume(): boolean;
  readonly paused: boolean;
  /** How much of the track has actually been sent, in ms — the card's counter. */
  readonly elapsedMs: number;
  leave(): Promise<void>;
}

export interface PlayerDeps {
  readonly resolver: Resolver;
  readonly maxQueue: number;
  /** Opens a voice connection to a channel (the SDK's `voice.join`). */
  join(channelId: string): Promise<Connection>;
  /**
   * The voice channel the user is in, in THIS guild, or `null`. Async because
   * the answer may have to be read fresh from the server when the cache says
   * "none" (index.ts: `bot.voiceChannelOf`, then `bot.fetchGuild`).
   */
  voiceChannelOf(userId: string): Promise<string | null> | string | null;
  /** The name of a voice room of THIS guild, for "ocupado tocando em #sala"; `null` when unknown. */
  roomNameOf?(channelId: string): string | null;
  /**
   * The card at the foot of the members column (index.ts hands `bot.setWidget`).
   *
   * Called on every change worth showing and never on a timer: what moves
   * between two of these is the progress bar, and a card republished every
   * second to move a bar would be a write per second per guild for something
   * nobody is looking at most of the time.
   *
   * Optional, so a player built without it (every test here) simply publishes
   * nothing.
   */
  publishWidget?(snapshot: PlayerSnapshot): void;
  /** Replies in a text channel (the SDK's `messages.send`), never throwing. */
  say(channelId: string, text: string): Promise<void>;
}

export interface Requester {
  readonly id: string;
  readonly username: string;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'ao vivo';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

function label(track: Track): string {
  return `**${track.title}** (${formatDuration(track.durationSec)})`;
}

/** Duck-typed: a refusal the SDK minted with `code === 'missing_permission'`. */
function isMissingPermission(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'missing_permission';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the widget needs to know, and nothing else — the player's own state, flattened. */
export interface PlayerSnapshot {
  /** `null` when nothing is playing: the card then says so instead of vanishing. */
  current: Track | null;
  /** The tracks waiting, in order. The card shows the first few and counts the rest. */
  queue: readonly Track[];
  /** The room being played into, which is who may press the buttons. `null` when idle. */
  voiceChannelId: string | null;
  /** Held where it is — the card draws play instead of pause. */
  paused: boolean;
  /**
   * Where the audio is, in milliseconds, and how long the track lasts.
   *
   * Taken from the connection's own count of what it has SENT, not from a
   * stopwatch: a track whose source stalled, or that spent a minute paused, is
   * where the room heard it, not where a clock says it should be.
   */
  elapsedMs: number | null;
  durationMs: number | null;
}

export class GuildPlayer {
  readonly #queue: Track[] = [];
  #current: Track | null = null;
  #connection: Connection | null = null;
  #running = false;
  #stopping = false;
  /** Set by skip(); the loop drops the current/next track and clears it. */
  #skipRequested = false;
  /** The last room joined, to resume if a track is queued during tear-down. */
  #lastVoiceChannelId: string | null = null;
  /** Where announcements go — the last channel a command came from. */
  #announceChannelId: string | null = null;
  /**
   * A track's audio opened before it was needed, with the track it belongs to.
   *
   * It exists for the first `/play` of a session. Joining a voice room and
   * opening a track's audio each take seconds, neither depends on the other,
   * and until now they ran one after the other — so the listener waited for
   * the sum. Opened here, the audio is already on its way while the bot is
   * still shaking hands with the room, and what they wait for is the longer of
   * the two.
   *
   * Only ever the track at the head of the queue, and dropped if the queue
   * moved on: holding an open ffmpeg for a track further down would keep a
   * connection alive for minutes to save seconds.
   */
  #opened: { track: Track; stream: NodeJS.ReadableStream } | null = null;

  constructor(
    private readonly guildId: string,
    private readonly deps: PlayerDeps,
  ) {}

  get isRunning(): boolean {
    return this.#running;
  }

  #atCapacity(): boolean {
    return this.#queue.length + (this.#current === null ? 0 : 1) >= this.deps.maxQueue;
  }

  /**
   * Publishes the card, if anybody is listening. Never throws: the widget is
   * decoration over the music, and a failure to draw it must not end a song.
   */
  #publish(): void {
    this.deps.publishWidget?.({
      current: this.#current,
      queue: [...this.#queue],
      voiceChannelId: this.#connection === null ? null : this.#lastVoiceChannelId,
      paused: this.#connection?.paused ?? false,
      elapsedMs: this.#connection === null || this.#current === null ? null : this.#connection.elapsedMs,
      durationMs: this.#current?.durationSec == null ? null : Math.round(this.#current.durationSec * 1000),
    });
  }

  /** The room the running loop joined (or is tearing down from), or `null` when idle. */
  get currentVoiceChannelId(): string | null {
    return this.#running ? this.#lastVoiceChannelId : null;
  }

  /**
   * `/play`, from ANY text channel of the guild: the target room is wherever the
   * ASKER is right now, never the channel the command was typed in. The rules,
   * in the order they are checked — before the track is resolved, so nobody
   * waits on yt-dlp to be told no:
   *
   *   1. no query → how to use it;
   *   2. the asker is in no voice room → "join one first";
   *   3. the bot is playing in ANOTHER room of this guild → "busy in #room" and
   *      it stays there (one room per guild; whoever is in the other room asks
   *      from there, or `/stop`);
   *   4. same room while playing → queued;
   *   5. idle → join the asker's room and start.
   */
  async play(query: string, requester: Requester, channelId: string): Promise<void> {
    this.#announceChannelId = channelId;
    if (query.trim() === '') {
      await this.deps.say(channelId, 'Diga o que tocar. Ex.: `/play numb - linkin park`');
      return;
    }
    const voiceChannelId = await this.deps.voiceChannelOf(requester.id);
    if (voiceChannelId === null) {
      // "None" is the bot's own horizon, not the asker's: the server lists only
      // the rooms the bot may see, so somebody sitting in a private room the
      // bot was kept out of reads as being in none. The answer says so, instead
      // of telling a person in a room to enter one (19/09).
      await this.deps.say(channelId, 'Não te encontrei em nenhuma sala de voz que eu consiga ver. Entre numa sala (ou peça para liberarem a sala ao bot) e tente de novo.');
      return;
    }
    const busyIn = this.currentVoiceChannelId;
    if (busyIn !== null && busyIn !== voiceChannelId) {
      const name = this.deps.roomNameOf?.(busyIn) ?? null;
      await this.deps.say(channelId, name === null ? 'Estou ocupado tocando em outra sala.' : `Estou ocupado tocando em #${name}.`);
      return;
    }
    if (this.#atCapacity()) {
      await this.deps.say(channelId, `A fila está cheia (limite de ${String(this.deps.maxQueue)}).`);
      return;
    }

    let track: Track;
    try {
      track = await this.deps.resolver.resolve(query, requester.username);
    } catch (error) {
      await this.deps.say(channelId, `Não consegui: ${reason(error)}`);
      return;
    }

    // Re-check after the await: concurrent /play calls could have filled it.
    if (this.#atCapacity()) {
      await this.deps.say(channelId, `A fila está cheia (limite de ${String(this.deps.maxQueue)}).`);
      return;
    }

    this.#queue.push(track);
    this.#publish();
    if (this.#running) {
      await this.deps.say(channelId, `Na fila (posição ${String(this.#queue.length)}): ${label(track)}`);
      return;
    }
    // Not running: start the loop. It announces "Tocando agora" once in the
    // room. `void`: play() returns now; the loop owns the rest.
    void this.#run(voiceChannelId);
  }

  /**
   * `channelId` is where the answer goes, and it is OPTIONAL because a press on
   * the widget names no text channel — it names a voice room, which is not a
   * place anybody can be told anything. A press therefore answers where the
   * last command came from, and answers nowhere at all if there has been no
   * command: the person pressing a button is already looking at the card, and
   * the card changing is the answer.
   */
  skip(channelId?: string): Promise<void> {
    if (channelId !== undefined) this.#announceChannelId = channelId;
    const where = channelId ?? this.#announceChannelId;
    if (this.#current === null) return where === null ? Promise.resolve() : this.deps.say(where, 'Não há nada tocando.');
    const skipped = this.#current;
    this.#skipRequested = true; // caught by the loop even if play() has not started yet
    this.#connection?.stop(); // ends the awaited play(); the loop advances
    return where === null ? Promise.resolve() : this.deps.say(where, `Pulei ${label(skipped)}.`);
  }

  /**
   * Holds the music where it is. `channelId` is optional for the same reason
   * as `skip`: a press on the widget names a voice room, not a place to answer.
   *
   * Not a stop: the track stays where it is and `resume()` carries on from the
   * same packet, which is what somebody pressing pause means.
   */
  pause(channelId?: string): Promise<void> {
    if (channelId !== undefined) this.#announceChannelId = channelId;
    const where = channelId ?? this.#announceChannelId;
    const held = this.#connection?.pause() ?? false;
    this.#publish();
    if (!held) return where === null ? Promise.resolve() : this.deps.say(where, 'Não há nada tocando.');
    return where === null ? Promise.resolve() : this.deps.say(where, 'Pausei.');
  }

  /** Lets a paused track go on. */
  resume(channelId?: string): Promise<void> {
    if (channelId !== undefined) this.#announceChannelId = channelId;
    const where = channelId ?? this.#announceChannelId;
    const went = this.#connection?.resume() ?? false;
    this.#publish();
    if (!went) return where === null ? Promise.resolve() : this.deps.say(where, 'Não há nada pausado.');
    return where === null ? Promise.resolve() : this.deps.say(where, 'Voltei.');
  }

  /** `channelId` optional for the same reason as `skip` above. */
  stop(channelId?: string): Promise<void> {
    if (channelId !== undefined) this.#announceChannelId = channelId;
    const where = channelId ?? this.#announceChannelId;
    if (!this.#running) return where === null ? Promise.resolve() : this.deps.say(where, 'Não estou tocando nada.');
    this.#stopping = true;
    this.#queue.length = 0;
    this.#connection?.stop(); // ends the current track; the loop sees #stopping and leaves
    return where === null ? Promise.resolve() : this.deps.say(where, 'Parei e saí da sala.');
  }

  showQueue(channelId: string): Promise<void> {
    if (this.#current === null && this.#queue.length === 0) return this.deps.say(channelId, 'A fila está vazia.');
    const lines: string[] = [];
    if (this.#current !== null) lines.push(`Tocando agora: ${label(this.#current)} — pedido por ${this.#current.requestedBy}`);
    this.#queue.slice(0, 10).forEach((track, index) => {
      lines.push(`${String(index + 1)}. ${label(track)} — ${track.requestedBy}`);
    });
    if (this.#queue.length > 10) lines.push(`… e mais ${String(this.#queue.length - 10)}.`);
    return this.deps.say(channelId, lines.join('\n'));
  }

  nowPlaying(channelId: string): Promise<void> {
    if (this.#current === null) return this.deps.say(channelId, 'Nada tocando.');
    return this.deps.say(channelId, `Tocando agora: ${label(this.#current)} — pedido por ${this.#current.requestedBy}`);
  }

  /** Opens a track's audio ahead of time, if there is one and none is open. */
  #openAhead(track: Track | undefined): void {
    if (track === undefined || this.#opened !== null) return;
    try {
      this.#opened = { track, stream: this.deps.resolver.open(track) };
    } catch {
      // Swallowed on purpose: this is an optimisation, and the real `open` at
      // play time is where a failure gets to say why the track was skipped.
      this.#opened = null;
    }
  }

  /** The audio for a track: the one opened ahead if it is the same track, else a fresh one. */
  #audioFor(track: Track): NodeJS.ReadableStream {
    const ready = this.#opened;
    this.#opened = null;
    if (ready !== null && ready.track === track) return ready.stream;
    // The queue moved while we were joining (a skip, a clear): whatever was
    // opened is for a track nobody is playing, and it holds an ffmpeg.
    if (ready !== null) destroyStream(ready.stream);
    return this.deps.resolver.open(track);
  }

  /** Closes an opened-ahead stream nobody will play — a join that failed, a stop. */
  #dropOpened(): void {
    const ready = this.#opened;
    this.#opened = null;
    if (ready !== null) destroyStream(ready.stream);
  }

  async #run(voiceChannelId: string): Promise<void> {
    if (this.#running) return; // never two loops (never two joins) for one guild
    this.#running = true;
    this.#stopping = false;
    this.#skipRequested = false;
    this.#lastVoiceChannelId = voiceChannelId;

    // Started BEFORE the join and not awaited: `open` hands back a stream whose
    // processes are already running, so the audio is fetched while the room is
    // being joined instead of after it.
    this.#openAhead(this.#queue[0]);

    try {
      this.#connection = await this.deps.join(voiceChannelId);
    } catch (error) {
      this.#running = false;
      this.#queue.length = 0;
      this.#dropOpened();
      if (this.#announceChannelId !== null) await this.deps.say(this.#announceChannelId, `Não consegui entrar na sala: ${reason(error)}`);
      return;
    }

    try {
      while (this.#queue.length > 0 && !this.#stopping) {
        const track = this.#queue.shift() as Track;
        this.#current = track;
        if (this.#skipRequested) {
          this.#skipRequested = false; // a skip landed before this track started
          this.#current = null;
          continue;
        }
        const channelId = this.#announceChannelId;
        this.#publish();
        if (channelId !== null) await this.deps.say(channelId, `Tocando agora: ${label(track)}`);
        if (this.#skipRequested) {
          this.#skipRequested = false; // …or during that announce
          this.#current = null;
          continue;
        }

        try {
          await this.#connection.play(this.#audioFor(track));
        } catch (error) {
          if (isMissingPermission(error)) {
            this.#stopping = true;
            if (channelId !== null) await this.deps.say(channelId, 'Não tenho permissão de falar nessa sala. Saí.');
          } else if (channelId !== null) {
            await this.deps.say(channelId, `Pulei ${label(track)}: ${reason(error)}`);
          }
        }
        this.#skipRequested = false; // consume a skip that ended this track
        this.#current = null;
      }
    } finally {
      const connection = this.#connection;
      const stopping = this.#stopping;
      this.#connection = null;
      this.#current = null;
      this.#dropOpened();
      // #running stays true across leave(), so no second #run (double join) can
      // start while this one is hanging up.
      await connection?.leave().catch(() => undefined);
      this.#running = false;
      // The room is gone, so the card goes with it: `voiceChannelId` is null
      // now and index.ts reads that as "take it down".
      this.#publish();

      if (!stopping && this.#announceChannelId !== null) await this.deps.say(this.#announceChannelId, 'A fila acabou. Saí da sala.');
      // A track queued during the tear-down above would be orphaned: pick it up.
      if (!this.#stopping && this.#queue.length > 0 && this.#lastVoiceChannelId !== null) void this.#run(this.#lastVoiceChannelId);
    }
  }
}
