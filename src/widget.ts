/**
 * The card at the foot of the members column, and what a press on it does.
 *
 * It lives in its own file for one reason: on 29/09 the card offered
 * `pause`/`resume` and the handler in `index.ts` only knew `skip` and `stop`,
 * so the two buttons were drawn and did nothing. Nothing could catch that,
 * because the handler was an anonymous callback inside the process's entry
 * point. Here both halves are plain functions over one list, and a test walks
 * that list — an action the card offers and nobody handles is now a failing
 * test instead of a dead button.
 */
import { WIDGET_MAX_QUEUE, type PlayerWidget, type WidgetTrack } from '@gamerfy/bot';
import { formatDuration, type PlayerSnapshot } from './player.js';
import type { Track } from './resolver.js';

/**
 * What this bot's card offers, and the ONE list that decides it: `cardOf`
 * publishes it and `applyAction` answers it. Adding a button here without
 * teaching `applyAction` about it fails the test.
 */
export const OFFERED_ACTIONS = ['pause', 'resume', 'skip', 'stop'] as const;
export type OfferedAction = (typeof OFFERED_ACTIONS)[number];

/** Just enough of `GuildPlayer` for a press — the whole class is not needed to answer a button. */
export interface PressablePlayer {
  pause(channelId?: string): Promise<void>;
  resume(channelId?: string): Promise<void>;
  skip(channelId?: string): Promise<void>;
  stop(channelId?: string): Promise<void>;
}

const trackOf = (track: Track): WidgetTrack => ({
  title: track.title,
  subtitle: track.durationSec === null ? null : formatDuration(track.durationSec),
  requestedBy: track.requestedBy,
});

/**
 * The card for a snapshot, or `null` when there is no card to draw — nothing
 * playing and nothing queued means the bot has left, and the card goes with it.
 */
export function cardOf(snapshot: PlayerSnapshot): PlayerWidget | null {
  if (snapshot.current === null && snapshot.queue.length === 0) return null;
  return {
    kind: 'player',
    track: snapshot.current === null ? null : trackOf(snapshot.current),
    // What the card draws the button from: paused shows play, playing shows pause.
    playing: snapshot.current !== null && !snapshot.paused,
    progress: null,
    queue: snapshot.queue.slice(0, WIDGET_MAX_QUEUE).map(trackOf),
    queueTotal: snapshot.queue.length,
    actions: [...OFFERED_ACTIONS],
    voiceChannelId: snapshot.voiceChannelId,
  };
}

/**
 * A press. The gateway has already checked that the person was in the voice
 * room the card named, so this is the same command they could have typed.
 *
 * No channel is passed on: `event.channelId` is the VOICE room, not a place to
 * answer in, and handing it to the player would overwrite where the bot talks.
 *
 * Returns false for an action this bot does not offer, which is what makes the
 * list above the only place a button is decided.
 */
export function applyAction(player: PressablePlayer, action: string): boolean {
  switch (action) {
    case 'pause':
      void player.pause();
      return true;
    case 'resume':
      void player.resume();
      return true;
    case 'skip':
      void player.skip();
      return true;
    case 'stop':
      void player.stop();
      return true;
    default:
      return false;
  }
}
