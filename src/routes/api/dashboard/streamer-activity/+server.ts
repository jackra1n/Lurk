import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStreamerActivity } from '$lib/server/db/streamer-activity';

export const GET: RequestHandler = async ({ url }) => {
	const daysInput = url.searchParams.get('days');
	const days = daysInput ? Math.min(30, Math.max(1, parseInt(daysInput, 10))) : 7;

	const activity = getStreamerActivity(days);

	return json({
		success: true,
		days,
		...activity
	});
};
