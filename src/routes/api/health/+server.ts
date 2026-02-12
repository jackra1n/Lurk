import { json } from '@sveltejs/kit';

const startedAt = Date.now();

export const GET = () =>
	json({
		status: 'ok',
		startedAt: new Date(startedAt).toISOString(),
		uptimeMs: Math.floor(process.uptime() * 1000),
		version: process.env.LURK_VERSION ?? null
	});
