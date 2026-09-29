import { describe, expect, test } from 'bun:test';
import { clipRange, collectWatchSessions, type WatchSessionEvent } from './sessions';

let nextId = 1;
const event = (
  streamerId: number,
  eventType: string,
  occurredAtMs: number,
  points?: { delta: number; reason: string }
): WatchSessionEvent => ({
  id: nextId++,
  streamerId,
  eventType,
  occurredAtMs,
  reasonCode: points?.reason ?? null,
  pointsDelta: points?.delta ?? null
});

describe('collectWatchSessions', () => {
  test('pairs starts and stops per streamer and sums points earned while watching', () => {
    const sessions = collectWatchSessions(
      [
        event(1, 'points_earned', 50, { delta: 10, reason: 'WATCH' }),
        event(1, 'watch_started', 100),
        event(2, 'watch_started', 110),
        event(1, 'points_earned', 200, { delta: 10, reason: 'WATCH' }),
        event(1, 'points_earned', 210, { delta: 450, reason: 'WATCH_STREAK' }),
        event(2, 'points_earned', 250, { delta: 50, reason: 'CLAIM' }),
        event(1, 'watch_stopped', 300),
        event(2, 'watch_stopped', 400)
      ],
      1_000,
      new Set()
    );

    expect(
      sessions.map(({ streamerId, fromMs, toMs, points, streak, ongoing }) => ({
        streamerId,
        fromMs,
        toMs,
        points,
        streak,
        ongoing
      }))
    ).toEqual([
      { streamerId: 1, fromMs: 100, toMs: 300, points: 460, streak: true, ongoing: false },
      { streamerId: 2, fromMs: 110, toMs: 400, points: 50, streak: false, ongoing: false }
    ]);
  });

  test('ends sessions cut off by a crash at their last event', () => {
    const sessions = collectWatchSessions(
      [
        event(1, 'watch_started', 100),
        event(1, 'points_earned', 180, { delta: 10, reason: 'WATCH' }),
        event(1, 'watch_started', 5_000),
        event(1, 'points_earned', 5_100, { delta: 10, reason: 'WATCH' })
      ],
      9_000,
      new Set()
    );

    expect(sessions.map(({ fromMs, toMs, ongoing }) => [fromMs, toMs, ongoing])).toEqual([
      [100, 180, false],
      [5_000, 5_100, false]
    ]);
  });

  test('extends the open session of a currently watched streamer to now', () => {
    const [session] = collectWatchSessions([event(1, 'watch_started', 100)], 9_000, new Set([1]));
    expect(session).toMatchObject({ fromMs: 100, toMs: 9_000, ongoing: true });
  });
});

describe('clipRange', () => {
  test('clips to the window and drops ranges outside of it', () => {
    expect(clipRange({ fromMs: 0, toMs: 100 }, 50, 200)).toEqual({ fromMs: 50, toMs: 100 });
    expect(clipRange({ fromMs: 0, toMs: 50 }, 50, 200)).toBeNull();
  });
});
