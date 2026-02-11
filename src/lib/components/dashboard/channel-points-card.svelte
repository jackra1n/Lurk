<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { scaleUtc } from 'd3-scale';
	import { curveLinear } from 'd3-shape';
	import { Area, AreaChart, LinearGradient } from 'layerchart';
	import ChannelPointsRangeSelector from './channel-points-range-selector.svelte';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { ChartConfig } from '$lib/components/ui/chart';
	import { ChartContainer, ChartTooltip } from '$lib/components/ui/chart';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Select from '$lib/components/ui/select';
	import type {
		ChannelPointsAnalyticsResponse,
		ChannelPointsControlChange,
		ChannelPointsControls,
		ChannelPointsSortBy,
		StreamerRuntimeState
	} from './types';

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

	const chartConfig = {
		balance: {
			label: 'Channel Points',
			color: 'var(--chart-1)'
		}
	} satisfies ChartConfig;
	const sortOptions: ChannelPointsSortBy[] = ['lastActive', 'name', 'points'];
	const sortLabels = {
		lastActive: 'Last Active',
		name: 'Name',
		points: 'Points'
	} satisfies Record<ChannelPointsSortBy, string>;

	const relativeTime = (timestampMs: number | null) => {
		if (!timestampMs) return 'never';
		const diffMs = Date.now() - timestampMs;
		if (diffMs < 60_000) return 'just now';
		if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
		if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
		return `${Math.floor(diffMs / 86_400_000)}d ago`;
	};
	const isMultiDayRange = $derived(controls.rangeToMs - controls.rangeFromMs > 24 * 60 * 60 * 1000);

	const chartYDomain = $derived.by<[number, number]>(() => {
		const balances = analytics?.timeline.map((item) => item.balance) ?? [];
		if (balances.length === 0) return [0, 1];

		const min = Math.min(...balances);
		const max = Math.max(...balances);

		if (min === max) {
			const pad = Math.max(1, Math.floor(Math.abs(min) * 0.02));
			return [min - pad, max + pad];
		}

		const pad = Math.max(1, Math.floor((max - min) * 0.06));
		return [min, max + pad];
	});

	const formatXAxisTick = (value: unknown) => {
		const date = value instanceof Date ? value : new Date(value as string | number);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleString('en-GB', {
			...(isMultiDayRange ? { day: '2-digit', month: '2-digit' } : {}),
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
	};

	const formatYAxisTick = (value: unknown) => {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (Number.isNaN(numeric)) return '';
		return Math.round(numeric).toLocaleString('en-GB');
	};

	const selectedStreamer = $derived(
		analytics?.streamers.find((streamer) => streamer.login === analytics.selectedStreamerLogin) ?? null
	);
	const runtimeStateByLogin = $derived(
		new Map(streamerRuntimeStates.map((streamerState) => [streamerState.login, streamerState]))
	);

	const streamerDotClass = (streamerState?: StreamerRuntimeState) => {
		if (!minerRunning) return 'bg-muted-foreground/60';
		if (streamerState?.isWatched) return 'bg-sky-400';
		if (streamerState?.isOnline) return 'bg-emerald-500';
		return 'bg-red-500';
	};

	const streamerDotLabel = (streamerState?: StreamerRuntimeState) => {
		if (streamerState?.isWatched) return 'Watching';
		if (streamerState?.isOnline) return 'Online';
		return 'Offline';
	};

	const streamerDotTooltip = (streamerState?: StreamerRuntimeState) => {
		if (!minerRunning) return "Streamer status is not updated while the miner service isn't running.";
		return streamerDotLabel(streamerState);
	};
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
				<ChannelPointsRangeSelector
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
				<div class="space-y-2">
					<Select.Root
						type="single"
						value={controls.sortBy}
						onValueChange={(value) => {
							if (value === controls.sortBy) return;
							onControlChange({ type: 'sortBy', value: value as ChannelPointsSortBy });
						}}
					>
						<Select.Trigger size="sm" class="w-full">
							<span data-slot="select-value">
								{#if controls.sortDir === 'asc'}
									<ArrowUp class="size-3.5" />
								{:else}
									<ArrowDown class="size-3.5" />
								{/if}
								{sortLabels[controls.sortBy]}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each sortOptions as key (key)}
								<Select.Item
									value={key}
									label={sortLabels[key]}
									onpointerdown={() => {
										if (key !== controls.sortBy) return;
										onControlChange({ type: 'toggleSortDir' });
									}}
								>
									{sortLabels[key]}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>

					<ScrollArea class="h-[360px]">
						<div class="space-y-1">
							{#each analytics.streamers as streamer (streamer.login)}
								{@const streamerState = runtimeStateByLogin.get(streamer.login)}
								<button
									type="button"
									class={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
										analytics.selectedStreamerLogin === streamer.login
											? 'border-primary/50 bg-primary/10'
											: 'border-border/70 bg-background/50 hover:bg-accent'
									}`}
									onclick={() => onControlChange({ type: 'selectStreamer', login: streamer.login })}
								>
									<div class="flex items-center gap-2.5">
										<span
											class={`size-2 shrink-0 rounded-full ${streamerDotClass(streamerState)}`}
											title={streamerDotTooltip(streamerState)}
											aria-hidden="true"
										></span>
										<div class="min-w-0 flex-1">
											<p class="text-sm font-medium">{streamer.login}</p>
											<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
												<span>{streamer.latestBalance.toLocaleString()} pts</span>
												<span class="text-right">{relativeTime(streamer.lastActiveAtMs)}</span>
											</div>
										</div>
									</div>
								</button>
							{/each}
						</div>
					</ScrollArea>
				</div>

				<div class="space-y-2">
					{#if analytics.timeline.length === 0}
						<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-10 text-center text-sm text-muted-foreground">
							No channel points history in this range.
						</p>
					{:else}
						<ChartContainer config={chartConfig} class="h-[360px] w-full !aspect-auto !overflow-hidden">
							<AreaChart
								data={analytics.timeline}
								x={(item) => new Date(item.timestampMs)}
								xScale={scaleUtc()}
								yDomain={chartYDomain}
								yBaseline={chartYDomain[0]}
								padding={{ top: 8, right: 16, bottom: 24, left: 88 }}
								series={[
									{
										key: 'balance',
										label: 'Balance',
										color: 'var(--color-balance)'
									}
								]}
								props={{
									xAxis: { format: formatXAxisTick, tickSpacing: 84 },
									yAxis: { format: formatYAxisTick, tickSpacing: 56 },
									area: {
										curve: curveLinear,
										'fill-opacity': 0.4,
										line: { class: 'stroke-1' },
										motion: 'tween'
									}
								}}
								grid
								axis
							>
								{#snippet tooltip()}
									<ChartTooltip
										labelFormatter={(value) => {
											const date = value instanceof Date ? value : new Date(value);
											return date.toLocaleString('en-GB', {
												...(isMultiDayRange ? { day: '2-digit', month: '2-digit', year: 'numeric' } : {}),
												hour: '2-digit',
												minute: '2-digit',
												hour12: false
											});
										}}
									/>
								{/snippet}
								{#snippet marks({ series, getAreaProps })}
									{#each series as s, i (s.key)}
										<LinearGradient
											stops={[
												s.color ?? '',
												'color-mix(in lch, ' + (s.color ?? '') + ' 10%, transparent)'
											]}
											vertical
										>
											{#snippet children({ gradient })}
												<Area {...getAreaProps(s, i)} fill={gradient} />
											{/snippet}
										</LinearGradient>
									{/each}
								{/snippet}
							</AreaChart>
						</ChartContainer>
					{/if}
				</div>
			</div>
		{/if}
	</CardContent>
</Card>
