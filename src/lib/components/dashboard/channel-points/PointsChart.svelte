<script lang="ts">
	import { scaleUtc } from 'd3-scale';
	import { curveLinear } from 'd3-shape';
	import { Area, AreaChart, LinearGradient } from 'layerchart';
	import type { ChartConfig } from '$lib/components/ui/chart';
	import { ChartContainer, ChartTooltip } from '$lib/components/ui/chart';
	import type { ChannelPointSample } from '../shared/types';

	let {
		timeline,
		rangeFromMs,
		rangeToMs
	}: {
		timeline: ChannelPointSample[];
		rangeFromMs: number;
		rangeToMs: number;
	} = $props();

	const chartConfig = {
		balance: {
			label: 'Points',
			color: 'var(--chart-1)'
		}
	} satisfies ChartConfig;

	const isMultiDayRange = $derived(rangeToMs - rangeFromMs > 24 * 60 * 60 * 1000);
	const chartTimeline = $derived.by<ChannelPointSample[]>(() => {
		if (timeline.length !== 1) return timeline;

		const only = timeline[0];
		const syntheticOffsetMs = 60 * 1000;
		let syntheticTimestampMs = only.timestampMs - syntheticOffsetMs;

		if (syntheticTimestampMs < rangeFromMs) {
			syntheticTimestampMs = Math.min(rangeToMs, only.timestampMs + syntheticOffsetMs);
		}

		if (syntheticTimestampMs === only.timestampMs) {
			syntheticTimestampMs = only.timestampMs === rangeFromMs ? rangeToMs : rangeFromMs;
		}

		if (syntheticTimestampMs === only.timestampMs) return timeline;

		const syntheticSample = {
			timestampMs: syntheticTimestampMs,
			balance: only.balance
		} satisfies ChannelPointSample;

		return syntheticTimestampMs < only.timestampMs ? [syntheticSample, only] : [only, syntheticSample];
	});

	const chartYDomain = $derived.by<[number, number]>(() => {
		const balances = chartTimeline.map((item) => item.balance);
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

	const getScaleTickCount = (scale: unknown) => {
		if (!scale || (typeof scale !== 'object' && typeof scale !== 'function') || !('range' in scale))
			return 4;
		const range = (scale as { range: () => number[] }).range();
		const width = range.length >= 2 ? Math.abs(range[range.length - 1] - range[0]) : 0;
		return Math.max(2, Math.min(6, Math.round(width / 140)));
	};

	const getXAxisTicks = (scale: unknown) => {
		if (!scale || (typeof scale !== 'object' && typeof scale !== 'function') || !('ticks' in scale))
			return [];
		return (scale as { ticks: (count?: number) => unknown[] }).ticks(getScaleTickCount(scale));
	};

	const formatYAxisTick = (value: unknown) => {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (Number.isNaN(numeric)) return '';
		return Math.round(numeric).toLocaleString('en-GB');
	};
</script>

<div class="space-y-2">
	{#if chartTimeline.length === 0}
		<div class="h-96 w-full">
			<p
				class="flex h-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-background/70 px-4 py-6 text-center text-sm text-muted-foreground"
			>
				No channel points history in this range.
			</p>
		</div>
	{:else}
		<ChartContainer config={chartConfig} class="h-90 w-full aspect-auto! overflow-hidden!">
			<AreaChart
				data={chartTimeline}
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
					xAxis: { format: formatXAxisTick, ticks: getXAxisTicks, tickSpacing: 128, tickMultiline: true },
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
