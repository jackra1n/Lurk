import { describe, expect, test } from 'bun:test';
import { AsyncRateLimiter, RateLimiterQueueFullError } from './rate-limiter';

describe('AsyncRateLimiter', () => {
	test('runs immediately when capacity is available', async () => {
		const limiter = new AsyncRateLimiter({ ratePerSecond: 5, burst: 5, maxQueue: 10 });
		try {
			const result = await limiter.schedule('immediate', async () => 'ok');
			expect(result.value).toBe('ok');
			expect(result.waitMs).toBe(0);
			expect(result.queueDepthAtEnqueue).toBe(0);
		} finally {
			limiter.dispose();
		}
	});

	test('enforces configured throughput under sustained load', async () => {
		const limiter = new AsyncRateLimiter({ ratePerSecond: 5, burst: 1, maxQueue: 20 });
		const startedAt: number[] = [];
		const t0 = Date.now();

		try {
			await Promise.all(
				Array.from({ length: 4 }, (_, index) =>
					limiter.schedule(`throughput-${index}`, async () => {
						startedAt.push(Date.now());
						return index;
					})
				)
			);
		} finally {
			limiter.dispose();
		}

		expect(startedAt).toHaveLength(4);
		const elapsed = startedAt[startedAt.length - 1] - t0;
		expect(elapsed).toBeGreaterThanOrEqual(520);
	});

	test('preserves FIFO order when requests are queued', async () => {
		const limiter = new AsyncRateLimiter({ ratePerSecond: 20, burst: 1, maxQueue: 20 });
		const startedOrder: number[] = [];

		try {
			await Promise.all(
				[1, 2, 3, 4].map((id) =>
					limiter.schedule(`fifo-${id}`, async () => {
						startedOrder.push(id);
						return id;
					})
				)
			);
		} finally {
			limiter.dispose();
		}

		expect(startedOrder).toEqual([1, 2, 3, 4]);
	});

	test('reports non-zero wait time for queued requests', async () => {
		const limiter = new AsyncRateLimiter({ ratePerSecond: 5, burst: 1, maxQueue: 10 });
		try {
			const first = limiter.schedule('wait-1', async () => 'first');
			const second = limiter.schedule('wait-2', async () => 'second');
			const [firstResult, secondResult] = await Promise.all([first, second]);

			expect(firstResult.waitMs).toBe(0);
			expect(secondResult.waitMs).toBeGreaterThanOrEqual(150);
			expect(secondResult.queueDepthAtEnqueue).toBeGreaterThanOrEqual(1);
		} finally {
			limiter.dispose();
		}
	});

	test('rejects when queue depth exceeds maxQueue', async () => {
		const limiter = new AsyncRateLimiter({ ratePerSecond: 1, burst: 1, maxQueue: 1 });

		const first = limiter.schedule('full-1', async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return 'first';
		});
		const second = limiter.schedule('full-2', async () => 'second');

		expect(limiter.schedule('full-3', async () => 'third')).rejects.toBeInstanceOf(RateLimiterQueueFullError);

		await Promise.all([first, second]);
		limiter.dispose();
	});
});
