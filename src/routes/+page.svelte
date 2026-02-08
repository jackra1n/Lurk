<script lang="ts">
	import { onMount } from 'svelte';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { Button } from '$lib/components/ui/button';
	import AuthenticationCard from '$lib/components/dashboard/authentication-card.svelte';
	import QuickActionsCard from '$lib/components/dashboard/quick-actions-card.svelte';
	import StatusSummaryCards from '$lib/components/dashboard/status-summary-cards.svelte';
	import TrackedStreamersCard from '$lib/components/dashboard/tracked-streamers-card.svelte';
	import type {
		AuthStatusResponse,
		LifecycleReason,
		MinerLifecycle,
		MinerStatusResponse
	} from '$lib/components/dashboard/types';

	const themeStorageKey = 'theme';
	const fastPollMs = 2000;
	const slowPollMs = 10000;
	const lifecycleValues: MinerLifecycle[] = ['running', 'ready', 'auth_required', 'authenticating', 'error'];
	const reasonValues: Exclude<LifecycleReason, null>[] = ['missing_token', 'invalid_token', 'auth_pending', 'startup_failed'];

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
		configuredStreamers: []
	};

	const quickActions = ['Start Miner', 'Add Streamer'];
	let isDark = $state(true);
	let authStatus = $state<AuthStatusResponse>(defaultAuthStatus);
	let minerStatus = $state<MinerStatusResponse>(defaultMinerStatus);
	let loadingAuthAction = $state(false);
	let loadingStartAfterAuth = $state(false);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let pollIntervalMs = $state(slowPollMs);

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

		return {
			running: Boolean((payload as { running?: unknown }).running),
			lifecycle: isLifecycle(nextLifecycle) ? nextLifecycle : 'auth_required',
			reason: isReason(nextReason) ? nextReason : null,
			configuredStreamers: Array.isArray(configuredStreamers)
				? configuredStreamers.filter((value): value is string => typeof value === 'string')
				: []
		} satisfies MinerStatusResponse;
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

	const postAuthAction = async (action: 'startLogin' | 'cancelLogin' | 'logout') => {
		const response = await fetch('/api/auth', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ action })
		});
		const payload = await readJson(response);

		if (!response.ok || !(payload && typeof payload === 'object' && (payload as { success?: unknown }).success)) {
			throw new Error(getErrorMessage(payload, `Failed to ${action}`));
		}

		return payload;
	};

	const startMinerAfterAuth = async () => {
		loadingStartAfterAuth = true;

		try {
			const response = await fetch('/api/miner', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ action: 'start' })
			});
			const payload = await readJson(response);

			if (!response.ok || !(payload && typeof payload === 'object' && (payload as { success?: unknown }).success)) {
				throw new Error(getErrorMessage(payload, 'Failed to start miner'));
			}

			message = 'Miner started successfully.';
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start miner';
		} finally {
			loadingStartAfterAuth = false;
			try {
				await refreshAllStatus({ autoStart: false });
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Failed to refresh status';
			}
		}
	};

	const startLogin = async () => {
		loadingAuthAction = true;
		errorMessage = null;
		message = null;

		try {
			autoStartAttempted = false;
			await postAuthAction('startLogin');
			message = 'Enter the code on Twitch to complete login.';
			await refreshAllStatus({ autoStart: false });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start login';
		} finally {
			loadingAuthAction = false;
		}
	};

	const cancelLogin = async () => {
		loadingAuthAction = true;
		errorMessage = null;
		message = null;

		try {
			await postAuthAction('cancelLogin');
			message = 'Login cancelled.';
			await refreshAllStatus({ autoStart: false });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to cancel login';
		} finally {
			loadingAuthAction = false;
		}
	};

	const logout = async () => {
		loadingAuthAction = true;
		errorMessage = null;
		message = null;

		try {
			autoStartAttempted = false;
			await postAuthAction('logout');
			message = 'Logged out.';
			await refreshAllStatus({ autoStart: false });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to logout';
		} finally {
			loadingAuthAction = false;
		}
	};
</script>

<svelte:head>
	<title>Lurk | Control Surface</title>
</svelte:head>

<div class="relative min-h-screen overflow-hidden bg-background text-foreground">
	<main class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
		<header class="flex items-center justify-between gap-3">
			<h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Lurk</h1>
			<Button type="button" variant="outline" size="sm" onclick={toggleTheme}>
				{#if isDark}
					<Moon class="size-4" />
				{:else}
					<Sun class="size-4" />
				{/if}
				{isDark ? 'Dark' : 'Light'}
			</Button>
		</header>

		<StatusSummaryCards
			{authStatus}
			{minerStatus}
		/>

		<section class="grid gap-4 lg:grid-cols-[2fr_1fr]">
			<TrackedStreamersCard trackedStreamerCount={minerStatus.configuredStreamers.length} />

			<AuthenticationCard
				{authStatus}
				minerReason={minerStatus.reason}
				{errorMessage}
				{message}
				{loadingAuthAction}
				{loadingStartAfterAuth}
				onStartLogin={startLogin}
				onCancelLogin={cancelLogin}
				onLogout={logout}
			/>
		</section>

		<QuickActionsCard actions={quickActions} />
	</main>
</div>
