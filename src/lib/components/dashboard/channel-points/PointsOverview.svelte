<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import DateRangePicker from './DateRangePicker.svelte';
	import PointsChart from './PointsChart.svelte';
	import StreamerList from './StreamerList.svelte';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type {
		ChannelPointsAnalyticsResponse,
		ChannelPointsControlChange,
		ChannelPointsControls,
		StreamerRuntimeState
	} from '../shared/types';

	let {
		analytics,
		loading = false,
		errorMessage = null,
		controls,
		streamerRuntimeStates = [],
		minerRunning = false,
		onControlChange
	}: {
		analytics: ChannelPointsAnalyticsResponse | null;
		loading?: boolean;
		errorMessage?: string | null;
		controls: ChannelPointsControls;
		streamerRuntimeStates?: StreamerRuntimeState[];
		minerRunning?: boolean;
		onControlChange: (change: ChannelPointsControlChange) => void | Promise<void>;
	} = $props();

	const selectedStreamer = $derived(
		analytics?.streamers.find((streamer) => streamer.login === analytics.selectedStreamerLogin) ?? null
	);
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-3">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<CardTitle class="text-lg">Channel Points</CardTitle>
				<CardDescription class="text-sm">
					{#if selectedStreamer}
						{selectedStreamer.login} · {selectedStreamer.latestBalance.toLocaleString()} pts
					{:else}
						Balance timeline and sorter for tracked streamers.
					{/if}
				</CardDescription>
			</div>

			<div class="flex items-center gap-2">
				{#if loading && analytics}
					<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
						<LoaderCircle class="size-3 animate-spin" />
						Updating...
					</span>
				{/if}
				<DateRangePicker
					rangeFromMs={controls.rangeFromMs}
					rangeToMs={controls.rangeToMs}
					onApply={({ fromMs, toMs }) => onControlChange({ type: 'range', fromMs, toMs })}
					disabled={loading && !analytics}
				/>
			</div>
		</div>
	</CardHeader>

	<CardContent>
		{#if errorMessage}
			<p class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{errorMessage}
			</p>
		{/if}

		{#if loading && !analytics}
			<p class="rounded-lg border border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground">
				Loading channel points...
			</p>
		{:else if !analytics || analytics.streamers.length === 0}
			<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground">
				No tracked streamers yet.
			</p>
		{:else}
			<div class="grid gap-3 lg:grid-cols-[240px_1fr]">
				<StreamerList
					streamers={analytics.streamers}
					selectedStreamerLogin={analytics.selectedStreamerLogin}
					{controls}
					{streamerRuntimeStates}
					{minerRunning}
					{onControlChange}
				/>
				<PointsChart
					timeline={analytics.timeline}
					rangeFromMs={controls.rangeFromMs}
					rangeToMs={controls.rangeToMs}
				/>
			</div>
		{/if}
	</CardContent>
</Card>
