import { describe, expect, test, vi } from 'bun:test';
import { checkStreamerOnline, selectDueStreamers, syncStreamers } from './streamers';
import { createDefaultStreamData, createDefaultStreamMetadataState, type StreamerState } from './types';
import { handlePubSubMessage, type EventHandlerDeps } from './events';
import { CHANNEL_POINTS_STATUS, DEFAULT_CHANNEL_POINTS_STATUS } from './channel-points-status';
import { encodeMinuteWatchedPayload, twitchClient, TwitchClient, type StreamInfoStatus } from '../twitch-client';
import { getStreamers } from '../config';
import { MinerService } from './service';
import { eventStore } from '../db/events';
import { twitchPubSubPool } from '../pubsub';

const MINUTE = 59_000;

interface WatchLoopInternals {
  running: boolean;
  userId: string | null;
  streamerStates: Map<string, StreamerState>;
  watchedStreamerNames: Set<string>;
  WATCH_LOOP_INTERVAL: number;
  metadataCheck: Promise<void> | null;
  startWatchLoop(): void;
  invalidateWatchLoop(): void;
  startMetadataLoop(): void;
  invalidateMetadataLoop(): void;
  persistWatchTransitions(nextWatchedStates: StreamerState[]): void;
  sendMinuteWatchedForStreamers(): Promise<void>;
}

const streamer = (name: string, minuteWatchedTimestamp: number): StreamerState => ({
  name,
  channelId: `${name}-id`,
  isLive: true,
  channelPoints: 0,
  channelPointsStatus: DEFAULT_CHANNEL_POINTS_STATUS,
  channelPointsStatusCheckedAtMs: 0,
  startingPoints: null,
  offlineAt: 0,
  lastContextRefresh: 0,
  metadata: createDefaultStreamMetadataState(),
  activeMultipliers: [],
  history: {},
  stream: { ...createDefaultStreamData(), minuteWatchedTimestamp }
});

describe('selectDueStreamers', () => {
  test('selects only streamers past the minute-watched interval', () => {
    const now = 10 * MINUTE;
    const selected = [streamer('due', now - MINUTE), streamer('notdue', now - MINUTE + 1), streamer('never', 0)];
    expect(selectDueStreamers(selected, now, MINUTE).map((state) => state.name)).toEqual(['due', 'never']);
  });

  test('treats unset timestamp as immediately due', () => {
    const selected = [streamer('fresh', 0)];
    expect(selectDueStreamers(selected, MINUTE, MINUTE)).toHaveLength(1);
  });

  test('preserves selection order', () => {
    const now = MINUTE * 5;
    const selected = [streamer('bravo', now - MINUTE), streamer('alpha', now - MINUTE * 2)];
    expect(selectDueStreamers(selected, now, MINUTE).map((state) => state.name)).toEqual(['bravo', 'alpha']);
  });
});

describe('encodeMinuteWatchedPayload', () => {
  test('encodes a base64 minute-watched event with player properties', () => {
    const encoded = encodeMinuteWatchedPayload('ch1', 'bc1', 'user1', 'somechannel');
    const [event] = JSON.parse(atob(encoded));
    expect(event).toEqual({
      event: 'minute-watched',
      properties: {
        channel_id: 'ch1',
        broadcast_id: 'bc1',
        player: 'site',
        user_id: 'user1',
        live: true,
        channel: 'somechannel'
      }
    });
  });
});

describe('watch loop lifecycle', () => {
  test('does not reschedule an in-flight loop after restart', async () => {
    vi.useFakeTimers();
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const firstRun = Promise.withResolvers<void>();
    const secondRun = Promise.withResolvers<void>();
    let calls = 0;

    try {
      internals.WATCH_LOOP_INTERVAL = 1;
      internals.sendMinuteWatchedForStreamers = () => {
        calls++;
        if (calls === 1) return firstRun.promise;
        if (calls === 2) return secondRun.promise;
        return Promise.resolve();
      };

      internals.running = true;
      internals.startWatchLoop();
      vi.advanceTimersByTime(1);
      expect(calls).toBe(1);

      internals.invalidateWatchLoop();
      internals.running = false;
      internals.running = true;
      internals.startWatchLoop();
      vi.advanceTimersByTime(1);
      expect(calls).toBe(2);

      firstRun.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      expect(calls).toBe(2);
    } finally {
      internals.invalidateWatchLoop();
      internals.running = false;
      secondRun.resolve();
      vi.useRealTimers();
    }
  });

  test('keeps the next loop on the prior start deadline', async () => {
    vi.useFakeTimers();
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const firstRun = Promise.withResolvers<void>();
    const secondRun = Promise.withResolvers<void>();
    let calls = 0;

    try {
      internals.WATCH_LOOP_INTERVAL = 100;
      internals.sendMinuteWatchedForStreamers = () => {
        calls++;
        return calls === 1 ? firstRun.promise : secondRun.promise;
      };

      internals.running = true;
      internals.startWatchLoop();
      vi.advanceTimersByTime(100);
      expect(calls).toBe(1);

      vi.advanceTimersByTime(40);
      firstRun.resolve();
      await Promise.resolve();
      await Promise.resolve();

      vi.advanceTimersByTime(59);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(2);
    } finally {
      internals.invalidateWatchLoop();
      internals.running = false;
      secondRun.resolve();
      vi.useRealTimers();
    }
  });
});

describe('watched-state readiness', () => {
  test('uses an empty effective watched set while the Spade URL is unavailable', async () => {
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const state = streamer('alpha', 0);
    state.stream.broadcastId = 'broadcast-alpha';
    internals.userId = 'user';
    internals.streamerStates = new Map([[state.name, state]]);

    const originalGetSpadeUrl = twitchClient.getSpadeUrl;
    let persisted: StreamerState[] | undefined;
    twitchClient.getSpadeUrl = async () => null;
    internals.persistWatchTransitions = (next) => {
      persisted = next;
    };

    try {
      await internals.sendMinuteWatchedForStreamers();
      expect(persisted).toEqual([]);
    } finally {
      twitchClient.getSpadeUrl = originalGetSpadeUrl;
    }
  });

  test('reports only the active watched set to runtime consumers', () => {
    const configuredStreamers = getStreamers();
    const originalStreamers = [...configuredStreamers];
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const state = streamer('alpha', 0);
    state.stream.broadcastId = 'broadcast-alpha';

    try {
      configuredStreamers.splice(0, configuredStreamers.length, state.name);
      internals.running = true;
      internals.streamerStates = new Map([[state.name, state]]);
      internals.watchedStreamerNames = new Set();
      expect(service.getStreamerRuntimeStates()).toEqual([
        { login: state.name, isOnline: true, isWatched: false, multiplier: null }
      ]);

      internals.watchedStreamerNames = new Set([state.name]);
      state.activeMultipliers = [{ factor: 0.2 }];
      expect(service.getStreamerRuntimeStates()).toEqual([
        { login: state.name, isOnline: true, isWatched: true, multiplier: 1.2 }
      ]);
    } finally {
      configuredStreamers.splice(0, configuredStreamers.length, ...originalStreamers);
    }
  });
});

describe('watch-path GQL requests', () => {
  test('applies an abort deadline to playback-token requests', async () => {
    const originalFetch = globalThis.fetch;
    let gqlSignal: AbortSignal | undefined;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) === 'https://www.twitch.tv') {
          return new Response('<script>window.__twilightBuildID = "00000000-0000-0000-0000-000000000000"</script>');
        }
        gqlSignal = init?.signal ?? undefined;
        return Response.json({ data: { streamPlaybackAccessToken: null } });
      },
      { preconnect: originalFetch.preconnect }
    );

    try {
      const client = new TwitchClient();
      client.setAuthToken('test-token');
      await client.getPlaybackAccessToken('test');
      expect(gqlSignal).toBeDefined();
      expect(gqlSignal?.aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('stream metadata scheduling', () => {
  test('the scheduler discovers a live stream from viewcounts when stream-up was missed', async () => {
    vi.useFakeTimers();
    const state = streamer('missed-up', 0);
    state.isLive = false;
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    internals.running = true;
    internals.streamerStates = new Map([[state.name, state]]);
    const deps: EventHandlerDeps = {
      streamerStates: internals.streamerStates,
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({ kind: 'offline' });
    const recordSpy = vi.spyOn(eventStore, 'recordEvent').mockImplementation(() => {});
    try {
      internals.startMetadataLoop();
      await internals.metadataCheck;
      vi.advanceTimersByTime(30_000);
      statusSpy.mockResolvedValue({
        kind: 'live',
        info: { broadcastId: 'recovered', title: 'Live', game: null, viewersCount: 42 }
      });
      handlePubSubMessage(deps, 'video-playback-by-id.missed-up-id', 'viewcount', { viewers: 42 });
      vi.advanceTimersByTime(29_000);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.isLive).toBe(false);
      vi.advanceTimersByTime(1_000);
      await internals.metadataCheck;
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(state.isLive).toBe(true);
      expect(state.stream.broadcastId).toBe('recovered');
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      await internals.metadataCheck;
      statusSpy.mockRestore();
      recordSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('the scheduler honors outage backoff despite viewer-count events', async () => {
    vi.useFakeTimers();
    const state = streamer('backoff', 0);
    state.isLive = false;
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    internals.running = true;
    internals.streamerStates = new Map([[state.name, state]]);
    const deps: EventHandlerDeps = {
      streamerStates: internals.streamerStates,
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };
    const retryAtMs = Date.now() + 5 * 60_000;
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({
      kind: 'unknown',
      reason: 'gql_error',
      retryAtMs
    });
    const recordSpy = vi.spyOn(eventStore, 'recordEvent').mockImplementation(() => {});
    try {
      internals.startMetadataLoop();
      await internals.metadataCheck;
      statusSpy.mockResolvedValue({
        kind: 'live',
        info: { broadcastId: 'recovered', title: 'Live', game: null, viewersCount: 42 }
      });
      vi.advanceTimersByTime(60_000);
      handlePubSubMessage(deps, 'video-playback-by-id.backoff-id', 'viewcount', { viewers: 42 });
      vi.advanceTimersByTime(4 * 60_000 - 1);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.metadata.nextCheckAtMs).toBe(retryAtMs);
      vi.advanceTimersByTime(1);
      await internals.metadataCheck;
      expect(state.isLive).toBe(true);
      expect(state.stream.broadcastId).toBe('recovered');
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      await internals.metadataCheck;
      statusSpy.mockRestore();
      recordSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('ineligible streamers do not starve a due streamer later in the map', async () => {
    vi.useFakeTimers();
    const missingId = streamer('missing-id', 0);
    missingId.channelId = null;
    const notDue = streamer('not-due', 0);
    notDue.metadata.nextCheckAtMs = Date.now() + 60_000;
    const debounced = streamer('debounced', 0);
    debounced.offlineAt = Date.now();
    const due = streamer('due', 0);
    due.isLive = false;
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    internals.running = true;
    internals.streamerStates = new Map([missingId, notDue, debounced, due].map((state) => [state.name, state]));
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({ kind: 'offline' });
    try {
      internals.startMetadataLoop();
      await internals.metadataCheck;
      expect(statusSpy.mock.calls.map(([name]) => name)).toEqual(['due']);
      expect(due.metadata.status).toBe('fresh');
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      await internals.metadataCheck;
      statusSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('stream-up retains delayed fallback verification without undoing outage backoff', async () => {
    vi.useFakeTimers();
    const state = streamer('stream-up', 0);
    state.isLive = false;
    state.metadata.nextCheckAtMs = Date.now() + 15 * 60_000;
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    internals.running = true;
    internals.streamerStates = new Map([[state.name, state]]);
    const deps: EventHandlerDeps = {
      streamerStates: internals.streamerStates,
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };
    const retryAtMs = Date.now() + 10 * 60_000;
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({
      kind: 'unknown',
      reason: 'gql_error',
      retryAtMs
    });
    try {
      internals.startMetadataLoop();
      handlePubSubMessage(deps, 'video-playback-by-id.stream-up-id', 'stream-up', {});
      vi.advanceTimersByTime(2 * 60_000 - 1);
      expect(statusSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await internals.metadataCheck;
      expect(statusSpy).toHaveBeenCalledTimes(1);
      handlePubSubMessage(deps, 'video-playback-by-id.stream-up-id', 'stream-up', {});
      expect(state.metadata.nextCheckAtMs).toBe(retryAtMs);
      vi.advanceTimersByTime(2 * 60_000);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.isLive).toBe(false);
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      await internals.metadataCheck;
      statusSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('paces a large startup backlog without overlapping metadata requests', async () => {
    vi.useFakeTimers();
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const states = Array.from({ length: 350 }, (_, i) => ({
      ...streamer(`channel-${i}`, 0),
      isLive: false
    }));
    internals.running = true;
    internals.streamerStates = new Map(states.map((state) => [state.name, state]));
    const pending = Promise.withResolvers<StreamInfoStatus>();
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => pending.promise);
    try {
      internals.startMetadataLoop();
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);
      pending.resolve({ kind: 'offline' });
      await internals.metadataCheck;
      vi.advanceTimersByTime(999);
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await internals.metadataCheck;
      expect(statusSpy.mock.calls.map(([login]) => login)).toEqual(['channel-0', 'channel-1']);
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      pending.resolve({ kind: 'offline' });
      await checkStreamerOnline(states[0]);
      statusSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('keeps offline fallback quiet while bounding event-triggered rechecks and stream-down debounce', async () => {
    vi.useFakeTimers();
    const state = streamer('offline', 0);
    state.isLive = false;
    const deps: EventHandlerDeps = {
      streamerStates: new Map([[state.name, state]]),
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({ kind: 'offline' });
    const viewcount = () => handlePubSubMessage(deps, 'video-playback-by-id.offline-id', 'viewcount', { viewers: 1 });
    try {
      await checkStreamerOnline(state);
      vi.advanceTimersByTime(14 * 60_000);
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(30_000);
      viewcount();
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_000);
      viewcount();
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(30_000);
      handlePubSubMessage(deps, 'video-playback-by-id.offline-id', 'stream-down', {});
      vi.advanceTimersByTime(30_000);
      viewcount();
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(30_000);
      viewcount();
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(4);
    } finally {
      statusSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('recovers discovery after an outage instead of leaving the streamer without a channel ID', async () => {
    const configured = getStreamers();
    const original = [...configured];
    const states = new Map<string, StreamerState>();
    const lookup = vi.spyOn(twitchClient, 'getUserId').mockResolvedValue(null);
    const listen = vi.spyOn(twitchPubSubPool, 'listen').mockImplementation(() => {});
    const register = vi.spyOn(eventStore, 'registerStreamer').mockImplementation(() => {});
    try {
      configured.splice(0, configured.length, 'discovery-recovery');
      await syncStreamers(states);
      expect(states.get('discovery-recovery')?.channelId).toBeNull();
      lookup.mockResolvedValue('recovered-id');
      await syncStreamers(states);
      expect(states.get('discovery-recovery')?.channelId).toBe('recovered-id');
      expect(listen).toHaveBeenCalledWith('video-playback-by-id.recovered-id', false);
      await syncStreamers(states);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(listen).toHaveBeenCalledTimes(1);
    } finally {
      configured.splice(0, configured.length, ...original);
      lookup.mockRestore();
      listen.mockRestore();
      register.mockRestore();
    }
  });

  test('sends watch telemetry while metadata is stalled without overlapping refreshes', async () => {
    vi.useFakeTimers();
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const state = streamer('alpha', 0);
    state.stream.broadcastId = 'broadcast-alpha';
    state.stream.hlsPlaylistUrl = 'https://example.com/playlist';
    internals.running = true;
    internals.userId = 'user';
    internals.streamerStates = new Map([[state.name, state]]);
    internals.persistWatchTransitions = () => {};
    const metadata = Promise.withResolvers<StreamInfoStatus>();
    const sent = Promise.withResolvers<void>();
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => metadata.promise);
    const spadeSpy = vi.spyOn(twitchClient, 'getSpadeUrl').mockResolvedValue('https://example.com/spade');
    const segmentSpy = vi.spyOn(twitchClient, 'touchStreamSegment').mockResolvedValue(true);
    const sendSpy = vi.spyOn(twitchClient, 'sendMinuteWatchedEvent').mockImplementation(async () => {
      sent.resolve();
      return true;
    });

    try {
      internals.startMetadataLoop();
      await Promise.resolve();
      internals.startWatchLoop();
      vi.advanceTimersByTime(20_000);
      await sent.promise;
      expect(sendSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.isLive).toBe(true);
    } finally {
      internals.running = false;
      internals.invalidateWatchLoop();
      internals.invalidateMetadataLoop();
      metadata.resolve({ kind: 'unknown', reason: 'gql_error' });
      await checkStreamerOnline(state);
      statusSpy.mockRestore();
      spadeSpy.mockRestore();
      segmentSpy.mockRestore();
      sendSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('viewer-count events preserve an in-flight metadata check and its failure deadline', async () => {
    const state = streamer('alpha', 0);
    state.isLive = false;
    const result = Promise.withResolvers<StreamInfoStatus>();
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => result.promise);
    const deps: EventHandlerDeps = {
      streamerStates: new Map([[state.name, state]]),
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };

    try {
      const scheduled = checkStreamerOnline(state);
      handlePubSubMessage(deps, 'video-playback-by-id.alpha-id', 'viewcount', { viewers: 42 });
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);
      const retryAtMs = Date.now() + 5 * 60_000;
      result.resolve({ kind: 'unknown', reason: 'gql_error', retryAtMs });
      await scheduled;
      deps.dedup.lastMessageTimestamp = 0;
      handlePubSubMessage(deps, 'video-playback-by-id.alpha-id', 'viewcount', { viewers: 43 });
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.isLive).toBe(false);
      expect(state.stream.viewers).toBe(43);
      expect(state.metadata.status).toBe('failed');
      expect(state.metadata.nextCheckAtMs).toBe(retryAtMs);
    } finally {
      result.resolve({ kind: 'unknown', reason: 'gql_error' });
      await checkStreamerOnline(state);
      statusSpy.mockRestore();
    }
  });

  test('backs off thrown metadata failures without discarding known state', async () => {
    const state = streamer('alpha', 0);
    state.stream.broadcastId = 'known-broadcast';
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockRejectedValue(new Error('Network unavailable'));

    try {
      await checkStreamerOnline(state);
      await checkStreamerOnline(state);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(state.isLive).toBe(true);
      expect(state.stream.broadcastId).toBe('known-broadcast');
      expect(state.metadata.status).toBe('failed');
      expect(state.metadata.nextCheckAtMs).toBeGreaterThan(Date.now());
    } finally {
      statusSpy.mockRestore();
    }
  });

  test('preserves known live metadata on failure and refreshes it after the retry deadline', async () => {
    vi.useFakeTimers();
    const state = streamer('alpha', 0);
    state.stream.broadcastId = 'known-broadcast';
    state.stream.title = 'known title';
    state.metadata.lastSuccessAtMs = Date.now() - 10 * 60_000;
    state.lastContextRefresh = Date.now();
    const lastSuccessAtMs = state.metadata.lastSuccessAtMs;
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockResolvedValue({
      kind: 'unknown',
      reason: 'gql_error'
    });

    try {
      await checkStreamerOnline(state);
      expect(state.isLive).toBe(true);
      expect(state.stream.broadcastId).toBe('known-broadcast');
      expect(state.stream.title).toBe('known title');
      expect(state.metadata.status).toBe('failed');
      expect(state.metadata.lastSuccessAtMs).toBe(lastSuccessAtMs);
      expect(state.metadata.lastFailureAtMs).toBe(Date.now());
      statusSpy.mockResolvedValue({
        kind: 'live',
        info: { broadcastId: 'known-broadcast', title: 'new title', game: null, viewersCount: 50 }
      });
      vi.advanceTimersByTime(60_000);
      await checkStreamerOnline(state);
      expect(state.stream.title).toBe('new title');
      expect(state.metadata.status).toBe('fresh');
      expect(state.metadata.lastSuccessAtMs).toBe(Date.now());
    } finally {
      statusSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('ignores a live response superseded by a PubSub stream-down', async () => {
    const state = streamer('alpha', 0);
    state.isLive = false;
    const result = Promise.withResolvers<StreamInfoStatus>();
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => result.promise);
    const deps: EventHandlerDeps = {
      streamerStates: new Map([[state.name, state]]),
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };

    try {
      const pending = checkStreamerOnline(state);
      await Promise.resolve();
      handlePubSubMessage(deps, 'video-playback-by-id.alpha-id', 'stream-down', {});
      result.resolve({
        kind: 'live',
        info: { broadcastId: 'obsolete', title: 'obsolete', game: null, viewersCount: 50 }
      });
      await pending;
      expect(state.isLive).toBe(false);
      expect(state.stream.broadcastId).toBeNull();
      expect(state.metadata.lastSuccessAtMs).toBe(0);
    } finally {
      result.resolve({ kind: 'offline' });
      await checkStreamerOnline(state);
      statusSpy.mockRestore();
    }
  });

  test('discards old metadata after restart and recovers an offline streamer on later polls', async () => {
    vi.useFakeTimers();
    const service = new MinerService();
    const internals = service as unknown as WatchLoopInternals;
    const state = streamer('alpha', 0);
    state.isLive = false;
    internals.running = true;
    internals.streamerStates = new Map([[state.name, state]]);
    const oldResult = Promise.withResolvers<StreamInfoStatus>();
    const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => oldResult.promise);
    const recordSpy = vi.spyOn(eventStore, 'recordEvent').mockImplementation(() => {});

    try {
      internals.startMetadataLoop();
      await Promise.resolve();
      internals.invalidateMetadataLoop();
      internals.startMetadataLoop();
      vi.advanceTimersByTime(20_000);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      oldResult.resolve({
        kind: 'live',
        info: { broadcastId: 'obsolete', title: 'obsolete', game: null, viewersCount: 50 }
      });
      await checkStreamerOnline(state);
      expect(state.isLive).toBe(false);
      expect(state.stream.broadcastId).toBeNull();
      statusSpy.mockResolvedValue({ kind: 'offline' });
      vi.advanceTimersByTime(20_000);
      await checkStreamerOnline(state);
      expect(state.metadata.status).toBe('fresh');
      statusSpy.mockResolvedValue({
        kind: 'live',
        info: { broadcastId: 'current', title: 'current', game: null, viewersCount: 75 }
      });
      vi.advanceTimersByTime(15 * 60_000);
      await checkStreamerOnline(state);
      expect(state.isLive).toBe(true);
      expect(state.stream.broadcastId).toBe('current');
    } finally {
      internals.running = false;
      internals.invalidateMetadataLoop();
      oldResult.resolve({ kind: 'offline' });
      await checkStreamerOnline(state);
      statusSpy.mockRestore();
      recordSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('PubSub message deduplication', () => {
  const pointsEarned = (reasonCode: string, totalPoints: number, balance: number) => ({
    type: 'points-earned',
    data: {
      timestamp: `2026-01-01T00:00:00.${balance}Z`,
      channel_id: 'alpha-id',
      point_gain: { total_points: totalPoints, reason_code: reasonCode },
      balance: { balance, channel_id: 'alpha-id' }
    }
  });

  test('records distinct points-earned messages arriving back to back', () => {
    const state = { ...streamer('alpha', 0), channelPointsStatus: CHANNEL_POINTS_STATUS.Enabled };
    const deps: EventHandlerDeps = {
      streamerStates: new Map([[state.name, state]]),
      dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
      claimBonus: async () => {}
    };
    const recordSpy = vi.spyOn(eventStore, 'recordEvent').mockImplementation(() => {});

    try {
      const topic = 'community-points-user-v1.user';
      handlePubSubMessage(deps, topic, 'points-earned', pointsEarned('WATCH', 10, 1010));
      handlePubSubMessage(deps, topic, 'points-earned', pointsEarned('WATCH_STREAK', 450, 1460));
      handlePubSubMessage(deps, topic, 'points-earned', pointsEarned('WATCH_STREAK', 450, 1460));
      expect(recordSpy).toHaveBeenCalledTimes(2);
      expect(state.channelPoints).toBe(1460);
      expect(state.history.WATCH_STREAK).toEqual({ counter: 1, amount: 450 });
    } finally {
      recordSpy.mockRestore();
    }
  });
});
