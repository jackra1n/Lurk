import type { Handle } from '@sveltejs/kit';
import { minerService } from '$lib/server/miner';

let initialized = false;

async function initializeMiner(): Promise<void> {
	if (initialized) return;
	initialized = true;

	console.log('[Hooks] Initializing Twitch Points Miner...');

	await minerService.start();
}

initializeMiner().catch((err) => {
	console.error('[Hooks] Failed to initialize miner:', err);
});

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
