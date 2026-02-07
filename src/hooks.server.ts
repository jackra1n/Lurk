import type { Handle } from '@sveltejs/kit';
import { minerService } from '$lib/server/miner';
import { getLogger } from '$lib/server/logger';

let initialized = false;
const logger = getLogger('Hooks');

async function initializeMiner(): Promise<void> {
	if (initialized) return;
	initialized = true;

	logger.info('Initializing Twitch Points Miner...');

	await minerService.start();
}

initializeMiner().catch((err) => {
	logger.error({ err }, 'Failed to initialize miner');
});

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
