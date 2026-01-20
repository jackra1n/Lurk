import { getStreamers, getAuthToken } from './config';
import { twitchClient } from './twitch';

export interface StreamerState {
	name: string;
	isLive: boolean;
	lastChecked: Date | null;
	channelPoints: number;
}

export interface MinerStatus {
	running: boolean;
	startedAt: Date | null;
	streamers: StreamerState[];
	tickCount: number;
	lastTick: Date | null;
}

class MinerService {
	private interval: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private startedAt: Date | null = null;
	private tickCount = 0;
	private lastTick: Date | null = null;
	private streamerStates: Map<string, StreamerState> = new Map();

	private readonly TICK_INTERVAL = 30_000; // 30 seconds

	async start(): Promise<void> {
		if (this.running) {
			console.log('[Miner] Already running');
			return;
		}

		const authToken = getAuthToken();
		if (!authToken) {
			console.log('[Miner] Cannot start - no auth token configured');
			return;
		}

		twitchClient.setAuthToken(authToken);

		const isValid = await twitchClient.validateToken();
		if (!isValid) {
			console.log('[Miner] Cannot start - invalid auth token');
			return;
		}

		this.running = true;
		this.startedAt = new Date();
		this.tickCount = 0;

		this.syncStreamers();

		console.log('[Miner] Starting background loop...');

		await this.tick();

		this.interval = setInterval(() => {
			this.tick().catch((err) => {
				console.error('[Miner] Tick error:', err);
			});
		}, this.TICK_INTERVAL);

		console.log(`[Miner] Started. Monitoring ${this.streamerStates.size} streamers.`);
	}

	stop(): void {
		if (!this.running) {
			console.log('[Miner] Not running');
			return;
		}

		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		this.running = false;
		console.log('[Miner] Stopped');
	}

	private syncStreamers(): void {
		const streamers = getStreamers();

		for (const name of streamers) {
			if (!this.streamerStates.has(name)) {
				this.streamerStates.set(name, {
					name,
					isLive: false,
					lastChecked: null,
					channelPoints: 0
				});
			}
		}

		for (const name of this.streamerStates.keys()) {
			if (!streamers.includes(name)) {
				this.streamerStates.delete(name);
			}
		}
	}

	private async tick(): Promise<void> {
		this.tickCount++;
		this.lastTick = new Date();

		console.log(`[Miner] Tick #${this.tickCount} at ${this.lastTick.toISOString()}`);

		this.syncStreamers();

		for (const [name, state] of this.streamerStates) {
			await this.processStreamer(name, state);
		}
	}

	private async processStreamer(name: string, state: StreamerState): Promise<void> {
		state.lastChecked = new Date();

		const isLive = await twitchClient.isChannelLive(name);
		const wasLive = state.isLive;
		state.isLive = isLive;

		if (isLive && !wasLive) {
			console.log(`[Miner] ${name} went LIVE`);
		} else if (!isLive && wasLive) {
			console.log(`[Miner] ${name} went OFFLINE`);
		}

		if (isLive) {
			// TODO: Actual mining logic
			// - Watch time bonus (automatic every 5 mins while watching)
			// - Click bonus (appears randomly, need PubSub to detect)
			// - Predictions (optional, via PubSub)
			console.log(`[Miner] Processing live channel: ${name}`);
		}
	}

	getStatus(): MinerStatus {
		return {
			running: this.running,
			startedAt: this.startedAt,
			streamers: Array.from(this.streamerStates.values()),
			tickCount: this.tickCount,
			lastTick: this.lastTick
		};
	}

	isRunning(): boolean {
		return this.running;
	}
}

export const minerService = new MinerService();
