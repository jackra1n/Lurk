import { describe, expect, test } from 'bun:test';
import { diffWatchedLogins } from './watch-markers';

describe('diffWatchedLogins', () => {
	test('detects started and stopped watchers between sets', () => {
		expect(diffWatchedLogins(new Set(['alpha', 'bravo']), new Set(['bravo', 'charlie']))).toEqual({
			started: ['charlie'],
			stopped: ['alpha']
		});
	});

	test('returns empty transitions for stable watch sets', () => {
		expect(diffWatchedLogins(new Set(['alpha', 'bravo']), new Set(['bravo', 'alpha']))).toEqual({
			started: [],
			stopped: []
		});
	});

	test('returns sorted transitions for deterministic event ordering', () => {
		expect(diffWatchedLogins(new Set(['charlie', 'alpha']), new Set(['echo', 'bravo']))).toEqual({
			started: ['bravo', 'echo'],
			stopped: ['alpha', 'charlie']
		});
	});
});
