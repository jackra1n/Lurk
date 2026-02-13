import type { ChannelPointsSortBy, SortDir, StreamerAnalyticsItem } from './dashboard';

interface SortStreamerAnalyticsItemsInput {
	items: StreamerAnalyticsItem[];
	sortBy: ChannelPointsSortBy;
	sortDir: SortDir;
	priorityIndexByLogin: ReadonlyMap<string, number>;
	onlineStreamers?: ReadonlySet<string>;
	watchedStreamers?: ReadonlySet<string>;
}

type StreamerComparator = (left: StreamerAnalyticsItem, right: StreamerAnalyticsItem) => number;

const compareNumbers = (left: number, right: number, dir: SortDir) =>
	dir === 'asc' ? left - right : right - left;

const compareNullableNumbers = (left: number | null, right: number | null, dir: SortDir) => {
	if (left === null && right === null) return 0;
	if (left === null) return dir === 'asc' ? -1 : 1;
	if (right === null) return dir === 'asc' ? 1 : -1;
	return compareNumbers(left, right, dir);
};

const compareByName = (left: string, right: string, dir: SortDir) =>
	dir === 'asc' ? left.localeCompare(right) : right.localeCompare(left);

const pickFirstNonZero = (...values: number[]) => values.find((value) => value !== 0) ?? 0;

const comparePriority = (
	leftLogin: string,
	rightLogin: string,
	priorityIndexByLogin: ReadonlyMap<string, number>,
	dir: SortDir
) => {
	const leftIndex = priorityIndexByLogin.get(leftLogin) ?? Number.MAX_SAFE_INTEGER;
	const rightIndex = priorityIndexByLogin.get(rightLogin) ?? Number.MAX_SAFE_INTEGER;
	const byIndex = dir === 'asc' ? rightIndex - leftIndex : leftIndex - rightIndex;
	return byIndex !== 0 ? byIndex : compareByName(leftLogin, rightLogin, 'asc');
};

const getActivityScore = (
	login: string,
	watchedStreamers: ReadonlySet<string>,
	onlineStreamers: ReadonlySet<string>
) => {
	if (watchedStreamers.has(login)) return 2;
	if (onlineStreamers.has(login)) return 1;
	return 0;
};

export const sortStreamerAnalyticsItems = ({
	items,
	sortBy,
	sortDir,
	priorityIndexByLogin,
	onlineStreamers = new Set<string>(),
	watchedStreamers = new Set<string>()
}: SortStreamerAnalyticsItemsInput) => {
	const compareByLoginAZ: StreamerComparator = (left, right) =>
		compareByName(left.login, right.login, 'asc');

	const comparators: Record<ChannelPointsSortBy, StreamerComparator> = {
		priority: (left, right) => comparePriority(left.login, right.login, priorityIndexByLogin, sortDir),
		name: (left, right) => compareByName(left.login, right.login, sortDir),
		points: (left, right) => compareNumbers(left.latestBalance, right.latestBalance, sortDir),
		lastWatched: (left, right) => {
			const leftWatched = watchedStreamers.has(left.login);
			const rightWatched = watchedStreamers.has(right.login);
			const byWatched = compareNumbers(
				Number(leftWatched),
				Number(rightWatched),
				sortDir
			);
			if (byWatched !== 0) return byWatched;

			if (leftWatched) return compareByLoginAZ(left, right);

			return pickFirstNonZero(
				compareNullableNumbers(left.lastWatchedAtMs, right.lastWatchedAtMs, sortDir),
				compareByLoginAZ(left, right)
			);
		},
		lastActive: (left, right) => {
			const byActivityScore = compareNumbers(
				getActivityScore(left.login, watchedStreamers, onlineStreamers),
				getActivityScore(right.login, watchedStreamers, onlineStreamers),
				sortDir
			);
			if (byActivityScore !== 0) return byActivityScore;

			return pickFirstNonZero(
				compareNullableNumbers(left.lastActiveAtMs, right.lastActiveAtMs, sortDir),
				compareByLoginAZ(left, right)
			);
		}
	};

	return [...items].sort(comparators[sortBy]);
};
