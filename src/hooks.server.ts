import type { Handle } from '@sveltejs/kit';
import { minerService } from '$lib/server/miner';
import { getLogger } from '$lib/server/logger';

let initialized = false;
const logger = getLogger('Hooks');

async function initializeMiner(): Promise<void> {
	if (initialized) return;
	initialized = true;

	logger.info('Initializing Twitch Points Miner...');

	const result = await minerService.start();
	if (result.success) {
		logger.info({ startup: result.reason }, 'Miner initialization completed');
		return;
	}

	if (result.reason === 'missing_token' || result.reason === 'invalid_token') {
		logger.info({ startup: 'auth_required', reason: result.reason }, 'Miner initialization skipped');
		return;
	}

	logger.warn({ startup: 'error', reason: result.reason }, 'Miner initialization failed');
}

initializeMiner().catch((err) => {
	logger.error({ err }, 'Failed to initialize miner');
});

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
