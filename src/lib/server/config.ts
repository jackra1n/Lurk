import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(process.cwd(), 'config.json');

export interface MinerConfig {
	streamers: string[];
	autoStartMiner: boolean;
}

const defaultConfig: MinerConfig = {
	streamers: [],
	autoStartMiner: true
};

function loadConfig(): MinerConfig {
	if (!existsSync(CONFIG_PATH)) {
		saveConfig(defaultConfig);
		return defaultConfig;
	}

	try {
		const raw = readFileSync(CONFIG_PATH, 'utf-8');
		const parsed = JSON.parse(raw) as { streamers?: unknown; autoStartMiner?: unknown };
		const streamers = Array.isArray(parsed.streamers)
			? parsed.streamers
					.filter((streamer): streamer is string => typeof streamer === 'string')
					.map((streamer) => streamer.toLowerCase())
			: defaultConfig.streamers;
		const autoStartMiner =
			typeof parsed.autoStartMiner === 'boolean'
				? parsed.autoStartMiner
				: defaultConfig.autoStartMiner;
		return { streamers, autoStartMiner };
	} catch {
		return defaultConfig;
	}
}

function saveConfig(config: MinerConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

let config: MinerConfig = loadConfig();

export function getConfig(): MinerConfig {
	return config;
}

export function getStreamers(): string[] {
	return config.streamers;
}

export function getAutoStartMiner(): boolean {
	return config.autoStartMiner;
}

export function addStreamer(name: string): void {
	const normalized = name.toLowerCase();
	if (!config.streamers.includes(normalized)) {
		config.streamers.push(normalized);
		saveConfig(config);
	}
}

export function removeStreamer(name: string): void {
	const normalized = name.toLowerCase();
	config.streamers = config.streamers.filter((s) => s !== normalized);
	saveConfig(config);
}

export function reloadConfig(): void {
	config = loadConfig();
}
