import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { minerService } from '$lib/server/miner';
import { addStreamer, removeStreamer, setAuthToken, getConfig } from '$lib/server/config';

export const GET: RequestHandler = async () => {
	const status = minerService.getStatus();
	const config = getConfig();

	return json({
		...status,
		hasAuthToken: !!config.authToken,
		configuredStreamers: config.streamers
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

		case 'setToken':
			if (typeof value !== 'string' || !value) {
				return json({ success: false, message: 'Token is required' }, { status: 400 });
			}
			setAuthToken(value);
			return json({ success: true, message: 'Auth token set' });

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
