<script lang="ts">
	import Play from '@lucide/svelte/icons/play';
	import Square from '@lucide/svelte/icons/square';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { MinerStatusResponse } from '../shared/types';

	let {
		minerStatus,
		startDisabled = false,
		stopDisabled = false,
		actionPhase = 'idle',
		onStart,
		onStop
	}: {
		minerStatus: MinerStatusResponse;
		startDisabled?: boolean;
		stopDisabled?: boolean;
		actionPhase?: 'idle' | 'starting' | 'stopping';
		onStart?: () => void | Promise<void>;
		onStop?: () => void | Promise<void>;
	} = $props();

	const showStartingState = $derived(actionPhase === 'starting' || minerStatus.lifecycle === 'starting');
	const showStopState = $derived(!showStartingState && minerStatus.running);

	const minerLabel = () => {
		if (minerStatus.lifecycle === 'starting') return 'Starting';
		if (minerStatus.running) return 'Running';
		if (minerStatus.lifecycle === 'authenticating') return 'Waiting';
		if (minerStatus.lifecycle === 'error') return 'Attention';
		return 'Stopped';
	};

	const minerStatusDotClass = () => {
		if (minerStatus.lifecycle === 'starting') return 'bg-amber-400';
		if (minerStatus.running) return 'bg-emerald-500';
		if (minerStatus.lifecycle === 'error') return 'bg-red-500';
		if (minerStatus.lifecycle === 'authenticating') return 'bg-amber-400';
		return 'bg-muted-foreground/60';
	};

	const minerStatusTooltip = () => {
		if (minerStatus.lifecycle === 'starting') return 'Miner startup is in progress.';
		if (minerStatus.running) return 'Miner is running and monitoring configured channels.';
		if (minerStatus.lifecycle === 'ready') return 'Twitch is connected. Miner can be started now.';
		if (minerStatus.lifecycle === 'authenticating') return 'Waiting for Twitch device authorization to complete.';
		if (minerStatus.reason === 'missing_token') return 'Miner is stopped because no Twitch token is configured yet.';
		if (minerStatus.reason === 'invalid_token') return 'Stored token is invalid. Reconnect Twitch to continue.';
		if (minerStatus.reason === 'startup_failed') return 'Miner startup failed. Check logs for details.';
		return 'Miner is stopped.';
	};
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-2">
		<div class="flex items-start justify-between gap-3">
			<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Miner Status</p>
			<Tooltip.Root>
				<Tooltip.Trigger aria-label={minerStatusTooltip()}>
					{#snippet child({ props })}
						{@const { type: _type, ...triggerProps } = props}
						<span {...triggerProps} class={`size-2.5 shrink-0 rounded-full ${minerStatusDotClass()}`}></span>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="top" sideOffset={8}>
					{minerStatusTooltip()}
				</Tooltip.Content>
			</Tooltip.Root>
		</div>
		<CardTitle class="text-2xl">{minerLabel()}</CardTitle>
	</CardHeader>
	<CardContent class="pt-0">
		{#if showStopState}
			<Button
				class="w-full justify-start"
				variant="destructive"
				disabled={stopDisabled || actionPhase === 'stopping'}
				onclick={onStop}
			>
				<Square class="size-4" />
				{actionPhase === 'stopping' ? 'Stopping...' : 'Stop Miner'}
			</Button>
		{:else}
			<Button
				class="w-full justify-start"
				variant="secondary"
				disabled={startDisabled || showStartingState}
				onclick={onStart}
			>
				<Play class="size-4" />
				{showStartingState ? 'Starting...' : 'Start Miner'}
			</Button>
		{/if}
	</CardContent>
</Card>
