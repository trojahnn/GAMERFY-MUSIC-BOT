import { describe, expect, it, vi } from 'vitest';
import { formatDuration, GuildPlayer, type Connection, type PlayerDeps } from '../player.js';
import type { Resolver, Track } from '../resolver.js';

/** A voice connection whose `play()` hangs until the track "ends": `endCurrent()`
 * (natural finish) resolves it, `endCurrent(error)` rejects it (a bad stream),
 * and `stop()` (skip/stop) resolves it. */
class FakeConnection implements Connection {
  playCalls = 0;
  left = false;
  #end: ((error?: Error) => void) | null = null;
  async play(): Promise<void> {
    this.playCalls += 1;
    await new Promise<void>((resolve, reject) => {
      this.#end = (error) => (error ? reject(error) : resolve());
    });
  }
  /** The pause, as the real connection reports it: held or not, never a restart. */
  paused = false;
  /** The real one counts frames written; a test just says where the audio is. */
  elapsedMs = 0;
  pause(): boolean {
    if (this.playCalls === 0 || this.paused) return false;
    this.paused = true;
    return true;
  }
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }
  endCurrent(error?: Error): void {
    const end = this.#end;
    this.#end = null;
    end?.(error);
  }
  stop(): void {
    this.endCurrent();
  }
  async leave(): Promise<void> {
    this.left = true;
  }
}

function make(overrides: { voiceChannelId?: string | null; resolve?: Resolver['resolve']; maxQueue?: number; joinError?: Error; roomNames?: Record<string, string>; publishWidget?: PlayerDeps['publishWidget'] } = {}) {
  const said: string[] = [];
  const connection = new FakeConnection();
  const resolve: Resolver['resolve'] =
    overrides.resolve ??
    (async (query: string, requestedBy: string): Promise<Track> => ({ title: query, durationSec: 100, url: `https://x/${query}`, requestedBy }));
  const resolver: Resolver = { resolve: vi.fn(resolve), open: vi.fn(() => ({}) as unknown as NodeJS.ReadableStream) };
  const join = vi.fn(async () => {
    if (overrides.joinError !== undefined) throw overrides.joinError;
    return connection;
  });
  const deps: PlayerDeps = {
    resolver,
    maxQueue: overrides.maxQueue ?? 3,
    join,
    // Async on purpose: index.ts reads the cache and then the server (`fetchGuild`).
    voiceChannelOf: vi.fn(async () => (overrides.voiceChannelId === undefined ? 'vc1' : overrides.voiceChannelId)),
    roomNameOf: vi.fn((channelId: string) => overrides.roomNames?.[channelId] ?? null),
    ...(overrides.publishWidget !== undefined ? { publishWidget: overrides.publishWidget } : {}),
    say: vi.fn(async (_channelId: string, text: string) => {
      said.push(text);
    }),
  };
  return { player: new GuildPlayer('g1', deps), connection, deps, said };
}

const ana = { id: 'u1', username: 'ana' };
const has = (bucket: string[], needle: string): boolean => bucket.some((text) => text.includes(needle));

describe('formatDuration', () => {
  it('renders m:ss, and null as ao vivo', () => {
    expect(formatDuration(185)).toBe('3:05');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(null)).toBe('ao vivo');
  });
});

describe('GuildPlayer', () => {
  /*
   * A press on the widget (the card at the foot of the members column) calls
   * these with NO channel. The bug this guards against: passing the press's
   * own `channelId` — which is a VOICE room — made the bot try to answer in a
   * room nobody can be told anything in, and overwrote the text channel its
   * next announcement was due in.
   */
  /*
   * Pause and resume (owner, 28/09). The point of these is that the track is
   * HELD and not restarted: `playCalls` stays at one across a pause, which is
   * the difference between pausing and "stop and play again".
   */
  it('pause holds the track and resume carries on, without playing it again', async () => {
    const { player, connection, said } = make();
    await player.play('numb', ana, 'text-1');
    // The loop opens the connection a turn later, like every other test here.
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    said.length = 0;

    await player.pause();
    expect(connection.paused).toBe(true);
    expect(has(said, 'Pausei')).toBe(true);

    await player.resume();
    expect(connection.paused).toBe(false);
    expect(has(said, 'Voltei')).toBe(true);
    // The file was never opened a second time.
    expect(connection.playCalls).toBe(1);
  });

  it('says so when there is nothing to pause, or nothing paused to resume', async () => {
    const { player, said } = make();

    await player.pause('text-1');
    expect(has(said, 'Não há nada tocando.')).toBe(true);

    said.length = 0;
    await player.resume('text-1');
    expect(has(said, 'Não há nada pausado.')).toBe(true);
  });

  it('a paused player publishes a card that is not playing, so the app draws play', async () => {
    const published: { paused: boolean; current: unknown }[] = [];
    const { player, connection } = make({ publishWidget: (snapshot) => published.push({ paused: snapshot.paused, current: snapshot.current }) });
    await player.play('numb', ana, 'text-1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.pause();

    const last = published.at(-1);
    expect(last?.paused).toBe(true);
    // Still a track: the card says what is held, it does not go blank.
    expect(last?.current).not.toBeNull();
  });

  it('a press with no channel answers where the last command came from', async () => {
    const { player, said, deps } = make();
    await player.play('numb', ana, 'text-1');
    said.length = 0;

    await player.skip();

    expect(has(said, 'Pulei')).toBe(true);
    // In the text channel the /play came from, and nowhere else.
    expect(vi.mocked(deps.say).mock.calls.every((call) => call[0] === 'text-1')).toBe(true);
  });

  it('a press with no channel and no command before it says nothing at all', async () => {
    const { player, said } = make();

    await player.skip();
    await player.stop();

    // There is no text channel to answer in, and the person pressing is
    // already looking at the card: silence is the honest answer.
    expect(said).toEqual([]);
  });

  it('a press does not steal the announcement channel from the next /play', async () => {
    const { player, deps } = make();
    await player.play('numb', ana, 'text-1');
    await player.skip();
    vi.mocked(deps.say).mockClear();

    await player.play('outra', ana, 'text-2');

    expect(vi.mocked(deps.say).mock.calls.every((call) => call[0] === 'text-2')).toBe(true);
  });

  it('joins, announces, plays, and leaves when the queue empties', async () => {
    const { player, connection, said, deps } = make();
    await player.play('song a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    expect(deps.join).toHaveBeenCalledWith('vc1');
    expect(has(said, 'Tocando agora')).toBe(true);
    expect(has(said, 'song a')).toBe(true);

    connection.endCurrent();
    await vi.waitFor(() => expect(connection.left).toBe(true));
    expect(has(said, 'A fila acabou')).toBe(true);
  });

  it('refuses to play when the asker is in no voice channel the bot can see, and says which it is', async () => {
    const { player, said, deps } = make({ voiceChannelId: null });
    await player.play('x', ana, 'tc1');
    expect(has(said, 'Não te encontrei em nenhuma sala de voz que eu consiga ver. Entre numa sala (ou peça para liberarem a sala ao bot) e tente de novo.')).toBe(true);
    expect(deps.join).not.toHaveBeenCalled();
  });

  /**
   * The owner's rule (18/09): a `/play` is accepted from ANY text channel and
   * plays in the ASKER's room; while the bot plays in another room of the
   * guild it says so and stays put — it never hops rooms or resolves the track.
   */
  it('while playing in another room it answers "ocupado em #sala" and stays; same room queues', async () => {
    const { player, connection, said, deps } = make({ roomNames: { vc1: 'PUBG1' } });
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    expect(player.currentVoiceChannelId).toBe('vc1');

    // Somebody in ANOTHER room (vc2) asks from another text channel.
    (deps.voiceChannelOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce('vc2');
    await player.play('b', { id: 'u2', username: 'bia' }, 'tc9');
    expect(said.at(-1)).toBe('Estou ocupado tocando em #PUBG1.');
    expect(deps.join).toHaveBeenCalledTimes(1);
    expect(deps.resolver.resolve).toHaveBeenCalledTimes(1); // nobody waited on yt-dlp to be told no

    // Somebody in the SAME room queues.
    await player.play('c', { id: 'u3', username: 'caio' }, 'tc9');
    expect(has(said, 'Na fila (posição 1)')).toBe(true);
  });

  it('names no room it does not know: "ocupado tocando em outra sala"', async () => {
    const { player, connection, said, deps } = make();
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    (deps.voiceChannelOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce('vc2');
    await player.play('b', ana, 'tc1');
    expect(said.at(-1)).toBe('Estou ocupado tocando em outra sala.');
  });

  it('the asker\'s room is read AFTER the command, so a fresh read from the server counts', async () => {
    const { player, connection, deps } = make({ voiceChannelId: null });
    // The cache said "none"; index.ts re-reads the server and the second answer is a room.
    (deps.voiceChannelOf as ReturnType<typeof vi.fn>).mockResolvedValueOnce('vc7');
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    expect(deps.join).toHaveBeenCalledWith('vc7');
  });

  it('play with an empty query asks what to play and does not join', async () => {
    const { player, said, deps } = make();
    await player.play('   ', ana, 'tc1');
    expect(has(said, 'Diga o que tocar')).toBe(true);
    expect(deps.join).not.toHaveBeenCalled();
  });

  it('queues while playing and skip advances to the next', async () => {
    const { player, connection, said } = make();
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.play('b', ana, 'tc1');
    expect(has(said, 'Na fila (posição 1)')).toBe(true);

    await player.skip('tc1');
    expect(has(said, 'Pulei')).toBe(true);
    await vi.waitFor(() => expect(connection.playCalls).toBe(2));
    expect(said.filter((text) => text.includes('Tocando agora')).length).toBe(2);
  });

  it('a skip does not leak to the next track', async () => {
    const { player, connection } = make();
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.skip('tc1'); // a is the only track → leaves after
    await vi.waitFor(() => expect(connection.left).toBe(true));
    await player.play('b', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(2)); // b plays, not skipped
  });

  it('skips a track whose play fails and continues to the next', async () => {
    const { player, connection, said } = make();
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.play('b', ana, 'tc1');
    connection.endCurrent(new Error('o áudio não é Ogg'));
    await vi.waitFor(() => expect(connection.playCalls).toBe(2));
    expect(has(said, 'Pulei') && has(said, 'o áudio não é Ogg')).toBe(true);
  });

  it('reports a join failure and clears the queue', async () => {
    const { player, said } = make({ joinError: new Error('sem sala') });
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(has(said, 'Não consegui entrar na sala')).toBe(true));
    expect(has(said, 'sem sala')).toBe(true);
    expect(player.isRunning).toBe(false);
  });

  it('stop clears the queue and leaves', async () => {
    const { player, connection, said } = make();
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.stop('tc1');
    expect(has(said, 'Parei e saí da sala.')).toBe(true);
    await vi.waitFor(() => expect(connection.left).toBe(true));
    expect(has(said, 'A fila acabou')).toBe(false);
  });

  it('says nothing plays for skip/queue/np when idle', async () => {
    const { player, said } = make();
    await player.skip('tc1');
    await player.showQueue('tc1');
    await player.nowPlaying('tc1');
    await player.stop('tc1');
    expect(has(said, 'Não há nada tocando.')).toBe(true);
    expect(has(said, 'A fila está vazia.')).toBe(true);
    expect(has(said, 'Nada tocando.')).toBe(true);
    expect(has(said, 'Não estou tocando nada.')).toBe(true);
  });

  it('lists the current track and the queue with requesters', async () => {
    const { player, connection, said } = make({ maxQueue: 10 });
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.play('b', ana, 'tc1');
    await player.play('c', ana, 'tc1');
    said.length = 0;
    await player.showQueue('tc1');
    const text = said.join('\n');
    expect(text).toContain('Tocando agora');
    expect(text).toContain('1.');
    expect(text).toContain('ana');

    said.length = 0;
    await player.nowPlaying('tc1');
    expect(has(said, 'Tocando agora') && has(said, 'ana')).toBe(true);
  });

  it('reports a resolve failure and does not join', async () => {
    const { player, said, deps } = make({
      resolve: async () => {
        throw new Error('não encontrei nada para "zzz".');
      },
    });
    await player.play('zzz', ana, 'tc1');
    expect(has(said, 'Não consegui:')).toBe(true);
    expect(has(said, 'não encontrei nada')).toBe(true);
    expect(deps.join).not.toHaveBeenCalled();
  });

  it('enforces the max queue', async () => {
    const { player, connection, said } = make({ maxQueue: 2 });
    await player.play('a', ana, 'tc1');
    await vi.waitFor(() => expect(connection.playCalls).toBe(1));
    await player.play('b', ana, 'tc1'); // current a + queued b = 2, at the limit
    await player.play('c', ana, 'tc1'); // over the limit
    expect(has(said, 'A fila está cheia')).toBe(true);
  });
});
