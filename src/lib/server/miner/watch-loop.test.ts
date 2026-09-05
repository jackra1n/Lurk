import { describe, expect, test, vi } from 'bun:test';
import { checkStreamerOnline, selectDueStreamers, syncStreamers } from './streamers';
import { createDefaultStreamData, createDefaultStreamMetadataState, type StreamerState } from './types';
import { handlePubSubMessage, type EventHandlerDeps } from './events';
import { DEFAULT_CHANNEL_POINTS_STATUS } from './channel-points-status';
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
		const selected = [
			streamer('due', now - MINUTE),
			streamer('notdue', now - MINUTE + 1),
			streamer('never', 0)
		];
		expect(selectDueStreamers(selected, now, MINUTE).map((state) => state.name)).toEqual([
			'due',
			'never'
		]);
	});

	test('treats unset timestamp as immediately due', () => {
		const selected = [streamer('fresh', 0)];
		expect(selectDueStreamers(selected, MINUTE, MINUTE)).toHaveLength(1);
	});

	test('preserves selection order', () => {
		const now = MINUTE * 5;
		const selected = [streamer('bravo', now - MINUTE), streamer('alpha', now - MINUTE * 2)];
		expect(selectDueStreamers(selected, now, MINUTE).map((state) => state.name)).toEqual([
			'bravo',
			'alpha'
		]);
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
				{ login: state.name, isOnline: true, isWatched: false }
			]);

			internals.watchedStreamerNames = new Set([state.name]);
			expect(service.getStreamerRuntimeStates()).toEqual([
				{ login: state.name, isOnline: true, isWatched: true }
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
					return new Response(
						'<script>window.__twilightBuildID = "00000000-0000-0000-0000-000000000000"</script>'
					);
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
	test('recovers discovery after an outage instead of leaving the streamer without a channel ID', async () => {
		const configured = getStreamers();
		const original = [...configured];
		const states = new Map<string, StreamerState>();
		const lookup = vi.spyOn(twitchClient, 'getUserId').mockResolvedValue(null);
		const listen = vi.spyOn(twitchPubSubPool, 'listen').mockResolvedValue(undefined);
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

	test('shares an in-flight check and retry deadline with PubSub verification', async () => {
		const state = streamer('alpha', 0);
		state.isLive = false;
		state.stream.streamUpAt = Date.now() - 3 * 60_000;
		const result = Promise.withResolvers<StreamInfoStatus>();
		const statusSpy = vi.spyOn(twitchClient, 'getStreamInfoStatus').mockImplementation(() => result.promise);
		const deps: EventHandlerDeps = {
			streamerStates: new Map([[state.name, state]]),
			dedup: { lastMessageTimestamp: 0, lastMessageIdentifier: '' },
			claimBonus: async () => {},
			checkStreamerOnline
		};

		try {
			const scheduled = checkStreamerOnline(state);
			handlePubSubMessage(deps, 'video-playback-by-id.alpha-id', 'viewcount', { viewers: 42 });
			await Promise.resolve();
			expect(statusSpy).toHaveBeenCalledTimes(1);
			const retryAtMs = Date.now() + 5 * 60_000;
			result.resolve({ kind: 'unknown', reason: 'gql_error', retryAtMs });
			await scheduled;
			await checkStreamerOnline(state);
			expect(statusSpy).toHaveBeenCalledTimes(1);
			expect(state.isLive).toBe(false);
			expect(state.stream.viewers).toBe(42);
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
				info: { broadcastId: 'known-broadcast', title: 'new title', game: null, tags: [], viewersCount: 50 }
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
			claimBonus: async () => {},
			checkStreamerOnline
		};

		try {
			const pending = checkStreamerOnline(state);
			await Promise.resolve();
			handlePubSubMessage(deps, 'video-playback-by-id.alpha-id', 'stream-down', {});
			result.resolve({
				kind: 'live',
				info: { broadcastId: 'obsolete', title: 'obsolete', game: null, tags: [], viewersCount: 50 }
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
				info: { broadcastId: 'obsolete', title: 'obsolete', game: null, tags: [], viewersCount: 50 }
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
				info: { broadcastId: 'current', title: 'current', game: null, tags: [], viewersCount: 75 }
			});
			vi.advanceTimersByTime(2 * 60_000);
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
