import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDashboardSummary } from '$lib/server/db/summary';
import { minerService } from '$lib/server/miner';

export const GET: RequestHandler = async () =>
  json({ success: true, ...getDashboardSummary(minerService.getWatchedStreams()) });
