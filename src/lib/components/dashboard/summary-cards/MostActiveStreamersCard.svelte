<script lang="ts">
	import { scaleLinear } from 'd3-scale';
	import { BarChart, Highlight } from 'layerchart';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { ChartContainer, ChartTooltip, type ChartConfig } from '$lib/components/ui/chart';
	import type { StreamerActivityItem } from '../shared/types';

	let {
		streamers = [],
		days = 7
	}: {
		streamers: StreamerActivityItem[];
		days?: number;
	} = $props();

	const chartData = $derived(
		streamers.map((s) => ({
			login: s.login,
			watched: s.watchedMinutes,
			online: s.onlineMinutes
		}))
	);

	const chartConfig = {
		watched: { label: 'Watched', color: '#3b82f6' },
		online: { label: 'Online', color: '#22c55e' }
	} satisfies ChartConfig;

	const formatMinutes = (mins: number) => {
		const hours = Math.floor(mins / 60);
		const minutes = Math.round(mins % 60);
		return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
	};
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-2 pb-3">
		<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Most Active Streamers</p>
		<CardTitle class="text-sm font-normal text-muted-foreground">Last {days} days</CardTitle>
	</CardHeader>
	<CardContent class="pt-0">
		{#if chartData.length === 0}
			<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-6 text-center text-sm text-muted-foreground">
				No activity data in the last {days} days.
			</p>
		{:else}
			<div class="h-44 w-full">
				<ChartContainer config={chartConfig}>
					<BarChart
						data={chartData}
						x="login"
						yScale={scaleLinear().nice()}
						series={[
							{ key: 'watched', label: 'Watched', color: chartConfig.watched.color },
							{ key: 'online', label: 'Online', color: chartConfig.online.color }
						]}
						seriesLayout="stack"
						padding={{ top: 4, right: 8, bottom: 24, left: 8 }}
						rule={false}
						props={{
							xAxis: { format: (d: unknown) => String(d).slice(0, 8) },
							highlight: { area: false }
						}}
					>
						{#snippet tooltip()}
							<ChartTooltip
								labelFormatter={(value) => String(value)}
							/>
						{/snippet}
						{#snippet belowMarks()}
							<Highlight area={{ class: 'fill-muted/30' }} />
						{/snippet}
					</BarChart>
				</ChartContainer>
			</div>
		{/if}
	</CardContent>
</Card>
