import { describe, expect, test, vi } from 'bun:test';
import { selectDueStreamers } from './streamers';
import { createDefaultStreamData, type StreamerState } from './types';
import { DEFAULT_CHANNEL_POINTS_STATUS } from './channel-points-status';
import { encodeMinuteWatchedPayload, TwitchClient } from '../twitch-client';
import { MinerService } from './service';

const MINUTE = 59_000;

interface WatchLoopInternals {
	running: boolean;
	WATCH_LOOP_INTERVAL: number;
	startWatchLoop(): void;
	invalidateWatchLoop(): void;
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
