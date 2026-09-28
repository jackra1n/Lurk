import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import type { PubSubMessage } from '../constants';
import { TwitchPubSubPool } from './index';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  static failNextListen = false;

  static rejectListens = false;
  static holdListens = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  readonly listenTopics: string[] = [];
  readonly listenAuthTokens: Array<string | undefined> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({} as Event);
    });
  }

  send(data: string) {
    const message = JSON.parse(data) as {
      type: string;
      nonce?: string;
      data?: { topics?: string[]; auth_token?: string };
    };

    if (message.type === 'LISTEN' && message.nonce && message.data?.topics?.[0]) {
      this.listenTopics.push(message.data.topics[0]);
      this.listenAuthTokens.push(message.data.auth_token);
      if (FakeWebSocket.holdListens) return;
      queueMicrotask(() => {
        const response: PubSubMessage = {
          type: 'RESPONSE',
          nonce: message.nonce,
          error: FakeWebSocket.failNextListen || FakeWebSocket.rejectListens ? 'listen_failed' : ''
        };
        FakeWebSocket.failNextListen = false;
        this.onmessage?.({ data: JSON.stringify(response) } as MessageEvent<string>);
      });
      return;
    }

    if (message.type === 'PING') {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'PONG' }) } as MessageEvent<string>);
      });
    }
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.failNextListen = false;
    FakeWebSocket.rejectListens = false;
    FakeWebSocket.holdListens = false;
  }
}

const createPubSub = (maxTopicsPerSocket = 45) =>
  new TwitchPubSubPool({
    maxTopicsPerSocket,
    reconnectDelayRangeMs: [0, 0],
    socketFactory: (url) => new FakeWebSocket(url)
  });

async function advanceTime(ms: number) {
  while (ms > 0) {
    const step = Math.min(ms, 1_000);
    vi.advanceTimersByTime(step);
    await setImmediate();
    ms -= step;
  }
}

describe('TwitchPubSub pool', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });

  afterEach(() => {
    FakeWebSocket.reset();
  });

  test('scales to additional sockets once socket topic capacity is reached', async () => {
    const pubsub = createPubSub(2);

    await pubsub.connect();
    await pubsub.listen('video-playback-by-id.1');
    await pubsub.listen('video-playback-by-id.2');
    await pubsub.listen('video-playback-by-id.3');

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(pubsub.getTopics().sort()).toEqual([
      'video-playback-by-id.1',
      'video-playback-by-id.2',
      'video-playback-by-id.3'
    ]);

    pubsub.disconnect();
  });

  test('does not duplicate LISTEN when the same topic is requested twice', async () => {
    const pubsub = createPubSub();

    await pubsub.connect();
    await pubsub.listen('community-points-user-v1.123', true);
    await pubsub.listen('community-points-user-v1.123', true);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].listenTopics).toEqual(['community-points-user-v1.123']);

    pubsub.disconnect();
  });

  test('passes auth token for authenticated LISTEN topics', async () => {
    const pubsub = createPubSub();

    pubsub.setAuthToken('token-abc');
    await pubsub.connect();
    await pubsub.listen('community-points-user-v1.456', true);

    expect(FakeWebSocket.instances[0].listenAuthTokens).toEqual(['token-abc']);

    pubsub.disconnect();
  });

  test('falls back to a new socket if the first socket rejects LISTEN', async () => {
    const pubsub = createPubSub();

    await pubsub.connect();
    FakeWebSocket.failNextListen = true;

    await pubsub.listen('video-playback-by-id.789');

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(pubsub.getTopics()).toEqual(['video-playback-by-id.789']);

    pubsub.disconnect();
  });

  test.each([
    ['video-playback-by-id.retry', false],
    ['community-points-user-v1.retry', true]
  ] as const)('recovers an initially rejected subscription without reconnecting: %s', async (topic, requiresAuth) => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    try {
      pubsub.setAuthToken('old-token');
      await pubsub.connect();
      FakeWebSocket.rejectListens = true;
      await expect(pubsub.listen(topic, requiresAuth)).rejects.toThrow('Failed to subscribe topic after fallback');
      expect(pubsub.getTopics()).toEqual([]);
      expect(FakeWebSocket.instances.flatMap((ws) => ws.listenTopics)).toEqual([topic, topic]);
      pubsub.setAuthToken('new-token');
      FakeWebSocket.rejectListens = false;
      await advanceTime(29_000);
      expect(pubsub.getTopics()).toEqual([]);
      await advanceTime(1_000);
      expect(pubsub.getTopics()).toEqual([topic]);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(FakeWebSocket.instances[0].listenAuthTokens.at(-1)).toBe(requiresAuth ? 'new-token' : undefined);
      await advanceTime(60_000);
      expect(FakeWebSocket.instances.flatMap((ws) => ws.listenTopics)).toEqual([topic, topic, topic]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('retries a rejected reconnect subscription while the replacement socket remains open', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const topic = 'video-playback-by-id.reconnect';
    try {
      await pubsub.connect();
      await pubsub.listen(topic);
      FakeWebSocket.rejectListens = true;
      FakeWebSocket.instances[0].close();
      await advanceTime(1_000);
      await advanceTime(1_000);
      expect(FakeWebSocket.instances[1].listenTopics).toEqual([topic]);
      FakeWebSocket.rejectListens = false;
      await advanceTime(30_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(FakeWebSocket.instances[1].listenTopics).toEqual([topic, topic]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('caps retry backoff without growing sockets or letting callers bypass the deadline', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const topic = 'video-playback-by-id.outage';
    try {
      await pubsub.connect();
      FakeWebSocket.rejectListens = true;
      await expect(pubsub.listen(topic)).rejects.toThrow('Failed to subscribe');
      let attempts = 2;
      for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
        await expect(pubsub.listen(topic)).rejects.toThrow('Failed to subscribe');
        await advanceTime(delay - 1);
        expect(FakeWebSocket.instances.flatMap((ws) => ws.listenTopics)).toHaveLength(attempts);
        await advanceTime(1);
        attempts += 2;
        expect(FakeWebSocket.instances.flatMap((ws) => ws.listenTopics)).toHaveLength(attempts);
        expect(FakeWebSocket.instances).toHaveLength(2);
      }
      FakeWebSocket.rejectListens = false;
      await advanceTime(300_000);
      expect(pubsub.getTopics()).toEqual([topic]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('deduplicates pending listens and abandons them on disconnect without reviving old topics', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const oldTopic = 'video-playback-by-id.old';
    try {
      await pubsub.connect();
      FakeWebSocket.holdListens = true;
      const first = pubsub.listen(oldTopic);
      const second = pubsub.listen(oldTopic);
      const outcomes = Promise.allSettled([first, second]);
      await setImmediate();
      expect(FakeWebSocket.instances[0].listenTopics).toEqual([oldTopic]);
      pubsub.disconnect();
      expect((await outcomes).map((result) => result.status)).toEqual(['rejected', 'rejected']);
      await advanceTime(300_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(pubsub.getTopics()).toEqual([]);

      FakeWebSocket.holdListens = false;
      await pubsub.connect();
      await pubsub.listen('community-points-user-v1.new', true);
      await advanceTime(300_000);
      expect(FakeWebSocket.instances[1].listenTopics).toEqual(['community-points-user-v1.new']);
      expect(pubsub.getTopics()).toEqual(['community-points-user-v1.new']);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });
});
