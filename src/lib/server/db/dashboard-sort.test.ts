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
	test('asc is the exact reverse of desc when there are no tiebreaker ties', () => {
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

		const modes: ChannelPointsSortBy[] = ['name', 'points', 'priority', 'lastActive'];

		for (const mode of modes) {
			const descResult = loginsFor(scenario, mode, 'desc');
			const ascResult = loginsFor(scenario, mode, 'asc');
			expect(ascResult).toEqual([...descResult].reverse());
		}
	});

	test('tied items use stable A-Z tiebreaker regardless of sort direction', () => {
		const scenario = buildScenario([
			{ login: 'echo', latestBalance: 100, lastActiveAtMs: 5_000, lastWatchedAtMs: 5_000, isOnline: true, isWatched: true },
			{ login: 'alpha', latestBalance: 100, lastActiveAtMs: 5_000, lastWatchedAtMs: 5_000, isOnline: true, isWatched: true },
			{ login: 'charlie', latestBalance: 100, lastActiveAtMs: 5_000, lastWatchedAtMs: 5_000, isOnline: true, isWatched: true }
		]);

		// all items are tied on every metric, so name tiebreaker (A-Z) decides
		const modes: ChannelPointsSortBy[] = ['lastWatched', 'lastActive'];
		const expectedAlphabetical = ['alpha', 'charlie', 'echo'];

		for (const mode of modes) {
			expect(loginsFor(scenario, mode, 'desc')).toEqual(expectedAlphabetical);
			expect(loginsFor(scenario, mode, 'asc')).toEqual(expectedAlphabetical);
		}
	});

	test('lastWatched canonical order prefers watched, then timestamp, then A-Z for equal timestamps', () => {
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
		expect(desc).toEqual(['delta', 'echo', 'bravo', 'charlie', 'alpha', 'foxtrot', 'golf']);
	});

	test('lastWatched ignores online status for non-watched timestamp ties', () => {
		const scenario = buildScenario([
			{ login: 'zulu', latestBalance: 1, lastActiveAtMs: 1_000, lastWatchedAtMs: 5_000, isOnline: true },
			{ login: 'alpha', latestBalance: 1, lastActiveAtMs: 1_000, lastWatchedAtMs: 5_000 }
		]);

		expect(loginsFor(scenario, 'lastWatched', 'desc')).toEqual(['alpha', 'zulu']);
		expect(loginsFor(scenario, 'lastWatched', 'asc')).toEqual(['alpha', 'zulu']);
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

		const score = (login: string) => {
			if (scenario.watchedStreamers.has(login)) return 2;
			if (scenario.onlineStreamers.has(login)) return 1;
			return 0;
		};

		const desc = loginsFor(scenario, 'lastActive', 'desc');

		for (let index = 0; index < desc.length - 1; index += 1) {
			expect(score(desc[index])).toBeGreaterThanOrEqual(score(desc[index + 1]));
		}

		const asc = loginsFor(scenario, 'lastActive', 'asc');

		for (let index = 0; index < asc.length - 1; index += 1) {
			expect(score(asc[index])).toBeLessThanOrEqual(score(asc[index + 1]));
		}
	});
});
