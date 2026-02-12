import { mkdirSync } from 'node:fs';
import pino from 'pino';
import pretty from 'pino-pretty';
import { createStream } from 'rotating-file-stream';
import { LOG_DIR } from './paths';

const LOG_FILE = 'lurk.log';
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

mkdirSync(LOG_DIR, { recursive: true });

const envLevel = process.env.LOG_LEVEL?.toLowerCase();
const level = LEVELS.has(envLevel ?? '')
	? envLevel
	: process.env.NODE_ENV === 'production'
		? 'info'
		: 'debug';

const rotatingFileStream = createStream(LOG_FILE, {
	interval: '1d',
	maxFiles: 14,
	path: LOG_DIR
});

rotatingFileStream.on('error', (error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`[Logger] File stream error: ${message}\n`);
});

const consolePrettyStream = pretty({
	colorize: true,
	translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
	ignore: 'pid,hostname,scope',
	messageFormat: '{if scope}[{scope}] {end}{msg}',
	singleLine: true,
});

const filePrettyStream = pretty({
	colorize: false,
	translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
	ignore: 'pid,hostname,scope',
	messageFormat: '{if scope}[{scope}] {end}{msg}',
	singleLine: true,
	destination: rotatingFileStream,
});

export const log = pino(
	{
		level,
		timestamp: pino.stdTimeFunctions.isoTime,
		base: undefined,
		redact: {
			paths: [
				'accessToken',
				'*.accessToken',
				'auth_token',
				'*.auth_token',
				'authorization',
				'*.authorization',
				'headers.authorization',
				'cookie',
				'*.cookie',
				'headers.cookie'
			],
			censor: '[REDACTED]'
		}
	},
	pino.multistream([
		{ stream: consolePrettyStream, level: 'info' },
		{ stream: filePrettyStream, level: 'debug' },
	])
);

export const getLogger = (scope: string) => log.child({ scope });
