import { describe, expect, test } from 'bun:test';
import { parseStreamerLogin } from './streamers';

describe('parseStreamerLogin', () => {
  test('accepts plain logins', () => {
    expect(parseStreamerLogin('  FLUMBIX ')).toBe('flumbix');
    expect(parseStreamerLogin('quindlef_')).toBe('quindlef_');
  });

  test('accepts channel urls', () => {
    expect(parseStreamerLogin('https://www.twitch.tv/zorplin')).toBe('zorplin');
    expect(parseStreamerLogin('twitch.tv/Snarvoo/videos?filter=all')).toBe('snarvoo');
    expect(parseStreamerLogin('https://m.twitch.tv/pixelgrove#chat')).toBe('pixelgrove');
  });

  test('rejects invalid input', () => {
    expect(parseStreamerLogin('')).toBeNull();
    expect(parseStreamerLogin('not a name')).toBeNull();
    expect(parseStreamerLogin('https://youtube.com/flumbix')).toBeNull();
    expect(parseStreamerLogin('a'.repeat(26))).toBeNull();
  });
});
