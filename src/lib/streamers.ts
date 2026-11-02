const TWITCH_URL_PREFIX = /^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//;
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

export function parseStreamerLogin(input: string): string | null {
  const login = input.trim().toLowerCase().replace(TWITCH_URL_PREFIX, '').split(/[/?#]/)[0];
  return LOGIN_PATTERN.test(login) ? login : null;
}
