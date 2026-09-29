// Regenerates docs/images/preview.png from a simulated week of fake streamers.
// Usage: bun scripts/generate-preview.ts (needs Chromium: bunx playwright install chromium)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Route } from 'playwright';

const outputPath = join(import.meta.dir, '../docs/images/preview.png');
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const simulatedDays = 8;
const watchSlots = 2;

interface FakeStreamer {
  displayName: string;
  game: string;
  title: string;
  viewers: number;
  balance: number;
  startedHoursAgo: number;
  hours: number;
  pointsDisabled?: boolean;
}

// Config order is watch priority. Schedules are relative to now, so the same streamers are live in every run.
const fakeStreamers: FakeStreamer[] = [
  {
    displayName: 'Flumbix',
    game: 'Just Chatting',
    title: 'morning coffee & chat',
    viewers: 8421,
    balance: 368_712,
    startedHoursAgo: 2.5,
    hours: 7
  },
  {
    displayName: 'Zorplin',
    game: 'Counter-Strike',
    title: 'faceit grind to lvl 10',
    viewers: 3120,
    balance: 156_998,
    startedHoursAgo: 5,
    hours: 4
  },
  {
    displayName: 'Quindlef',
    game: 'Minecraft',
    title: 'hardcore day 212',
    viewers: 1954,
    balance: 313_896,
    startedHoursAgo: 1.2,
    hours: 5
  },
  {
    displayName: 'Snarvoo',
    game: 'Elden Ring',
    title: 'no hit run attempts',
    viewers: 12_400,
    balance: 126_864,
    startedHoursAgo: 9,
    hours: 6
  },
  {
    displayName: 'Blimzak',
    game: 'Apex Legends',
    title: 'ranked with the squad',
    viewers: 764,
    balance: 1_074_288,
    startedHoursAgo: 0.8,
    hours: 3
  },
  {
    displayName: 'Trevnoz',
    game: 'League of Legends',
    title: 'challenger climb',
    viewers: 5230,
    balance: 1_918_972,
    startedHoursAgo: 14,
    hours: 8
  },
  {
    displayName: 'Wobbleton',
    game: 'IRL',
    title: 'walking around the city',
    viewers: 2210,
    balance: 48_150,
    startedHoursAgo: 20,
    hours: 10
  },
  {
    displayName: 'Kraznik',
    game: 'Valorant',
    title: 'radiant or bust',
    viewers: 980,
    balance: 7_340,
    startedHoursAgo: 0.5,
    hours: 6,
    pointsDisabled: true
  },
  {
    displayName: 'Mellowdrift',
    game: 'Music',
    title: 'lofi production session',
    viewers: 430,
    balance: 92_615,
    startedHoursAgo: 11,
    hours: 5
  },
  {
    displayName: 'Pixelgrove',
    game: 'Art',
    title: 'painting commissions',
    viewers: 318,
    balance: 21_900,
    startedHoursAgo: 4,
    hours: 2.5
  },
  {
    displayName: 'Vantorra',
    game: 'Just Chatting',
    title: '24h subathon',
    viewers: 15_870,
    balance: 604_455,
    startedHoursAgo: 6,
    hours: 12
  },
  {
    displayName: 'Glimmerfox',
    game: 'Stardew Valley',
    title: 'cozy farming',
    viewers: 640,
    balance: 38_020,
    startedHoursAgo: 17,
    hours: 4
  }
];

let seed = 1738;
const random = () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
  return seed / 2 ** 32;
};

const avatar = (name: string, index: number) => {
  const hue = Math.round((index * 137.5) % 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 75% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 70% 40%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="700" text-anchor="middle" fill="white">${name[0]}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const dataDir = mkdtempSync(join(tmpdir(), 'lurk-preview-'));
process.env.LURK_DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'warn';

const streamers = fakeStreamers.map((streamer, index) => ({
  ...streamer,
  login: streamer.displayName.toLowerCase(),
  channelId: String(100_000 + index),
  sessions: Array.from({ length: simulatedDays + 1 }, (_, day) => {
    const fromMs =
      Date.now() - day * dayMs - streamer.startedHoursAgo * hourMs + (day === 0 ? 0 : (random() - 0.5) * hourMs);
    const toMs = fromMs + streamer.hours * hourMs + (day === 0 ? 0 : (random() - 0.5) * 2 * hourMs);
    return { fromMs, toMs, id: `${index}-${day}`, active: day <= 1 || random() < 0.8 };
  }).filter((session) => session.active)
}));

writeFileSync(
  join(dataDir, 'config.json'),
  JSON.stringify({ streamers: streamers.map((streamer) => streamer.login), autoStartMiner: false })
);

const { eventStore } = await import('../src/lib/server/db/events');
const { setStreamerChannelPointsState, setStreamerProfile } = await import('../src/lib/server/db/streamers');
const { getDashboardSummary } = await import('../src/lib/server/db/summary');
const { getStreamerActivity } = await import('../src/lib/server/db/streamer-activity');
const { getChannelPointsAnalytics } = await import('../src/lib/server/db/dashboard');

const simulate = () => {
  const nowMs = Math.floor(Date.now() / minuteMs) * minuteMs;
  const live = new Map<string, { fromMs: number; broadcastId: string; streakChance: number }>();
  const watched = new Map<string, number>();
  const balances = new Map(streamers.map((streamer) => [streamer.login, streamer.balance]));

  eventStore.startRun({ startReason: 'started', username: 'lurker' });

  for (let t = nowMs - simulatedDays * dayMs; t <= nowMs; t += minuteMs) {
    for (const streamer of streamers) {
      const ref = { login: streamer.login, channelId: streamer.channelId };
      const session = streamer.sessions.find((item) => item.fromMs <= t && t < item.toMs);
      const current = live.get(streamer.login);

      if (session && !current) {
        live.set(streamer.login, { fromMs: t, broadcastId: session.id, streakChance: random() });
        eventStore.recordEvent({
          streamer: ref,
          eventType: 'stream_up',
          source: 'gql_stream',
          occurredAtMs: t,
          broadcastId: session.id,
          title: streamer.title,
          gameName: streamer.game,
          viewersCount: streamer.viewers
        });
      } else if (!session && current) {
        live.delete(streamer.login);
        eventStore.recordEvent({ streamer: ref, eventType: 'stream_down', source: 'pubsub', occurredAtMs: t });
      }
    }

    const nextWatched = streamers
      .filter((streamer) => {
        const stream = live.get(streamer.login);
        return stream !== undefined && stream.fromMs < t && !streamer.pointsDisabled;
      })
      .slice(0, watchSlots);

    for (const [login] of watched) {
      if (nextWatched.some((streamer) => streamer.login === login)) continue;
      watched.delete(login);
      eventStore.recordEvent({ streamer: { login }, eventType: 'watch_stopped', source: 'system', occurredAtMs: t });
    }

    for (const streamer of nextWatched) {
      const ref = { login: streamer.login, channelId: streamer.channelId };
      const stream = live.get(streamer.login);
      if (!stream) continue;

      if (!watched.has(streamer.login)) {
        watched.set(streamer.login, t);
        eventStore.recordEvent({ streamer: ref, eventType: 'watch_started', source: 'system', occurredAtMs: t });
      }

      const watchedMinutes = (t - (watched.get(streamer.login) ?? t)) / minuteMs;
      const earn = (reasonCode: string, pointsDelta: number) => {
        const balanceAfter = (balances.get(streamer.login) ?? 0) + pointsDelta;
        balances.set(streamer.login, balanceAfter);
        eventStore.recordEvent({
          streamer: ref,
          eventType: 'points_earned',
          source: 'pubsub',
          occurredAtMs: t,
          reasonCode,
          pointsDelta,
          balanceAfter
        });
      };

      if (watchedMinutes > 0 && watchedMinutes % 5 === 0) earn('WATCH', 10);
      if (watchedMinutes % 15 === 7) earn('CLAIM', 50);
      if (watchedMinutes === 6 && t - stream.fromMs < 15 * minuteMs && stream.streakChance < 0.5) {
        earn('WATCH_STREAK', 450);
      }
    }
  }

  streamers.forEach((streamer, index) => {
    const ref = { login: streamer.login, channelId: streamer.channelId };
    setStreamerProfile(ref, {
      displayName: streamer.displayName,
      profileImageUrl: avatar(streamer.displayName, index)
    });
    setStreamerChannelPointsState(ref, {
      status: streamer.pointsDisabled ? 'disabled' : 'enabled',
      checkedAtMs: nowMs
    });
  });

  return {
    onlineLogins: new Set(live.keys()),
    watchedLogins: new Set(watched.keys()),
    startedAtMs: nowMs - 26 * hourMs
  };
};

const startServer = async (port: number) => {
  const root = join(import.meta.dir, '..');
  const server = Bun.spawn(
    [process.execPath, join(root, 'node_modules/vite/bin/vite.js'), 'dev', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      env: { ...process.env, LURK_DATA_DIR: dataDir, LOG_LEVEL: 'warn' },
      stdout: 'ignore',
      stderr: 'inherit'
    }
  );

  for (let attempt = 0; attempt < 60; attempt++) {
    const healthy = await fetch(`http://localhost:${port}/api/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return server;
    await Bun.sleep(500);
  }

  server.kill();
  throw new Error('Dev server did not start');
};

const getFreePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 4173;
  probe.stop(true);
  return port;
};

const { onlineLogins, watchedLogins, startedAtMs } = simulate();
const port = getFreePort();
const server = await startServer(port);
const browser = await chromium.launch();

const apiResponses: Record<string, (url: URL) => unknown> = {
  '/api/auth': () => ({
    authenticated: true,
    userId: '1',
    username: 'lurker',
    pendingLogin: false,
    userCode: null,
    verificationUri: null,
    expiresAt: null
  }),
  '/api/miner': () => ({
    running: true,
    lifecycle: 'running',
    reason: null,
    startedAt: new Date(startedAtMs).toISOString(),
    configuredStreamers: streamers.map((streamer) => streamer.login),
    streamers: streamers.map((streamer) => ({
      name: streamer.login,
      channelPointsStatus: streamer.pointsDisabled ? 'disabled' : 'enabled'
    })),
    streamerRuntimeStates: streamers.map((streamer) => ({
      login: streamer.login,
      isOnline: onlineLogins.has(streamer.login),
      isWatched: watchedLogins.has(streamer.login)
    }))
  }),
  '/api/dashboard/summary': () => ({
    success: true,
    ...getDashboardSummary(
      streamers
        .filter((streamer) => watchedLogins.has(streamer.login))
        .map(({ login, game, title, viewers }) => ({ login, game, title, viewers }))
    )
  }),
  '/api/dashboard/streamer-activity': () => ({
    success: true,
    days: 7,
    ...getStreamerActivity({ days: 7, onlineLogins, watchedLogins })
  }),
  '/api/dashboard/channel-points': (url) => {
    const fromMs = Number(url.searchParams.get('from'));
    const toMs = Number(url.searchParams.get('to'));
    const sortBy = (url.searchParams.get('sortBy') ?? 'lastWatched') as 'lastWatched';
    const sortDir = (url.searchParams.get('sortDir') ?? 'desc') as 'desc';
    return {
      success: true,
      range: { fromMs, toMs },
      sort: { by: sortBy, dir: sortDir },
      ...getChannelPointsAnalytics({
        fromMs,
        toMs,
        sortBy,
        sortDir,
        onlineStreamers: onlineLogins,
        watchedStreamers: watchedLogins,
        selectedStreamerLogin: url.searchParams.get('selectedStreamer')
      })
    };
  }
};

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.route('**/api/**', (route: Route) => {
    const url = new URL(route.request().url());
    const response = apiResponses[url.pathname];
    return response ? route.fulfill({ json: response(url) }) : route.continue();
  });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
  // A fullPage capture resizes the viewport mid-shot, which restarts the chart's tween animation.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1200, height });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: outputPath });
  console.log(`Saved ${outputPath}`);
} finally {
  await browser.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
