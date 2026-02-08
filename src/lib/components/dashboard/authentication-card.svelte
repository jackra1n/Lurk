<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { AuthStatusResponse, LifecycleReason } from './types';

	let {
		authStatus,
		minerReason,
		errorMessage,
		message,
		loadingAuthAction,
		loadingStartAfterAuth,
		onStartLogin,
		onCancelLogin,
		onLogout
	}: {
		authStatus: AuthStatusResponse;
		minerReason: LifecycleReason;
		errorMessage: string | null;
		message: string | null;
		loadingAuthAction: boolean;
		loadingStartAfterAuth: boolean;
		onStartLogin: () => void | Promise<void>;
		onCancelLogin: () => void | Promise<void>;
		onLogout: () => void | Promise<void>;
	} = $props();

	const authLabel = () => {
		if (authStatus.authenticated) return 'Connected';
		if (authStatus.pendingLogin) return 'Awaiting Confirmation';
		return 'Not Connected';
	};

	const authStatusDotClass = () => {
		if (authStatus.authenticated) return 'bg-emerald-500';
		if (authStatus.pendingLogin) return 'bg-amber-400';
		return 'bg-red-500';
	};

	const minerReasonText = () => {
		if (!minerReason) return null;
		return minerReason.replace(/_/g, ' ');
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
</script>

<Card class="bg-card/80">
	<CardHeader>
		<CardTitle class="text-lg">Authentication</CardTitle>
		<CardDescription class="text-sm">Connect your Twitch account to enable mining.</CardDescription>
	</CardHeader>
	<CardContent class="space-y-3">
		<div class="flex items-center gap-2 text-sm">
			<span class={`size-2.5 rounded-full ${authStatusDotClass()}`} aria-hidden="true"></span>
			<span class="font-medium">{authLabel()}</span>
			{#if authStatus.authenticated && (authStatus.username || authStatus.userId)}
				<span class="text-muted-foreground">as {authStatus.username ?? authStatus.userId}</span>
			{/if}
		</div>

		{#if errorMessage}
			<p class="text-sm text-destructive">{errorMessage}</p>
		{/if}
		{#if message}
			<p class="text-sm text-muted-foreground">{message}</p>
		{/if}
		{#if minerReason && minerReasonText()}
			<p class="text-xs text-muted-foreground">Status detail: {minerReasonText()}.</p>
		{/if}

		{#if authStatus.pendingLogin}
			<div class="rounded-lg border border-border/70 bg-background/70 p-3">
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
					Open Twitch Activate
				</Button>
				<Button
					type="button"
					variant="outline"
					class="w-full"
					disabled={loadingAuthAction}
					onclick={onCancelLogin}
				>
					{loadingAuthAction ? 'Cancelling...' : 'Cancel Login'}
				</Button>
			</div>
		{:else if authStatus.authenticated}
			<div class="rounded-lg border border-border/70 bg-background/70 p-3">
				<p class="text-sm text-muted-foreground">Connected account</p>
				<p class="mt-1 text-sm font-medium">{authStatus.username ?? authStatus.userId ?? 'Twitch user'}</p>
			</div>
			<Button
				type="button"
				variant="outline"
				class="w-full"
				disabled={loadingAuthAction || loadingStartAfterAuth}
				onclick={onLogout}
			>
				{loadingAuthAction ? 'Logging out...' : 'Logout'}
			</Button>
		{:else}
			<Button
				type="button"
				class="w-full"
				disabled={loadingAuthAction || loadingStartAfterAuth}
				onclick={onStartLogin}
			>
				{loadingAuthAction ? 'Connecting...' : 'Connect Twitch'}
			</Button>
		{/if}
	</CardContent>
</Card>
