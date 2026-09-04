import { describe, expect, test } from 'bun:test';
import { isTransientFetchError, shouldRefetchSpadeUrl, type SpadeUrlCache } from './index';

const HOUR = 60 * 60 * 1000;

const cache = (overrides: Partial<SpadeUrlCache> = {}): SpadeUrlCache => ({
	spadeUrl: 'https://video-weaver.example/spade',
	lastSpadeUrlFetch: 10 * HOUR,
	lastSpadeUrlAttempt: 10 * HOUR,
	...overrides
});

describe('shouldRefetchSpadeUrl', () => {
	test('reuses fresh cached URL', () => {
		expect(shouldRefetchSpadeUrl(cache(), 11 * HOUR)).toBe(false);
	});

	test('refetches once the refresh interval elapses', () => {
		expect(shouldRefetchSpadeUrl(cache(), 10 * HOUR + 12 * HOUR + 1)).toBe(true);
	});

	test('backs off while a previous attempt is recent', () => {
		const failing = cache({ spadeUrl: null });
		expect(shouldRefetchSpadeUrl(failing, failing.lastSpadeUrlAttempt + 59_000)).toBe(false);
	});

	test('allows retry after the backoff window', () => {
		const failing = cache({ spadeUrl: null });
		expect(shouldRefetchSpadeUrl(failing, failing.lastSpadeUrlAttempt + 60_000)).toBe(true);
	});

	test('keeps backing off after a failed refresh of a stale URL', () => {
		// URL older than 12h but a scrape failed one minute ago: reuse stale value
		const stale = cache({ lastSpadeUrlFetch: 0, lastSpadeUrlAttempt: 20 * HOUR });
		expect(shouldRefetchSpadeUrl(stale, 20 * HOUR + 59_000)).toBe(false);
	});
});

describe('isTransientFetchError', () => {
	test('recognizes a reset Twitch connection as transient', () => {
		const error = Object.assign(new TypeError('The socket connection was closed unexpectedly'), {
			code: 'ECONNRESET'
		});

		expect(isTransientFetchError(error)).toBe(true);
	});

	test('recognizes request timeouts as transient', () => {
		expect(isTransientFetchError(new DOMException('Timed out', 'TimeoutError'))).toBe(true);
	});

	test('does not hide unexpected application errors', () => {
		expect(isTransientFetchError(new TypeError('Invalid minute-watched payload'))).toBe(false);
	});
});
