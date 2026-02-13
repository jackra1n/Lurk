import { describe, expect, test } from 'bun:test';
import type { ChannelPointsSortBy, StreamerAnalyticsItem } from './dashboard';
import { sortStreamerAnalyticsItems } from './dashboard-sort';

interface ScenarioRow {
	login: string;
	latestBalance: number;
	lastActiveAtMs: number | null;
	lastWatchedAtMs: number | null;
	isOnline?: boolean;
	isWatched?: boolean;
}

interface ScenarioInput {
	items: StreamerAnalyticsItem[];
	onlineStreamers: Set<string>;
	watchedStreamers: Set<string>;
	priorityIndexByLogin: Map<string, number>;
}

const buildScenario = (rows: ScenarioRow[], priorityOrder = rows.map((row) => row.login)): ScenarioInput => ({
	items: rows.map((row, index) => ({
		streamerId: index + 1,
		login: row.login,
		latestBalance: row.latestBalance,
		pointsEarned: 0,
		lastActiveAtMs: row.lastActiveAtMs,
		lastWatchedAtMs: row.lastWatchedAtMs
	})),
	onlineStreamers: new Set(rows.filter((row) => row.isOnline).map((row) => row.login)),
	watchedStreamers: new Set(rows.filter((row) => row.isWatched).map((row) => row.login)),
	priorityIndexByLogin: new Map(priorityOrder.map((login, index) => [login, index]))
});

const loginsFor = (
	scenario: ScenarioInput,
	sortBy: ChannelPointsSortBy,
	sortDir: 'asc' | 'desc'
) =>
	sortStreamerAnalyticsItems({
		items: scenario.items,
		sortBy,
		sortDir,
		priorityIndexByLogin: scenario.priorityIndexByLogin,
		onlineStreamers: scenario.onlineStreamers,
		watchedStreamers: scenario.watchedStreamers
	}).map((item) => item.login);

describe('sortStreamerAnalyticsItems', () => {
	test('reverses exactly for asc/desc across all sort modes', () => {
		const scenario = buildScenario(
			[
				{ login: 'alpha', latestBalance: 100, lastActiveAtMs: 1_000, lastWatchedAtMs: 1_000 },
				{ login: 'bravo', latestBalance: 200, lastActiveAtMs: 8_000, lastWatchedAtMs: 5_000, isOnline: true },
				{ login: 'charlie', latestBalance: 150, lastActiveAtMs: 3_000, lastWatchedAtMs: 5_000 },
				{
					login: 'delta',
					latestBalance: 120,
					lastActiveAtMs: 9_000,
					lastWatchedAtMs: 6_000,
					isOnline: true,
					isWatched: true
				},
				{
					login: 'echo',
					latestBalance: 300,
					lastActiveAtMs: 8_500,
					lastWatchedAtMs: 6_000,
					isOnline: true,
					isWatched: true
				},
				{ login: 'foxtrot', latestBalance: 50, lastActiveAtMs: null, lastWatchedAtMs: null },
				{ login: 'golf', latestBalance: 180, lastActiveAtMs: 7_000, lastWatchedAtMs: null, isOnline: true }
			],
			['charlie', 'alpha', 'echo', 'bravo', 'foxtrot', 'delta', 'golf']
		);
		const modes: ChannelPointsSortBy[] = ['lastWatched', 'lastActive', 'name', 'points', 'priority'];

		for (const mode of modes) {
			const desc = loginsFor(scenario, mode, 'desc');
			const asc = loginsFor(scenario, mode, 'asc');
			expect(asc).toEqual([...desc].reverse());
		}
	});

	test('lastWatched canonical order prefers watched, then timestamp, then online for equal timestamps', () => {
		const scenario = buildScenario([
			{ login: 'delta', latestBalance: 120, lastActiveAtMs: 9_000, lastWatchedAtMs: 6_000, isOnline: true, isWatched: true },
			{ login: 'echo', latestBalance: 300, lastActiveAtMs: 8_500, lastWatchedAtMs: 6_000, isOnline: true, isWatched: true },
			{ login: 'bravo', latestBalance: 200, lastActiveAtMs: 8_000, lastWatchedAtMs: 5_000, isOnline: true },
			{ login: 'charlie', latestBalance: 150, lastActiveAtMs: 3_000, lastWatchedAtMs: 5_000 },
			{ login: 'alpha', latestBalance: 100, lastActiveAtMs: 1_000, lastWatchedAtMs: 1_000 },
			{ login: 'golf', latestBalance: 180, lastActiveAtMs: 7_000, lastWatchedAtMs: null, isOnline: true },
			{ login: 'foxtrot', latestBalance: 50, lastActiveAtMs: null, lastWatchedAtMs: null }
		]);

		const desc = loginsFor(scenario, 'lastWatched', 'desc');
		expect(desc).toEqual(['delta', 'echo', 'bravo', 'charlie', 'alpha', 'golf', 'foxtrot']);
	});

	test('lastActive canonical order keeps watched > online > offline groups', () => {
		const scenario = buildScenario([
			{ login: 'echo', latestBalance: 300, lastActiveAtMs: 8_500, lastWatchedAtMs: 6_000, isOnline: true, isWatched: true },
			{ login: 'delta', latestBalance: 120, lastActiveAtMs: 9_000, lastWatchedAtMs: 6_000, isOnline: true, isWatched: true },
			{ login: 'bravo', latestBalance: 200, lastActiveAtMs: 8_000, lastWatchedAtMs: 5_000, isOnline: true },
			{ login: 'golf', latestBalance: 180, lastActiveAtMs: 7_000, lastWatchedAtMs: null, isOnline: true },
			{ login: 'charlie', latestBalance: 150, lastActiveAtMs: 3_000, lastWatchedAtMs: 5_000 },
			{ login: 'alpha', latestBalance: 100, lastActiveAtMs: 1_000, lastWatchedAtMs: 1_000 },
			{ login: 'foxtrot', latestBalance: 50, lastActiveAtMs: null, lastWatchedAtMs: null }
		]);

		const desc = loginsFor(scenario, 'lastActive', 'desc');
		const rank = (login: string) => {
			if (scenario.watchedStreamers.has(login)) return 0;
			if (scenario.onlineStreamers.has(login)) return 1;
			return 2;
		};

		for (let index = 0; index < desc.length - 1; index += 1) {
			expect(rank(desc[index])).toBeLessThanOrEqual(rank(desc[index + 1]));
		}
	});
});
