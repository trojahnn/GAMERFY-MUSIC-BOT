/**
 * The card and the press (widget.ts).
 *
 * The first test is the one that matters, and it is written the way it is
 * because of what happened on 29/09: the card offered `pause` and `resume`
 * and nothing in the process answered them, so both buttons were drawn on
 * everybody's screen and did nothing. It walks the list the card publishes and
 * demands that each one reach the player. A button added without a hand behind
 * it fails here instead of in front of the owner.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlayerSnapshot } from '../player.js';
import { applyAction, cardOf, OFFERED_ACTIONS, type PressablePlayer } from '../widget.js';

function player(): PressablePlayer & { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  return { calls, pause: note('pause'), resume: note('resume'), skip: note('skip'), stop: note('stop') };
}

const track = (title: string) => ({ title, url: `https://exemplo.com/${title}`, durationSec: 215, requestedBy: 'ana' });

function snapshot(over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return { current: track('Uma música'), queue: [], paused: false, voiceChannelId: '500', elapsedMs: 90_000, durationMs: 215_000, ...over } as PlayerSnapshot;
}

describe('every button the card offers', () => {
  it('reaches the player — no action is drawn without a hand behind it', () => {
    const card = cardOf(snapshot());
    expect(card?.actions).toEqual([...OFFERED_ACTIONS]);

    for (const action of card?.actions ?? []) {
      const p = player();
      expect(applyAction(p, action), `a ação "${action}" está no cartão e ninguém a trata`).toBe(true);
      expect(p.calls, `a ação "${action}" não chegou ao player`).toEqual([action]);
    }
  });

  it('answers false for an action this bot does not offer, instead of pretending', () => {
    const p = player();
    expect(applyAction(p, 'previous')).toBe(false);
    expect(p.calls).toEqual([]);
  });
});

describe('the card', () => {
  it('draws pause while playing and play while paused — the same button, both ways', () => {
    expect(cardOf(snapshot({ paused: false }))?.playing).toBe(true);
    expect(cardOf(snapshot({ paused: true }))?.playing).toBe(false);
  });

  it('is taken down when there is nothing playing and nothing queued', () => {
    expect(cardOf(snapshot({ current: null, queue: [] }))).toBeNull();
    // Still something queued: the bot has not left, so the card stays.
    expect(cardOf(snapshot({ current: null, queue: [track('Próxima')] }))).not.toBeNull();
  });

  it('carries the room it belongs to, which is what decides who may press', () => {
    expect(cardOf(snapshot({ voiceChannelId: '500' }))?.voiceChannelId).toBe('500');
  });

  it('shows at most three queued tracks but counts them all', () => {
    const card = cardOf(snapshot({ queue: [track('a'), track('b'), track('c'), track('d'), track('e')] }));
    expect(card?.queue).toHaveLength(3);
    expect(card?.queueTotal).toBe(5);
  });

  it('writes the length of a track as minutes, and leaves it out when unknown', () => {
    expect(cardOf(snapshot())?.track?.subtitle).toBe('3:35');
    const unknown = cardOf(snapshot({ current: { ...track('Ao vivo'), durationSec: null } as never }));
    expect(unknown?.track?.subtitle).toBeNull();
  });
});

describe('a press', () => {
  it('never passes a channel on: the press names a voice room, not a place to talk', () => {
    const pause = vi.fn(() => Promise.resolve());
    applyAction({ pause, resume: pause, skip: pause, stop: pause }, 'pause');
    expect(pause).toHaveBeenCalledWith();
  });
});

describe('the counter on the card', () => {
  it('carries the position and the length, so the app can run the clock itself', () => {
    // Published once per change, never once a second: the app counts from here
    // for as long as `playing` holds. A bot ticking this every second would be
    // polling with extra steps.
    const card = cardOf(snapshot({ elapsedMs: 90_000, durationMs: 215_000 }));
    expect(card?.elapsedMs).toBe(90_000);
    expect(card?.durationMs).toBe(215_000);
    expect(card?.progress).toBeCloseTo(90 / 215, 5);
  });

  it('says nothing about a track with no known length, instead of a ring stuck at zero', () => {
    const card = cardOf(snapshot({ elapsedMs: 30_000, durationMs: null }));
    expect(card?.progress).toBeNull();
    // The elapsed time is still true, and a live stream is exactly where a
    // counter with no total is the only honest thing to show.
    expect(card?.elapsedMs).toBe(30_000);
  });

  it('never reports more than the whole track, however long the source ran over', () => {
    const card = cardOf(snapshot({ elapsedMs: 230_000, durationMs: 215_000 }));
    expect(card?.progress).toBe(1);
  });

  it('does not divide by a length of zero', () => {
    expect(cardOf(snapshot({ elapsedMs: 1_000, durationMs: 0 }))?.progress).toBeNull();
  });
});
