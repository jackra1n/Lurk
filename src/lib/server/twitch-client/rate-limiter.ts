interface QueueItem {
	enqueuedAt: number;
	queueDepthAtEnqueue: number;
	run: () => void;
	reject: (error: Error) => void;
}

export interface RateLimiterOptions {
	ratePerSecond: number;
	burst?: number;
	maxQueue?: number;
}

export interface RateLimiterResult<T> {
	value: T;
	waitMs: number;
	queueDepthAtEnqueue: number;
}

export class RateLimiterQueueFullError extends Error {
	readonly code = 'RATE_LIMITER_QUEUE_FULL';

	constructor(
		readonly label: string,
		readonly maxQueue: number
	) {
		super(`Rate limiter queue is full for ${label}`);
	}
}

export class AsyncRateLimiter {
	private readonly ratePerSecond: number;
	private readonly burst: number;
	private readonly maxQueue: number;
	private tokens: number;
	private lastRefillMs: number;
	private queue: QueueItem[] = [];
	private drainTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(options: RateLimiterOptions) {
		const ratePerSecond = Number.isFinite(options.ratePerSecond) && options.ratePerSecond > 0 ? options.ratePerSecond : 1;
		const burst = Number.isFinite(options.burst) && (options.burst ?? 0) > 0 ? options.burst! : ratePerSecond;
		const maxQueue = Number.isFinite(options.maxQueue) && (options.maxQueue ?? 0) > 0 ? options.maxQueue! : 300;

		this.ratePerSecond = ratePerSecond;
		this.burst = burst;
		this.maxQueue = maxQueue;
		this.tokens = burst;
		this.lastRefillMs = Date.now();
	}

	getRatePerSecond() {
		return this.ratePerSecond;
	}

	getBurst() {
		return this.burst;
	}

	getMaxQueue() {
		return this.maxQueue;
	}

	getQueueDepth() {
		return this.queue.length;
	}

	async schedule<T>(label: string, task: () => Promise<T>): Promise<RateLimiterResult<T>> {
		if (this.disposed) {
			throw new Error('Rate limiter is disposed');
		}

		const enqueuedAt = Date.now();
		this.refillTokens(enqueuedAt);

		if (this.tokens >= 1 && this.queue.length === 0) {
			this.tokens -= 1;
			const value = await task();
			return { value, waitMs: 0, queueDepthAtEnqueue: 0 };
		}

		if (this.queue.length >= this.maxQueue) {
			throw new RateLimiterQueueFullError(label, this.maxQueue);
		}

		return new Promise<RateLimiterResult<T>>((resolve, reject) => {
			const queueDepthAtEnqueue = this.queue.length + 1;
			const queueItem: QueueItem = {
				enqueuedAt,
				queueDepthAtEnqueue,
				run: () => {
					const startedAt = Date.now();
					Promise.resolve(task())
						.then((value) =>
							resolve({
								value,
								waitMs: startedAt - queueItem.enqueuedAt,
								queueDepthAtEnqueue: queueItem.queueDepthAtEnqueue
							})
						)
						.catch(reject);
				},
				reject
			};

			this.queue.push(queueItem);
			this.scheduleDrain();
		});
	}

	dispose() {
		this.disposed = true;
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = null;
		}

		for (const item of this.queue) {
			item.reject(new Error('Rate limiter is disposed'));
		}
		this.queue = [];
	}

	private refillTokens(nowMs: number) {
		if (nowMs <= this.lastRefillMs) return;

		const elapsedMs = nowMs - this.lastRefillMs;
		const refillAmount = (elapsedMs / 1000) * this.ratePerSecond;
		this.tokens = Math.min(this.burst, this.tokens + refillAmount);
		this.lastRefillMs = nowMs;
	}

	private scheduleDrain() {
		if (this.disposed || this.queue.length === 0) return;

		this.refillTokens(Date.now());
		if (this.tokens >= 1) {
			if (this.drainTimer) {
				clearTimeout(this.drainTimer);
				this.drainTimer = null;
			}
			queueMicrotask(() => this.drainQueue());
			return;
		}

		const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
		}
		this.drainTimer = setTimeout(() => {
			this.drainTimer = null;
			this.drainQueue();
		}, waitMs);
	}

	private drainQueue() {
		if (this.disposed || this.queue.length === 0) return;

		this.refillTokens(Date.now());

		while (this.tokens >= 1 && this.queue.length > 0) {
			this.tokens -= 1;
			const item = this.queue.shift();
			item?.run();
		}

		this.scheduleDrain();
	}
}
