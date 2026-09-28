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
  static respondToPings = true;
  static delayClose = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  readonly listenTopics: string[] = [];
  readonly listenAuthTokens: Array<string | undefined> = [];
  readonly pendingReplies: Array<() => void> = [];

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
      const respond = () => {
        const response: PubSubMessage = {
          type: 'RESPONSE',
          nonce: message.nonce,
          error: FakeWebSocket.failNextListen || FakeWebSocket.rejectListens ? 'listen_failed' : ''
        };
        FakeWebSocket.failNextListen = false;
        this.onmessage?.({ data: JSON.stringify(response) } as MessageEvent<string>);
      };
      if (FakeWebSocket.holdListens) this.pendingReplies.push(respond);
      else queueMicrotask(respond);
      return;
    }

    if (message.type === 'PING' && FakeWebSocket.respondToPings) {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'PONG' }) } as MessageEvent<string>);
      });
    }
  }

  close() {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    if (!FakeWebSocket.delayClose) this.finishClose();
  }

  finishClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.failNextListen = false;
    FakeWebSocket.rejectListens = false;
    FakeWebSocket.holdListens = false;
    FakeWebSocket.respondToPings = true;
    FakeWebSocket.delayClose = false;
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

  test('replays 350 streamers independently per socket without timer gaps or fallback overlap', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    try {
      await pubsub.connect();
      pubsub.setAuthToken('old-token');
      await pubsub.listen('community-points-user-v1.scale', true);
      for (let i = 0; i < 350; i++) await pubsub.listen(`video-playback-by-id.${i}`);
      const originals = [...FakeWebSocket.instances];
      FakeWebSocket.holdListens = true;
      pubsub.setAuthToken('new-token');
      for (const ws of originals) ws.close();
      await advanceTime(1);
      const replacements = FakeWebSocket.instances.slice(originals.length);
      expect(replacements).toHaveLength(originals.length);
      expect(replacements.map((ws) => ws.listenTopics.length)).toEqual(originals.map(() => 1));
      await advanceTime(1_000);
      expect(replacements.map((ws) => ws.listenTopics.length)).toEqual(originals.map(() => 1));
      const replayTime = Date.now();
      for (let i = 0; i < 45; i++) {
        for (const ws of replacements.slice(1)) ws.pendingReplies.shift()?.();
        await setImmediate();
      }
      expect(replacements[0].listenTopics).toEqual([originals[0].listenTopics[0]]);
      for (let i = 1; i < replacements.length; i++) {
        expect(replacements[i].listenTopics).toEqual(originals[i].listenTopics);
      }
      for (let i = 0; i < 45; i++) {
        replacements[0].pendingReplies.shift()?.();
        await setImmediate();
      }
      expect(replacements[0].listenTopics).toEqual(originals[0].listenTopics);
      expect(replacements[0].listenAuthTokens[0]).toBe('new-token');
      expect(Date.now()).toBe(replayTime);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('continues replay after a rejection and leaves only the failed topic to backoff', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const topics = ['video-playback-by-id.first', 'video-playback-by-id.second'];
    try {
      await pubsub.connect();
      for (const topic of topics) await pubsub.listen(topic);
      FakeWebSocket.failNextListen = true;
      FakeWebSocket.instances[0].close();
      await advanceTime(1);
      const replacement = FakeWebSocket.instances[1];
      expect(replacement.listenTopics).toEqual(topics);
      await advanceTime(29_000);
      expect(replacement.listenTopics).toEqual(topics);
      await advanceTime(2_000);
      expect(replacement.listenTopics).toEqual([...topics, topics[0]]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('resets accumulated retry deadlines and failures when the assigned socket reconnects', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const topic = 'video-playback-by-id.backoff';
    try {
      await pubsub.connect();
      await pubsub.listen(topic);
      FakeWebSocket.rejectListens = true;
      FakeWebSocket.instances[0].close();
      await advanceTime(1);
      await advanceTime(31_000);
      await advanceTime(61_000);
      expect(FakeWebSocket.instances[1].listenTopics).toEqual([topic, topic, topic]);
      FakeWebSocket.instances[1].close();
      await advanceTime(1);
      const replacement = FakeWebSocket.instances[2];
      expect(replacement.listenTopics).toEqual([topic]);
      await advanceTime(29_000);
      expect(replacement.listenTopics).toEqual([topic]);
      FakeWebSocket.rejectListens = false;
      await advanceTime(2_000);
      expect(replacement.listenTopics).toEqual([topic, topic]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test('restarts interrupted replay without duplicate requests or reviving it after shutdown', async () => {
    vi.useFakeTimers();
    const pubsub = createPubSub();
    const topics = ['video-playback-by-id.first', 'video-playback-by-id.second'];
    try {
      await pubsub.connect();
      for (const topic of topics) await pubsub.listen(topic);
      FakeWebSocket.holdListens = true;
      FakeWebSocket.instances[0].close();
      await advanceTime(1);
      const interrupted = FakeWebSocket.instances[1];
      expect(interrupted.listenTopics).toEqual([topics[0]]);
      interrupted.close();
      FakeWebSocket.holdListens = false;
      await advanceTime(1);
      interrupted.pendingReplies.shift()?.();
      await setImmediate();
      expect(interrupted.listenTopics).toEqual([topics[0]]);
      expect(FakeWebSocket.instances[2].listenTopics).toEqual(topics);
      FakeWebSocket.holdListens = true;
      FakeWebSocket.instances[2].close();
      await advanceTime(1);
      const stopped = FakeWebSocket.instances[3];
      expect(stopped.listenTopics).toEqual([topics[0]]);
      pubsub.disconnect();
      stopped.pendingReplies.shift()?.();
      await advanceTime(300_000);
      expect(stopped.listenTopics).toEqual([topics[0]]);
      expect(FakeWebSocket.instances).toHaveLength(4);
      expect(pubsub.getTopics()).toEqual([]);
    } finally {
      pubsub.disconnect();
      vi.useRealTimers();
    }
  });

  test.each(['server', 'heartbeat'])(
    'reports %s reconnects before close completes without duplicate disconnects',
    async (reason) => {
      vi.useFakeTimers();
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      const pubsub = new TwitchPubSubPool({
        reconnectDelayRangeMs: [10_000, 10_000],
        socketFactory: (url) => new FakeWebSocket(url)
      });
      const states: boolean[] = [];
      pubsub.onConnected(() => states.push(pubsub.isConnectedToPubSub()));
      pubsub.onDisconnected(() => states.push(pubsub.isConnectedToPubSub()));
      try {
        await pubsub.connect();
        await pubsub.listen('video-playback-by-id.status');
        const original = FakeWebSocket.instances[0];
        FakeWebSocket.delayClose = true;
        if (reason === 'server') {
          original.onmessage?.({ data: JSON.stringify({ type: 'RECONNECT' }) } as MessageEvent<string>);
        } else {
          FakeWebSocket.respondToPings = false;
          await advanceTime(325_000);
        }
        expect(pubsub.isConnectedToPubSub()).toBe(false);
        expect(states).toEqual([true, false]);
        await advanceTime(10_000);
        expect(pubsub.isConnectedToPubSub()).toBe(true);
        expect(states).toEqual([true, false, true]);
        original.finishClose();
        expect(pubsub.isConnectedToPubSub()).toBe(true);
        expect(states).toEqual([true, false, true]);
        expect(FakeWebSocket.instances[1].listenTopics).toEqual(['video-playback-by-id.status']);
        pubsub.disconnect();
        FakeWebSocket.instances[1].finishClose();
        expect(states).toEqual([true, false, true, false]);
      } finally {
        pubsub.disconnect();
        random.mockRestore();
        vi.useRealTimers();
      }
    }
  );
});
