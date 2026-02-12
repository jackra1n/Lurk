<script lang="ts">
	import Github from '@lucide/svelte/icons/github';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import HeaderSection from '../header/HeaderSection.svelte';
	import PointsOverview from '../channel-points/PointsOverview.svelte';
	import QuickActionsCard from '../quick-actions/QuickActionsCard.svelte';
	import SummaryCardsSection from '../summary-cards/SummaryCardsSection.svelte';
	import type {
		AuthStatusResponse,
		ChannelPointsAnalyticsResponse,
		ChannelPointsControlChange,
		ChannelPointsControls,
		ChannelPointsSortBy,
		LifecycleReason,
		MinerLifecycle,
		MinerStatusResponse,
		SortDir
	} from '../shared/types';

	const themeStorageKey = 'theme';
	const fastPollMs = 2000;
	const slowPollMs = 10000;
	const lifecycleValues: MinerLifecycle[] = [
		'starting',
		'running',
		'ready',
		'auth_required',
		'authenticating',
		'error'
	];
	const reasonValues: Exclude<LifecycleReason, null>[] = ['missing_token', 'invalid_token', 'auth_pending', 'startup_failed'];
	const defaultAnalyticsRangeMs = 24 * 60 * 60 * 1000;
	const initialAnalyticsRangeToMs = Date.now();

	const defaultAuthStatus: AuthStatusResponse = {
		authenticated: false,
		userId: null,
		username: null,
		pendingLogin: false,
		userCode: null,
		verificationUri: null,
		expiresAt: null
	};

	const defaultMinerStatus: MinerStatusResponse = {
		running: false,
		lifecycle: 'auth_required',
		reason: 'missing_token',
		configuredStreamers: [],
		streamerRuntimeStates: []
	};

	let isDark = $state(true);
	let authStatus = $state<AuthStatusResponse>(defaultAuthStatus);
	let minerStatus = $state<MinerStatusResponse>(defaultMinerStatus);
	let loadingStartAfterAuth = $state(false);
	let loadingMinerAction = $state(false);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let analytics = $state<ChannelPointsAnalyticsResponse | null>(null);
	let analyticsLoading = $state(false);
	let analyticsErrorMessage = $state<string | null>(null);
	let analyticsSortBy = $state<ChannelPointsSortBy>('lastActive');
	let analyticsSortDir = $state<SortDir>('desc');
	let analyticsRangeToMs = $state(initialAnalyticsRangeToMs);
	let analyticsRangeFromMs = $state(initialAnalyticsRangeToMs - defaultAnalyticsRangeMs);
	let selectedStreamerLogin = $state<string | null>(null);
	let pollIntervalMs = $state(slowPollMs);
	let minerActionIntent = $state<'start' | 'stop' | null>(null);
	let analyticsControls = $derived({
		sortBy: analyticsSortBy,
		sortDir: analyticsSortDir,
		rangeFromMs: analyticsRangeFromMs,
		rangeToMs: analyticsRangeToMs
	} satisfies ChannelPointsControls);
	let quickActionsActionPhase = $derived<'idle' | 'starting' | 'stopping'>(
		minerStatus.lifecycle === 'starting' ||
			loadingStartAfterAuth ||
			(loadingMinerAction && minerActionIntent === 'start')
			? 'starting'
			: loadingMinerAction && minerActionIntent === 'stop'
				? 'stopping'
				: 'idle'
	);
	let startMinerDisabled = $derived(
		loadingMinerAction ||
		loadingStartAfterAuth ||
		minerStatus.running ||
		minerStatus.lifecycle !== 'ready'
	);
	let stopMinerDisabled = $derived(loadingMinerAction || !minerStatus.running);
	let analyticsRequestSeq = 0;
	let analyticsLoadingRequestSeq = 0;

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let autoStartAttempted = false;

	onMount(() => {
		const root = document.documentElement;
		isDark = root.classList.contains('dark');

		refreshAllStatus().catch((error) => {
			errorMessage = error instanceof Error ? error.message : 'Failed to load status';
		});

		syncPolling();

		return () => {
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		};
	});

	const toggleTheme = () => {
		const root = document.documentElement;
		const nextIsDark = !root.classList.contains('dark');

		root.classList.toggle('dark', nextIsDark);
		root.style.colorScheme = nextIsDark ? 'dark' : 'light';
		localStorage.setItem(themeStorageKey, nextIsDark ? 'dark' : 'light');
		isDark = nextIsDark;
	};

	const isLifecycle = (value: unknown): value is MinerLifecycle =>
		typeof value === 'string' && lifecycleValues.includes(value as MinerLifecycle);

	const isReason = (value: unknown): value is LifecycleReason =>
		value === null || (typeof value === 'string' && reasonValues.includes(value as Exclude<LifecycleReason, null>));

	const getErrorMessage = (payload: unknown, fallback: string) => {
		if (!payload || typeof payload !== 'object') return fallback;
		const { message } = payload as { message?: unknown };
		return typeof message === 'string' && message.length > 0 ? message : fallback;
	};

	const readJson = async (response: Response) => {
		try {
			return await response.json();
		} catch {
			return null;
		}
	};

	const getSuccessMessage = (payload: { message?: unknown }, fallback: string) =>
		typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : fallback;

	const postMinerAction = async (action: 'start' | 'stop') => {
		const response = await fetch('/api/miner', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ action })
		});
		const payload = await readJson(response);
		const fallback = action === 'start' ? 'Failed to start miner' : 'Failed to stop miner';

		if (!response.ok || !(payload && typeof payload === 'object' && (payload as { success?: unknown }).success)) {
			throw new Error(getErrorMessage(payload, fallback));
		}

		return payload as { message?: unknown };
	};

	const fetchAuthStatus = async () => {
		const response = await fetch('/api/auth');
		const payload = await readJson(response);

		if (!response.ok || !payload || typeof payload !== 'object') {
			throw new Error(getErrorMessage(payload, 'Failed to fetch auth status'));
		}

		return {
			authenticated: Boolean((payload as { authenticated?: unknown }).authenticated),
			userId: typeof (payload as { userId?: unknown }).userId === 'string' ? (payload as { userId: string }).userId : null,
			username:
				typeof (payload as { username?: unknown }).username === 'string'
					? (payload as { username: string }).username
					: null,
			pendingLogin: Boolean((payload as { pendingLogin?: unknown }).pendingLogin),
			userCode:
				typeof (payload as { userCode?: unknown }).userCode === 'string'
					? (payload as { userCode: string }).userCode
					: null,
			verificationUri:
				typeof (payload as { verificationUri?: unknown }).verificationUri === 'string'
					? (payload as { verificationUri: string }).verificationUri
					: null,
			expiresAt:
				typeof (payload as { expiresAt?: unknown }).expiresAt === 'string'
					? (payload as { expiresAt: string }).expiresAt
					: null
		} satisfies AuthStatusResponse;
	};

	const fetchMinerStatus = async () => {
		const response = await fetch('/api/miner');
		const payload = await readJson(response);

		if (!response.ok || !payload || typeof payload !== 'object') {
			throw new Error(getErrorMessage(payload, 'Failed to fetch miner status'));
		}

		const nextLifecycle = (payload as { lifecycle?: unknown }).lifecycle;
		const nextReason = (payload as { reason?: unknown }).reason;
		const configuredStreamers = (payload as { configuredStreamers?: unknown }).configuredStreamers;
		const streamerRuntimeStates = (payload as { streamerRuntimeStates?: unknown }).streamerRuntimeStates;

		return {
			running: Boolean((payload as { running?: unknown }).running),
			lifecycle: isLifecycle(nextLifecycle) ? nextLifecycle : 'auth_required',
			reason: isReason(nextReason) ? nextReason : null,
			configuredStreamers: Array.isArray(configuredStreamers)
				? configuredStreamers.filter((value): value is string => typeof value === 'string')
				: [],
			streamerRuntimeStates: Array.isArray(streamerRuntimeStates)
				? streamerRuntimeStates.flatMap((value) => {
						if (!value || typeof value !== 'object') return [];
						const login = (value as { login?: unknown }).login;
						if (typeof login !== 'string') return [];
						return [
							{
								login,
								isOnline: Boolean((value as { isOnline?: unknown }).isOnline),
								isWatched: Boolean((value as { isWatched?: unknown }).isWatched)
							}
						];
					})
				: []
		} satisfies MinerStatusResponse;
	};

	const fetchChannelPointsAnalytics = async () => {
		const query = new URLSearchParams({
			from: String(analyticsRangeFromMs),
			to: String(analyticsRangeToMs),
			sortBy: analyticsSortBy,
			sortDir: analyticsSortDir
		});

		if (selectedStreamerLogin) {
			query.set('selectedStreamer', selectedStreamerLogin);
		}

		const response = await fetch(`/api/dashboard/channel-points?${query.toString()}`);
		const payload = await readJson(response);

		if (
			!response.ok ||
			!payload ||
			typeof payload !== 'object' ||
			!(payload as { success?: unknown }).success
		) {
			throw new Error(getErrorMessage(payload, 'Failed to fetch channel points analytics'));
		}

		return payload as ChannelPointsAnalyticsResponse;
	};

	const refreshAnalytics = async (showLoading = false) => {
		const requestSeq = ++analyticsRequestSeq;
		if (showLoading) {
			analyticsLoading = true;
			analyticsLoadingRequestSeq = requestSeq;
		}

		try {
			const nextAnalytics = await fetchChannelPointsAnalytics();
			if (requestSeq !== analyticsRequestSeq) return;
			analytics = nextAnalytics;
			selectedStreamerLogin = nextAnalytics.selectedStreamerLogin;
			analyticsErrorMessage = null;
		} catch (error) {
			if (requestSeq !== analyticsRequestSeq) return;
			analyticsErrorMessage =
				error instanceof Error ? error.message : 'Failed to fetch channel points analytics';
		} finally {
			if (showLoading && requestSeq === analyticsLoadingRequestSeq) analyticsLoading = false;
		}
	};

	const getDesiredPollInterval = () =>
		authStatus.pendingLogin || minerStatus.lifecycle === 'authenticating' ? fastPollMs : slowPollMs;

	const syncPolling = () => {
		const nextInterval = getDesiredPollInterval();
		pollIntervalMs = nextInterval;

		if (pollTimer) {
			clearInterval(pollTimer);
		}

		pollTimer = setInterval(() => {
			refreshAllStatus().catch((error) => {
				errorMessage = error instanceof Error ? error.message : 'Failed to refresh status';
			});
		}, nextInterval);
	};

	const refreshAllStatus = async (options?: { autoStart?: boolean }) => {
		const autoStart = options?.autoStart ?? true;
		const wasPendingLogin = authStatus.pendingLogin;
		const [nextAuthStatus, nextMinerStatus] = await Promise.all([fetchAuthStatus(), fetchMinerStatus()]);

		authStatus = nextAuthStatus;
		minerStatus = nextMinerStatus;
		await refreshAnalytics();

		if (!nextAuthStatus.authenticated) {
			autoStartAttempted = false;
		}

		if (getDesiredPollInterval() !== pollIntervalMs) {
			syncPolling();
		}

		const justFinishedAuth = wasPendingLogin && !nextAuthStatus.pendingLogin && nextAuthStatus.authenticated;
		const shouldStartMiner = autoStart && justFinishedAuth && !nextMinerStatus.running && !autoStartAttempted;

		if (shouldStartMiner) {
			autoStartAttempted = true;
			message = 'Authentication complete. Starting miner...';
			await startMinerAfterAuth();
		}
	};

	const startMinerAfterAuth = async () => {
		minerActionIntent = 'start';
		loadingStartAfterAuth = true;

		try {
			const payload = await postMinerAction('start');
			message = getSuccessMessage(payload, 'Miner started successfully.');
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start miner';
		} finally {
			loadingStartAfterAuth = false;
			await refreshStatus();
			minerActionIntent = null;
		}
	};

	const refreshStatus = async () => {
		try {
			await refreshAllStatus({ autoStart: false });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to refresh status';
		}
	};

	const handleStartMiner = async () => {
		if (startMinerDisabled) return;
		minerActionIntent = 'start';
		loadingMinerAction = true;

		try {
			const payload = await postMinerAction('start');
			message = getSuccessMessage(payload, 'Miner started successfully.');
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start miner';
		} finally {
			loadingMinerAction = false;
			await refreshStatus();
			minerActionIntent = null;
		}
	};

	const handleStopMiner = async () => {
		if (stopMinerDisabled) return;
		minerActionIntent = 'stop';
		loadingMinerAction = true;

		try {
			const payload = await postMinerAction('stop');
			message = getSuccessMessage(payload, 'Miner stopped.');
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to stop miner';
		} finally {
			loadingMinerAction = false;
			await refreshStatus();
			minerActionIntent = null;
		}
	};

	const handleChannelPointsControlChange = async (change: ChannelPointsControlChange) => {
		if (change.type === 'sortBy') {
			if (analyticsSortBy === change.value) return;
			analyticsSortBy = change.value;
			await refreshAnalytics(true);
			return;
		}

		if (change.type === 'toggleSortDir') {
			analyticsSortDir = analyticsSortDir === 'asc' ? 'desc' : 'asc';
			await refreshAnalytics(true);
			return;
		}

		if (change.type === 'selectStreamer') {
			if (selectedStreamerLogin === change.login) return;
			selectedStreamerLogin = change.login;
			await refreshAnalytics(true);
			return;
		}

		if (analyticsRangeFromMs === change.fromMs && analyticsRangeToMs === change.toMs) return;
		analyticsRangeFromMs = change.fromMs;
		analyticsRangeToMs = change.toMs;
		await refreshAnalytics(true);
	};
</script>

<div class="relative flex min-h-screen flex-col overflow-hidden bg-background text-foreground">
	<main class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
		<HeaderSection
			{authStatus}
			{loadingStartAfterAuth}
			{isDark}
			onAuthStatusChange={refreshStatus}
			onToggleTheme={toggleTheme}
		/>

		{#if errorMessage}
			<p class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{errorMessage}
			</p>
		{:else if message}
			<p class="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
				{message}
			</p>
		{/if}

		<SummaryCardsSection {minerStatus} summary={analytics?.summary ?? null} />

		<section>
			<PointsOverview
				{analytics}
				loading={analyticsLoading}
				errorMessage={analyticsErrorMessage}
				controls={analyticsControls}
				streamerRuntimeStates={minerStatus.streamerRuntimeStates}
				minerRunning={minerStatus.running}
				onControlChange={handleChannelPointsControlChange}
			/>
		</section>

		<QuickActionsCard
			minerRunning={minerStatus.running}
			lifecycle={minerStatus.lifecycle}
			startDisabled={startMinerDisabled}
			stopDisabled={stopMinerDisabled}
			actionPhase={quickActionsActionPhase}
			onStart={handleStartMiner}
			onStop={handleStopMiner}
		/>
	</main>

	<footer class="border-t border-border/60">
		<div class="mx-auto flex w-full max-w-6xl justify-center px-4 py-4 sm:justify-end sm:px-6 lg:px-8">
			<Button
				href="https://github.com/jackra1n/Lurk"
				target="_blank"
				rel="noreferrer noopener"
				variant="ghost"
				size="sm"
				class="text-muted-foreground hover:text-foreground"
				aria-label="Open Lurk source code on GitHub"
			>
				<Github class="size-4" />
				Source Code
			</Button>
		</div>
	</footer>
</div>
