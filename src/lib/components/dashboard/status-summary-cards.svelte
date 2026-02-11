<script lang="ts">
	import { Card, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { ChannelPointsAnalyticsSummary, MinerStatusResponse } from './types';

	let {
		minerStatus,
		summary
	}: {
		minerStatus: MinerStatusResponse;
		summary: ChannelPointsAnalyticsSummary | null;
	} = $props();

	const minerLabel = () => {
		if (minerStatus.running) return 'Running';
		if (minerStatus.lifecycle === 'authenticating') return 'Waiting';
		if (minerStatus.lifecycle === 'error') return 'Attention';
		return 'Stopped';
	};

	const minerDescription = () => {
		if (minerStatus.running) return 'Monitoring active channels.';
		if (minerStatus.lifecycle === 'authenticating') return 'Waiting for Twitch authorization.';
		if (minerStatus.lifecycle === 'ready') return 'Authenticated and ready to start.';
		if (minerStatus.lifecycle === 'error') return 'Check status details.';
		return 'Connect Twitch to start mining.';
	};

	const minerStatusDotClass = () => {
		if (minerStatus.running) return 'bg-emerald-500';
		if (minerStatus.lifecycle === 'error') return 'bg-red-500';
		if (minerStatus.lifecycle === 'authenticating') return 'bg-amber-400';
		return 'bg-muted-foreground/60';
	};

	const minerStatusTooltip = () => {
		if (minerStatus.running) return 'Miner is running and monitoring configured channels.';
		if (minerStatus.lifecycle === 'ready') return 'Twitch is connected. Miner can be started now.';
		if (minerStatus.lifecycle === 'authenticating') return 'Waiting for Twitch device authorization to complete.';
		if (minerStatus.reason === 'missing_token') return 'Miner is stopped because no Twitch token is configured yet.';
		if (minerStatus.reason === 'invalid_token') return 'Stored token is invalid. Reconnect Twitch to continue.';
		if (minerStatus.reason === 'startup_failed') return 'Miner startup failed. Check logs for details.';
		return 'Miner is stopped.';
	};
</script>

<section class="grid gap-4 md:grid-cols-3">
	<Card class="bg-card/80">
		<CardHeader class="gap-2">
			<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Miner Status</p>
			<div class="flex items-center gap-2">
				<span class={`size-2.5 rounded-full ${minerStatusDotClass()}`} title={minerStatusTooltip()} aria-hidden="true"></span>
				<CardTitle class="text-2xl">{minerLabel()}</CardTitle>
			</div>
			<CardDescription class="text-sm">{minerDescription()}</CardDescription>
		</CardHeader>
	</Card>

	<Card class="bg-card/80">
		<CardHeader class="gap-2">
			<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Tracked Channels</p>
			<CardTitle class="text-2xl">{summary?.trackedChannels ?? minerStatus.configuredStreamers.length}</CardTitle>
		</CardHeader>
	</Card>

	<Card class="bg-card/80">
		<CardHeader class="gap-2">
			<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Points Earned This Session</p>
			<CardTitle class="text-2xl">+{(summary?.pointsEarnedThisSession ?? 0).toLocaleString()}</CardTitle>
			<CardDescription class="text-sm">Total from active run.</CardDescription>
		</CardHeader>
	</Card>
</section>
