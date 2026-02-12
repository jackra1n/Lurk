import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { minerService, type MinerStartReason } from '$lib/server/miner';
import { addStreamer, removeStreamer, getStreamers } from '$lib/server/config';
import { twitchAuth } from '$lib/server/auth';

type MinerLifecycle = 'starting' | 'running' | 'ready' | 'auth_required' | 'authenticating' | 'error';
type LifecycleReason =
	| 'missing_token'
	| 'invalid_token'
	| 'auth_pending'
	| 'startup_failed'
	| null;

function getLifecycle(): { lifecycle: MinerLifecycle; reason: LifecycleReason } {
	const authStatus = twitchAuth.getStatus();
	const minerStatus = minerService.getStatus();
	const lastStart = minerService.getLastStartResult();

	if (minerStatus.starting) {
		return { lifecycle: 'starting', reason: null };
	}

	if (minerStatus.running) {
		return { lifecycle: 'running', reason: null };
	}

	if (authStatus.pendingLogin) {
		return { lifecycle: 'authenticating', reason: 'auth_pending' };
	}

	if (!authStatus.authenticated) {
		if (lastStart?.reason === 'invalid_token') {
			return { lifecycle: 'auth_required', reason: 'invalid_token' };
		}
		return { lifecycle: 'auth_required', reason: 'missing_token' };
	}

	if (lastStart?.reason === 'pubsub_connect_failed' || lastStart?.reason === 'start_failed') {
		return { lifecycle: 'error', reason: 'startup_failed' };
	}

	return { lifecycle: 'ready', reason: null };
}

function getStartStatusCode(reason: MinerStartReason): number {
	if (reason === 'missing_token' || reason === 'invalid_token') {
		return 400;
	}
	if (reason === 'pubsub_connect_failed' || reason === 'start_failed') {
		return 500;
	}
	return 400;
}

export const GET: RequestHandler = async () => {
	const status = minerService.getStatus();
	const streamerRuntimeStates = minerService.getStreamerRuntimeStates();
	const auth = twitchAuth.getStatus();
	const { lifecycle, reason } = getLifecycle();

	return json({
		...status,
		lifecycle,
		reason,
		auth,
		hasAuthToken: !!twitchAuth.getAuthToken(),
		configuredStreamers: getStreamers(),
		streamerRuntimeStates
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { action, value } = body;

	switch (action) {
		case 'start': {
			const result = await minerService.start();
			if (!result.success) {
				return json(
					{ success: false, reason: result.reason, message: result.message },
					{ status: getStartStatusCode(result.reason) }
				);
			}

			return json({ success: true, reason: result.reason, message: result.message });
		}

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
