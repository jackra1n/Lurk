<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Link from '@lucide/svelte/icons/link';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { AuthStatusResponse } from '../shared/types';

	let {
		authStatus,
		loadingStartAfterAuth = false,
		onAuthStatusChange
	}: {
		authStatus: AuthStatusResponse;
		loadingStartAfterAuth?: boolean;
		onAuthStatusChange?: () => void | Promise<void>;
	} = $props();

	let authModalOpen = $state(false);
	let loadingAuthAction = $state(false);
	let authActionError = $state<string | null>(null);

	const authBadgeLabel = () => {
		if (authStatus.authenticated) return 'Connected';
		if (authStatus.pendingLogin) return 'Connecting';
		return 'Auth';
	};

	const authStatusDotClass = () => {
		if (authStatus.authenticated) return 'bg-emerald-500';
		if (authStatus.pendingLogin) return 'bg-amber-400';
		return 'bg-red-500';
	};

	const tooltipText = () => {
		if (authStatus.authenticated) {
			const account = authStatus.username ?? authStatus.userId;
			return account
				? `Connected as ${account}. Press to manage connection.`
				: 'Connected to Twitch. Press to manage connection.';
		}

		if (authStatus.pendingLogin) {
			return 'Authentication in progress. Press to continue.';
		}

		return 'Press to start authentication.';
	};

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
	};

	const timeRemainingText = () => {
		if (!authStatus.expiresAt) return null;

		const expiresAtMs = new Date(authStatus.expiresAt).getTime();
		if (Number.isNaN(expiresAtMs)) return null;

		const remainingMs = expiresAtMs - Date.now();
		if (remainingMs <= 0) return 'expired';

		const totalSeconds = Math.floor(remainingMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		return `${minutes}m ${seconds}s`;
	};

	const openAuthModal = () => {
		authModalOpen = true;
	};

	const runAuthAction = async (action: 'startLogin' | 'cancelLogin' | 'logout') => {
		loadingAuthAction = true;
		authActionError = null;

		try {
			await postAuthAction(action);
			await onAuthStatusChange?.();
		} catch (error) {
			authActionError = error instanceof Error ? error.message : `Failed to ${action}`;
		} finally {
			loadingAuthAction = false;
		}
	};

	const startLogin = () => runAuthAction('startLogin');
	const cancelLogin = () => runAuthAction('cancelLogin');
	const logout = () => runAuthAction('logout');
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger
			type="button"
			class="inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
			onclick={openAuthModal}
			aria-label="Open authentication panel"
		>
			<span class={`size-2 rounded-full ${authStatusDotClass()}`} aria-hidden="true"></span>
			<span>{authBadgeLabel()}</span>
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" sideOffset={8}>
			{tooltipText()}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>

<Dialog.Root bind:open={authModalOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				{#if authStatus.authenticated}
					<CircleCheck class="size-4 text-emerald-500" />
				{:else if authStatus.pendingLogin}
					<LoaderCircle class="size-4 animate-spin text-amber-400" />
				{:else}
					<CircleAlert class="size-4 text-red-500" />
				{/if}
				Twitch Authentication
			</Dialog.Title>
			<Dialog.Description>
				{#if authStatus.authenticated}
					Your Twitch account is connected.
				{:else if authStatus.pendingLogin}
					Finish authentication on Twitch using the activation code below.
				{:else}
					Connect your Twitch account to enable mining.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3">
			{#if authActionError}
				<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{authActionError}
				</p>
			{/if}

			{#if authStatus.pendingLogin}
				<div class="rounded-lg border border-border/70 bg-background/60 p-3">
					<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Twitch Activation Code</p>
					<p class="mt-2 font-mono text-2xl font-semibold tracking-[0.2em]">{authStatus.userCode ?? '----'}</p>
					{#if timeRemainingText()}
						<p class="mt-2 text-sm text-muted-foreground">Expires in {timeRemainingText()}</p>
					{/if}
				</div>

				<div class="flex flex-col gap-2">
					<Button
						href={authStatus.verificationUri ?? 'https://www.twitch.tv/activate'}
						target="_blank"
						rel="noreferrer"
						class="w-full"
					>
						<ExternalLink class="size-4" />
						Open Twitch Activate
					</Button>
					<Button
						type="button"
						variant="outline"
						class="w-full"
						disabled={loadingAuthAction || loadingStartAfterAuth}
						onclick={cancelLogin}
					>
						{loadingAuthAction ? 'Cancelling...' : 'Cancel Login'}
					</Button>
				</div>
			{:else if authStatus.authenticated}
				<div class="rounded-lg border border-border/70 bg-background/60 p-3">
					<p class="text-sm text-muted-foreground">Connected account</p>
					<p class="mt-1 text-sm font-medium">{authStatus.username ?? authStatus.userId ?? 'Twitch user'}</p>
				</div>
				<Dialog.Footer>
					<Button
						type="button"
						variant="outline"
						class="w-full sm:w-auto"
						disabled={loadingAuthAction || loadingStartAfterAuth}
						onclick={logout}
					>
						<LogOut class="size-4" />
						{loadingAuthAction ? 'Disconnecting...' : 'Disconnect'}
					</Button>
				</Dialog.Footer>
			{:else}
				<Dialog.Footer>
					<Button
						type="button"
						class="w-full sm:w-auto"
						disabled={loadingAuthAction || loadingStartAfterAuth}
						onclick={startLogin}
					>
						<Link class="size-4" />
						{loadingAuthAction ? 'Connecting...' : 'Connect Twitch'}
					</Button>
				</Dialog.Footer>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
