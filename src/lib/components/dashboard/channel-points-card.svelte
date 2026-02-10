<script lang="ts">
	import CalendarRange from '@lucide/svelte/icons/calendar-range';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { scaleUtc } from 'd3-scale';
	import { curveLinear } from 'd3-shape';
	import { Area, AreaChart, LinearGradient } from 'layerchart';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { ChartConfig } from '$lib/components/ui/chart';
	import { ChartContainer, ChartTooltip } from '$lib/components/ui/chart';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Select from '$lib/components/ui/select';
	import type {
		ChannelPointsAnalyticsResponse,
		ChannelPointsControlChange,
		ChannelPointsControls,
		ChannelPointsSortBy,
	} from './types';

	let {
		analytics,
		loading = false,
		errorMessage = null,
		controls,
		onControlChange
	}: {
		analytics: ChannelPointsAnalyticsResponse | null;
		loading?: boolean;
		errorMessage?: string | null;
		controls: ChannelPointsControls;
		onControlChange: (change: ChannelPointsControlChange) => void | Promise<void>;
	} = $props();

	let rangeOpen = $state(false);
	let fromInput = $state('');
	let toInput = $state('');

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

	const asDateTimeLocal = (valueMs: number) => {
		const offsetMs = new Date(valueMs).getTimezoneOffset() * 60_000;
		return new Date(valueMs - offsetMs).toISOString().slice(0, 16);
	};

	const asTimestamp = (value: string) => {
		const result = new Date(value).getTime();
		return Number.isFinite(result) ? result : null;
	};

	const relativeTime = (timestampMs: number | null) => {
		if (!timestampMs) return 'never';
		const diffMs = Date.now() - timestampMs;
		if (diffMs < 60_000) return 'just now';
		if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
		if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
		return `${Math.floor(diffMs / 86_400_000)}d ago`;
	};
	const isMultiDayRange = $derived(controls.rangeToMs - controls.rangeFromMs > 24 * 60 * 60 * 1000);

	const openRangeEditor = () => {
		fromInput = asDateTimeLocal(controls.rangeFromMs);
		toInput = asDateTimeLocal(controls.rangeToMs);
		rangeOpen = true;
	};

	const applyRange = () => {
		const nextFrom = asTimestamp(fromInput);
		const nextTo = asTimestamp(toInput);
		if (nextFrom === null || nextTo === null || nextFrom > nextTo) return;
		onControlChange({ type: 'range', fromMs: nextFrom, toMs: nextTo });
		rangeOpen = false;
	};

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
		return date.toLocaleString('de-DE', {
			...(isMultiDayRange ? { day: '2-digit', month: '2-digit' } : {}),
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
	};

	const formatYAxisTick = (value: unknown) => {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (Number.isNaN(numeric)) return '';
		return Math.round(numeric).toLocaleString('de-DE');
	};
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-3">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<CardTitle class="text-lg">Channel Points</CardTitle>
				<CardDescription class="text-sm">Balance timeline and sorter for tracked streamers.</CardDescription>
			</div>

			<div class="flex items-center gap-2">
				{#if loading && analytics}
					<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
						<LoaderCircle class="size-3 animate-spin" />
						Updating...
					</span>
				{/if}
				<Popover.Root bind:open={rangeOpen}>
					<Popover.Trigger
						type="button"
						class={buttonVariants({ variant: 'outline', size: 'sm' })}
						onclick={openRangeEditor}
					>
						<CalendarRange class="size-4" />
						{new Date(controls.rangeFromMs).toLocaleDateString('de-DE')} - {new Date(controls.rangeToMs).toLocaleDateString('de-DE')}
					</Popover.Trigger>
					<Popover.Content class="w-80 space-y-3">
						<div class="space-y-2">
							<Label for="range-from">From</Label>
							<Input
								id="range-from"
								type="datetime-local"
								class="w-full"
								bind:value={fromInput}
							/>
						</div>
						<div class="space-y-2">
							<Label for="range-to">To</Label>
							<Input
								id="range-to"
								type="datetime-local"
								class="w-full"
								bind:value={toInput}
							/>
						</div>
						<Button type="button" class="w-full" onclick={applyRange}>Apply Range</Button>
					</Popover.Content>
				</Popover.Root>
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
								<button
									type="button"
									class={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
										analytics.selectedStreamerLogin === streamer.login
											? 'border-primary/50 bg-primary/10'
											: 'border-border/70 bg-background/50 hover:bg-accent'
									}`}
									onclick={() => onControlChange({ type: 'selectStreamer', login: streamer.login })}
								>
									<p class="text-sm font-medium">{streamer.login}</p>
									<p class="text-xs text-muted-foreground">
										{streamer.pointsEarned.toLocaleString()} pts · {relativeTime(streamer.lastActiveAtMs)}
									</p>
								</button>
							{/each}
						</div>
					</ScrollArea>
				</div>

				<div class="space-y-2">
					{#if analytics.selectedStreamerLogin}
						<p class="text-sm font-medium">
							{analytics.selectedStreamerLogin} · {analytics.timeline.length.toLocaleString()} samples
						</p>
					{/if}
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
										'fill-opacity': 1,
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
											return date.toLocaleString('de-DE', {
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
