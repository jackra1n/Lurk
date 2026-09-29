import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GQL_OPERATIONS } from '../constants';
import { AsyncRateLimiter } from './rate-limiter';
import { classifyGqlErrors, parseRetryAfterMs, TwitchClient, type StreamInfoStatus } from './index';

const streamOperation = GQL_OPERATIONS.VideoPlayerStreamInfoOverlayChannel.operationName;
const liveData = {
  user: {
    broadcastSettings: { title: 'Live', game: { displayName: 'Just Chatting' } },
    stream: { id: 'broadcast', viewersCount: 42, tags: [] }
  }
};
const gqlError = (message: string) => Response.json({ errors: [{ message }] });

interface ClientInternals {
  gqlLimiter: AsyncRateLimiter;
  sleep(ms: number): Promise<void>;
}

let now: number;
let client: TwitchClient;
let internals: ClientInternals;
let requests: string[];
let versionRequests: number;
let respond: (operation: string) => Response | Promise<Response>;
let fetchSpy: { mockRestore(): void };
let clockSpy: { mockRestore(): void };
let randomSpy: { mockRestore(): void };

beforeEach(() => {
  now = Date.UTC(2026, 8, 5);
  requests = [];
  versionRequests = 0;
  clockSpy = spyOn(Date, 'now').mockImplementation(() => now);
  randomSpy = spyOn(Math, 'random').mockReturnValue(0.5);
  respond = () => gqlError('service unavailable');
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    if (String(input) === 'https://www.twitch.tv') {
      versionRequests += 1;
      return new Response('window.__twilightBuildID = "11111111-1111-1111-1111-111111111111"');
    }
    const operation = JSON.parse(String(init?.body)).operationName as string;
    requests.push(operation);
    return respond(operation);
  }) as typeof fetch);
  client = new TwitchClient();
  client.setAuthToken('test-token');
  internals = client as unknown as ClientInternals;
  internals.gqlLimiter.dispose();
  internals.gqlLimiter = new AsyncRateLimiter({ ratePerSecond: 1000, burst: 1000 });
  internals.sleep = async (ms) => {
    now += ms;
  };
});

afterEach(() => {
  internals.gqlLimiter.dispose();
  fetchSpy.mockRestore();
  clockSpy.mockRestore();
  randomSpy.mockRestore();
});

function retryAt(status: StreamInfoStatus): number {
  if (status.kind !== 'unknown' || status.retryAtMs === undefined) throw new Error('Expected deferred stream status');
  return status.retryAtMs;
}

describe('operation-scoped GQL recovery', () => {
  test('maps the observed Twitch response with metadata in broadcastSettings', async () => {
    respond = () => Response.json({ data: liveData });
    expect(await client.getStreamInfoStatus('alpha')).toMatchObject({
      kind: 'live',
      info: {
        broadcastId: 'broadcast',
        title: 'Live',
        game: { displayName: 'Just Chatting' },
        viewersCount: 42
      }
    });
  });

  test('bounds retries across channels, permits unrelated reads, and elects one recovery probe', async () => {
    const failed = await client.getStreamInfoStatus('alpha');
    expect(requests).toEqual(Array(4).fill(streamOperation));
    const deadline = retryAt(failed);
    for (let i = 0; i < 20; i++) expect(retryAt(await client.getStreamInfoStatus(`channel-${i}`))).toBe(deadline);
    expect(requests.length).toBe(4);

    respond = () => Response.json({ data: { user: { id: '123' } } });
    expect(await client.getUserId('unrelated')).toBe('123');
    expect(requests.at(-1)).toBe(GQL_OPERATIONS.GetIDFromLogin.operationName);
    now = deadline - 1;
    expect(retryAt(await client.getStreamInfoStatus('beta'))).toBe(deadline);

    const probeResponse = Promise.withResolvers<Response>();
    const probeStarted = Promise.withResolvers<void>();
    respond = () => {
      probeStarted.resolve();
      return probeResponse.promise;
    };
    now = deadline;
    const probe = client.getStreamInfoStatus('alpha');
    await probeStarted.promise;
    expect((await client.getStreamInfoStatus('beta')).kind).toBe('unknown');
    expect(requests.filter((name) => name === streamOperation).length).toBe(5);
    probeResponse.resolve(Response.json({ data: liveData }));
    expect((await probe).kind).toBe('live');
    respond = () => Response.json({ data: { user: { stream: null } } });
    expect(await client.getStreamInfoStatus('beta')).toEqual({ kind: 'offline' });
  });

  test('concurrent failed requests share one retry owner rather than each starting a retry loop', async () => {
    const responses = Array.from({ length: 3 }, () => Promise.withResolvers<Response>());
    const allStarted = Promise.withResolvers<void>();
    const retryStarted = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    let started = 0;
    respond = () => {
      const response = responses[started++];
      if (started === 3) allStarted.resolve();
      return response ? response.promise : gqlError('service unavailable');
    };
    internals.sleep = async (ms) => {
      retryStarted.resolve();
      await releaseRetry.promise;
      now += ms;
    };
    const first = client.getStreamInfoStatus('alpha');
    const second = client.getStreamInfoStatus('beta');
    const third = client.getStreamInfoStatus('gamma');
    await allStarted.promise;
    responses[0].resolve(gqlError('service unavailable'));
    await retryStarted.promise;
    responses[1].resolve(gqlError('service unavailable'));
    responses[2].resolve(gqlError('service unavailable'));
    expect((await second).kind).toBe('unknown');
    expect((await third).kind).toBe('unknown');
    expect(requests.length).toBe(3);
    releaseRetry.resolve();
    expect((await first).kind).toBe('unknown');
    expect(requests.length).toBe(6);
  });

  test('a concurrent response can extend Retry-After without leaking the pending retry', async () => {
    const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const allStarted = Promise.withResolvers<void>();
    const retryStarted = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    let started = 0;
    respond = () => {
      const response = responses[started++];
      if (started === 2) allStarted.resolve();
      return response ? response.promise : Response.json({ data: liveData });
    };
    internals.sleep = async (ms) => {
      retryStarted.resolve();
      await releaseRetry.promise;
      now += ms;
    };
    const first = client.getStreamInfoStatus('alpha');
    const second = client.getStreamInfoStatus('beta');
    await allStarted.promise;
    responses[0].resolve(gqlError('service unavailable'));
    await retryStarted.promise;
    const deadline = now + 120_000;
    responses[1].resolve(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    expect(retryAt(await second)).toBe(deadline);
    releaseRetry.resolve();
    expect(retryAt(await first)).toBe(deadline);
    expect(requests.length).toBe(2);
  });

  test('failed probes are single attempts and cooldown grows to a cap', async () => {
    let status = await client.getStreamInfoStatus('alpha');
    expect(retryAt(status) - now).toBe(30_000);
    for (const expectedDelay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      now = retryAt(status);
      const before = requests.length;
      status = await client.getStreamInfoStatus('alpha');
      expect(requests.length - before).toBe(1);
      expect(retryAt(status) - now).toBe(expectedDelay);
    }
  });

  test('Retry-After defers other callers and honors the exact reopening boundary', async () => {
    respond = () => new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    const failedAt = now;
    const status = await client.getStreamInfoStatus('alpha');
    expect(retryAt(status)).toBe(failedAt + 120_000);
    expect(requests.length).toBe(1);
    now = retryAt(status) - 1;
    await client.getStreamInfoStatus('beta');
    expect(requests.length).toBe(1);
    now += 1;
    respond = () =>
      new Response('', { status: 503, headers: { 'Retry-After': new Date(now + 600_000).toUTCString() } });
    const probe = await client.getStreamInfoStatus('alpha');
    expect(requests.length).toBe(2);
    expect(retryAt(probe)).toBe(now + 600_000);
  });

  test('a short Retry-After is also a lower bound on an in-loop retry', async () => {
    const sentAt: number[] = [];
    respond = () => {
      sentAt.push(now);
      return sentAt.length === 1
        ? new Response('', { status: 503, headers: { 'Retry-After': '3' } })
        : Response.json({ data: liveData });
    };
    expect((await client.getStreamInfoStatus('alpha')).kind).toBe('live');
    expect(sentAt[1] - sentAt[0]).toBe(3000);
  });

  test('unsupported persisted queries have shared bounded refresh and deferred rechecks', async () => {
    respond = () => gqlError('PersistedQueryNotFound');
    const failed = await client.getStreamInfoStatus('alpha');
    expect(failed).toMatchObject({ kind: 'unknown', category: 'stale_query' });
    expect(requests.length).toBe(2);
    expect(versionRequests).toBe(1);
    for (let i = 0; i < 20; i++) await client.getStreamInfoStatus(`channel-${i}`);
    expect(requests.length).toBe(2);
    expect(versionRequests).toBe(1);
    now = retryAt(failed);
    const firstProbe = client.getStreamInfoStatus('alpha');
    const secondProbe = client.getStreamInfoStatus('beta');
    await Promise.all([firstProbe, secondProbe]);
    expect(requests.length).toBe(3);
    expect(versionRequests).toBe(2);
    expect(retryAt(await client.getStreamInfoStatus('gamma')) - now).toBe(600_000);
  });

  test('mixed auth failures are not retried, even after four transient messages', async () => {
    respond = () =>
      Response.json({
        errors: [
          { message: 'service timeout' },
          { message: 'service unavailable' },
          { message: 'context deadline exceeded' },
          { message: 'service error' },
          { message: 'Unauthorized' }
        ]
      });
    expect(await client.getStreamInfoStatus('alpha')).toMatchObject({ kind: 'unknown', category: 'auth' });
    expect(requests.length).toBe(1);
  });

  test('does not retry arbitrary application exceptions or ambiguous mutations', async () => {
    respond = () => {
      throw new TypeError('Invalid request construction');
    };
    expect(await client.getStreamInfoStatus('alpha')).toMatchObject({ kind: 'unknown', category: 'fatal' });
    expect(requests.length).toBe(1);
    respond = () => new Response('', { status: 503 });
    expect(await client.claimBonus('123', 'claim')).toMatchObject({ ok: false, reason: 'gql_error' });
    expect(requests.length).toBe(2);
    await client.claimBonus('456', 'other-claim');
    expect(requests.length).toBe(2);
  });

  test('missing or malformed stream data stays unknown; only explicit null is offline', async () => {
    for (const data of [undefined, null, {}, { user: {} }, { user: { stream: {} } }]) {
      respond = () => Response.json({ data });
      expect((await client.getStreamInfoStatus('alpha')).kind).toBe('unknown');
    }
    for (const data of [{ user: null }, { user: { stream: null } }]) {
      respond = () => Response.json({ data });
      expect(await client.getStreamInfoStatus('alpha')).toEqual({ kind: 'offline' });
    }
  });

  test('returns the streamer profile with stream status', async () => {
    const user = { displayName: 'Alpha', profileImageURL: 'https://example.com/alpha.png', stream: null };
    respond = () => Response.json({ data: { user } });
    expect(await client.getStreamInfoStatus('alpha')).toEqual({
      kind: 'offline',
      profile: { displayName: 'Alpha', profileImageUrl: 'https://example.com/alpha.png' }
    });
  });
});

describe('GQL error classification', () => {
  test('classifies backend and persisted-query cache outages as transient', () => {
    for (const message of [
      'service unavailable',
      'PersistedQueryUnavailable',
      " Failed to fetch from Subgraph 'twitch.graphql.monolith'. "
    ]) {
      expect(classifyGqlErrors([{ message }])).toMatchObject({ category: 'transient', retryable: true });
    }
  });

  test('does not infer retryability from unrelated error words or embedded error names', () => {
    for (const message of [
      'Invalid subgraph query',
      'subgraph error',
      'Failed validation for subgraph selection',
      'Unexpected PersistedQueryUnavailable value',
      'Unexpected PersistedQueryNotFound value'
    ]) {
      expect(classifyGqlErrors([{ message }])).toMatchObject({ category: 'fatal', retryable: false });
    }
  });

  test('permanent errors dominate mixed transient or stale-query responses', () => {
    expect(
      classifyGqlErrors([{ message: 'PersistedQueryNotFound' }, { message: 'Invalid variable channel' }])
    ).toMatchObject({ category: 'fatal', retryable: false });
    expect(classifyGqlErrors([{ message: 'service unavailable' }, { message: 'Forbidden' }])).toMatchObject({
      category: 'auth',
      retryable: false
    });
  });
});

describe('Retry-After parsing', () => {
  test('handles delta seconds and HTTP dates without allowing negative or malformed delays', () => {
    expect(parseRetryAfterMs(' 120 ', now)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(now + 60_000).toUTCString(), now)).toBe(60_000);
    for (const value of [
      null,
      '',
      '-5',
      '1.5',
      '+5',
      '1e3',
      '0x10',
      '120garbage',
      'NaN',
      'Infinity',
      'not a date',
      '2026-09-06T00:00:00Z',
      'Tue, 31 Feb 2026 00:00:00 GMT',
      new Date(now - 1000).toUTCString()
    ]) {
      expect(parseRetryAfterMs(value, now)).toBe(0);
    }
  });

  test('accepts legacy HTTP dates in UTC and resolves two-digit years before validating weekdays', () => {
    const epoch = Date.UTC(1994, 10, 6, 8, 49, 0);
    expect(parseRetryAfterMs('Sunday, 06-Nov-94 08:49:37 GMT', epoch)).toBe(37_000);
    expect(parseRetryAfterMs('Sun Nov  6 08:49:37 1994', epoch)).toBe(37_000);
    const future = Date.UTC(2060, 0, 1);
    expect(parseRetryAfterMs('Thursday, 01-Jan-60 00:00:00 GMT', now)).toBe(future - now);
  });
});
