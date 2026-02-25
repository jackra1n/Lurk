<script lang="ts">
	import { scaleLinear } from 'd3-scale';
	import { BarChart, Highlight } from 'layerchart';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { ChartContainer, ChartTooltip, type ChartConfig } from '$lib/components/ui/chart';
	import type { StreamerActivityItem } from '../shared/types';
	import CardTitle from '$lib/components/ui/card/card-title.svelte';
	import CardDescription from '$lib/components/ui/card/card-description.svelte';

	let {
		streamers = [],
		days = 7
	}: {
		streamers: StreamerActivityItem[];
		days?: number;
	} = $props();

	const minimumOnlineHours = 0.1;
	const toHours = (minutes: number) => minutes / 60;
	const roundToOneDecimal = (value: number) => Math.round(value * 10) / 10;
	const formatHours = (value: number) => `${value.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} h`;

	const chartData = $derived.by(() =>
		streamers
			.map((streamer) => {
				const onlineHours = roundToOneDecimal(toHours(streamer.onlineMinutes));
				const watchedHours = roundToOneDecimal(toHours(streamer.watchedMinutes));
				const unwatchedHours = Math.max(0, roundToOneDecimal(onlineHours - watchedHours));

				return {
					login: streamer.login,
					onlineHours,
					watchedHours,
					unwatchedHours,
					watchedBottomHours: unwatchedHours > 0 ? watchedHours : 0,
					watchedFullHours: unwatchedHours === 0 ? watchedHours : 0
				};
			})
			.filter((streamer) => streamer.onlineHours >= minimumOnlineHours)
	);

	const chartConfig = {
		watchedBottomHours: { label: 'Watched', color: '#38bdf8' },
		watchedFullHours: { label: 'Watched', color: '#38bdf8' },
		watchedHours: { label: 'Watched', color: '#38bdf8' },
		unwatchedHours: { label: 'Online (not watched)', color: '#22c55e' },
		onlineHours: { label: 'Online', color: '#22c55e' }
	} satisfies ChartConfig;

</script>

<Card class="bg-card/80 pb-0 block">
	<CardHeader class="gap-2">
	    <CardTitle class="text-lg">Most Active Streamers</CardTitle>
		<CardDescription>Last 7 days</CardDescription>
	</CardHeader>
	<CardContent>
		{#if chartData.length === 0}
			<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-6 text-center text-sm text-muted-foreground">
				No streamers with at least {minimumOnlineHours}h online in the last {days} days.
			</p>
		{:else}
			<ChartContainer config={chartConfig} class="h-56">
				<BarChart
					data={chartData}
					x="login"
					yScale={scaleLinear().nice()}
					series={[
						{
							key: 'watchedBottomHours',
							label: 'Watched',
							color: chartConfig.watchedBottomHours.color,
							props: { rounded: 'bottom' }
						},
						{
							key: 'unwatchedHours',
							label: 'Online (not watched)',
							color: chartConfig.unwatchedHours.color,
							props: { rounded: 'edge' }
						},
						{
							key: 'watchedFullHours',
							label: 'Watched',
							color: chartConfig.watchedFullHours.color,
							props: { rounded: 'all' }
						}
					]}
					seriesLayout="stack"
					padding={{ top: 4, right: 8, bottom: 24, left: 8 }}
					axis="x"
					rule={false}
					props={{
						xAxis: { format: (d: unknown) => String(d).slice(0, 8) },
						highlight: { area: false },
						bars: {
							strokeWidth: 0,
							rx: 4
						}
					}}
				>
					{#snippet tooltip()}
						{#snippet hoursTooltip({
							item,
							index,
							payload
						}: {
							item: { payload?: { watchedHours?: number; onlineHours?: number } };
							index: number;
							payload: Array<{ payload?: { watchedHours?: number; onlineHours?: number } }>;
						})}
							{@const row = (item.payload ?? payload[0]?.payload) as
								| { watchedHours?: number; onlineHours?: number }
								| undefined}
							{#if index === 0 && row}
								<div class="grid w-full gap-1">
									<div class="flex items-center justify-between gap-3">
										<span class="text-muted-foreground flex items-center gap-1.5">
											<span
												class="size-2 rounded-[2px]"
												style={`background-color: ${chartConfig.onlineHours.color};`}
											></span>
											{chartConfig.onlineHours.label}
										</span>
										<span class="text-foreground font-mono font-medium tabular-nums">
											{formatHours(row.onlineHours ?? row.watchedHours ?? 0)}
										</span>
									</div>
									<div class="flex items-center justify-between gap-3">
										<span class="text-muted-foreground flex items-center gap-1.5">
											<span
												class="size-2 rounded-[2px]"
												style={`background-color: ${chartConfig.watchedHours.color};`}
											></span>
											{chartConfig.watchedHours.label}
										</span>
										<span class="text-foreground font-mono font-medium tabular-nums">
											{formatHours(row.watchedHours ?? 0)}
										</span>
									</div>
								</div>
							{/if}
						{/snippet}
						<ChartTooltip
							labelFormatter={(value) => String(value)}
							formatter={hoursTooltip}
						/>
					{/snippet}
					{#snippet belowMarks()}
						<Highlight area={{ class: 'fill-muted/30' }} />
					{/snippet}
				</BarChart>
			</ChartContainer>
		{/if}
	</CardContent>
</Card>
