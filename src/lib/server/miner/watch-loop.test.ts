import { describe, expect, test } from 'bun:test';
import { selectDueStreamers } from './streamers';
import { createDefaultStreamData, type StreamerState } from './types';
import { DEFAULT_CHANNEL_POINTS_STATUS } from './channel-points-status';
import { encodeMinuteWatchedPayload } from '../twitch-client';

const MINUTE = 59_000;

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
