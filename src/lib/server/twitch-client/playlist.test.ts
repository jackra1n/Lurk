import { describe, expect, test } from 'bun:test';
import { lastUrlLine } from './index';

describe('lastUrlLine', () => {
	test('returns last line when it is a URL', () => {
		const playlist = '#EXTM3U\n#EXTINF:2.000,\nhttps://example.com/seg1.ts\n#EXTINF:2.000,\nhttps://example.com/seg2.ts\n';
		expect(lastUrlLine(playlist)).toBe('https://example.com/seg2.ts');
	});

	test('skips trailing prefetch tags', () => {
		const playlist =
			'#EXTM3U\n#EXTINF:2.000,\nhttps://example.com/seg1.ts\n#EXT-X-TWITCH-PREFETCH:https://example.com/seg2.ts\n#EXT-X-TWITCH-PREFETCH:https://example.com/seg3.ts\n';
		expect(lastUrlLine(playlist)).toBe('https://example.com/seg1.ts');
	});

	test('skips trailing endlist tag', () => {
		const playlist = '#EXTM3U\n#EXTINF:2.000,\nhttps://example.com/seg1.ts\n#EXT-X-ENDLIST\n';
		expect(lastUrlLine(playlist)).toBe('https://example.com/seg1.ts');
	});

	test('returns null when playlist has only tags', () => {
		expect(lastUrlLine('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
		expect(lastUrlLine('')).toBeNull();
	});
});
