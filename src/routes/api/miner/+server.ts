import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { minerService } from '$lib/server/miner';
import { addStreamer, removeStreamer, getStreamers } from '$lib/server/config';
import { twitchAuth } from '$lib/server/auth';

export const GET: RequestHandler = async () => {
	const status = minerService.getStatus();

	return json({
		...status,
		hasAuthToken: !!twitchAuth.getAuthToken(),
		configuredStreamers: getStreamers()
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { action, value } = body;

	switch (action) {
		case 'start':
			await minerService.start();
			return json({ success: true, message: 'Miner started' });

		case 'stop':
			minerService.stop();
			return json({ success: true, message: 'Miner stopped' });

		case 'addStreamer':
			if (typeof value !== 'string' || !value) {
				return json({ success: false, message: 'Streamer name is required' }, { status: 400 });
			}
			addStreamer(value);
			return json({ success: true, message: `Added streamer: ${value}` });

		case 'removeStreamer':
			if (typeof value !== 'string' || !value) {
				return json({ success: false, message: 'Streamer name is required' }, { status: 400 });
			}
			removeStreamer(value);
			return json({ success: true, message: `Removed streamer: ${value}` });

		default:
			return json({ success: false, message: 'Unknown action' }, { status: 400 });
	}
};
