import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getChannelPointsAnalytics,
	type ChannelPointsSortBy,
	type SortDir
} from '$lib/server/db/dashboard';

const dayMs = 24 * 60 * 60 * 1000;
const maxRangeMs = 90 * dayMs;
const defaultRangeMs = dayMs;
const sortByValues: ChannelPointsSortBy[] = ['name', 'points', 'lastActive', 'priority'];
const sortDirValues: SortDir[] = ['asc', 'desc'];

const asNumber = (value: string | null) => {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const asSortBy = (value: string | null): ChannelPointsSortBy =>
	value && sortByValues.includes(value as ChannelPointsSortBy) ? (value as ChannelPointsSortBy) : 'lastActive';

const asSortDir = (value: string | null): SortDir =>
	value && sortDirValues.includes(value as SortDir) ? (value as SortDir) : 'desc';

export const GET: RequestHandler = async ({ url }) => {
	const now = Date.now();
	const toMsInput = asNumber(url.searchParams.get('to'));
	const fromMsInput = asNumber(url.searchParams.get('from'));
	const sortBy = asSortBy(url.searchParams.get('sortBy'));
	const sortDir = asSortDir(url.searchParams.get('sortDir'));
	const selectedStreamerLogin = url.searchParams.get('selectedStreamer');

	const toMs = toMsInput ?? now;
	const fromMs = fromMsInput ?? toMs - defaultRangeMs;

	if (fromMs > toMs) {
		return json({ success: false, message: '`from` must be less than or equal to `to`' }, { status: 400 });
	}

	const effectiveFromMs = Math.max(fromMs, toMs - maxRangeMs);
	const analytics = getChannelPointsAnalytics({
		fromMs: effectiveFromMs,
		toMs,
		sortBy,
		sortDir,
		selectedStreamerLogin
	});

	return json({
		success: true,
		range: {
			fromMs: effectiveFromMs,
			toMs
		},
		sort: {
			by: sortBy,
			dir: sortDir
		},
		...analytics
	});
};
