import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStreamerActivity } from '$lib/server/db/streamer-activity';
import { minerService } from '$lib/server/miner';

export const GET: RequestHandler = async ({ url }) => {
  const daysInput = url.searchParams.get('days');
  const days = daysInput ? Math.min(30, Math.max(1, parseInt(daysInput, 10) || 7)) : 7;
  const runtimeStates = minerService.getStreamerRuntimeStates();
  const activity = getStreamerActivity({
    days,
    onlineLogins: new Set(runtimeStates.filter((state) => state.isOnline).map((state) => state.login)),
    watchedLogins: new Set(runtimeStates.filter((state) => state.isWatched).map((state) => state.login))
  });

  return json({
    success: true,
    days,
    ...activity
  });
};
