import type { ChannelPointsSortBy, SortDir, StreamerAnalyticsItem } from './dashboard';

interface SortStreamerAnalyticsItemsInput {
	items: StreamerAnalyticsItem[];
	sortBy: ChannelPointsSortBy;
	sortDir: SortDir;
	priorityIndexByLogin: ReadonlyMap<string, number>;
	onlineStreamers?: ReadonlySet<string>;
	watchedStreamers?: ReadonlySet<string>;
}

const compareNumbers = (left: number, right: number, dir: SortDir) =>
	dir === 'asc' ? left - right : right - left;

const compareNullableNumbers = (left: number | null, right: number | null, dir: SortDir) => {
	if (left === null && right === null) return 0;
	if (left === null) return dir === 'asc' ? -1 : 1;
	if (right === null) return dir === 'asc' ? 1 : -1;
	return compareNumbers(left, right, dir);
};

const compareByName = (left: string, right: string, dir: SortDir) =>
	dir === 'asc' ? right.localeCompare(left) : left.localeCompare(right);

const comparePriority = (
	leftLogin: string,
	rightLogin: string,
	priorityIndexByLogin: ReadonlyMap<string, number>,
	dir: SortDir
) => {
	const leftIndex = priorityIndexByLogin.get(leftLogin) ?? Number.MAX_SAFE_INTEGER;
	const rightIndex = priorityIndexByLogin.get(rightLogin) ?? Number.MAX_SAFE_INTEGER;
	const byIndex = dir === 'asc' ? rightIndex - leftIndex : leftIndex - rightIndex;
	return byIndex !== 0 ? byIndex : compareByName(leftLogin, rightLogin, dir);
};

const getActivityGroupRank = (
	login: string,
	watchedStreamers: ReadonlySet<string>,
	onlineStreamers: ReadonlySet<string>
) => {
	if (watchedStreamers.has(login)) return 0;
	if (onlineStreamers.has(login)) return 1;
	return 2;
};

const getOnlineRank = (login: string, onlineStreamers: ReadonlySet<string>) =>
	onlineStreamers.has(login) ? 0 : 1;

const canonicalSortDir: SortDir = 'desc';

export const sortStreamerAnalyticsItems = ({
	items,
	sortBy,
	sortDir,
	priorityIndexByLogin,
	onlineStreamers = new Set<string>(),
	watchedStreamers = new Set<string>()
}: SortStreamerAnalyticsItemsInput) => {
	const sorted = [...items];

	sorted.sort((left, right) => {
		if (sortBy === 'priority')
			return comparePriority(left.login, right.login, priorityIndexByLogin, canonicalSortDir);
		if (sortBy === 'name') return compareByName(left.login, right.login, canonicalSortDir);
		if (sortBy === 'points') return compareNumbers(left.latestBalance, right.latestBalance, canonicalSortDir);
		if (sortBy === 'lastWatched') {
			const leftWatched = watchedStreamers.has(left.login);
			const rightWatched = watchedStreamers.has(right.login);

			if (leftWatched !== rightWatched) return leftWatched ? -1 : 1;

			if (leftWatched) {
				return compareByName(left.login, right.login, canonicalSortDir);
			}

			const byLastWatched = compareNullableNumbers(
				left.lastWatchedAtMs,
				right.lastWatchedAtMs,
				canonicalSortDir
			);
			if (byLastWatched !== 0) return byLastWatched;

			const byOnline = getOnlineRank(left.login, onlineStreamers) - getOnlineRank(right.login, onlineStreamers);
			if (byOnline !== 0) return byOnline;

			return compareByName(left.login, right.login, canonicalSortDir);
		}

		if (sortBy === 'lastActive') {
			const byActivityGroup =
				getActivityGroupRank(left.login, watchedStreamers, onlineStreamers) -
				getActivityGroupRank(right.login, watchedStreamers, onlineStreamers);
			if (byActivityGroup !== 0) return byActivityGroup;

			const byLastActive = compareNullableNumbers(
				left.lastActiveAtMs,
				right.lastActiveAtMs,
				canonicalSortDir
			);
			if (byLastActive !== 0) return byLastActive;

			return compareByName(left.login, right.login, canonicalSortDir);
		}

		return 0;
	});

	if (sortDir !== canonicalSortDir) {
		sorted.reverse();
	}

	return sorted;
};
