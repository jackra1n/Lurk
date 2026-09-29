<script lang="ts">
  import { BarChart } from 'layerchart';
  import type { ChartConfig } from '$lib/components/ui/chart';
  import { ChartContainer, ChartTooltip } from '$lib/components/ui/chart';
  import { formatCompactPoints } from '../shared/format';
  import type { EarningsBuckets } from '../shared/types';

  let { earnings }: { earnings: EarningsBuckets } = $props();

  const maxBarWidth = 24;
  const maxTickLabels = 8;
  const plotSidePadding = 64;

  const sources = [
    { key: 'claim', label: 'Claims', color: 'var(--primary)', swatch: 'bg-primary' },
    { key: 'watch', label: 'Watch', color: 'var(--color-sky-600)', swatch: 'bg-sky-600' },
    { key: 'streak', label: 'Streaks', color: 'var(--color-orange-600)', swatch: 'bg-orange-600' },
    { key: 'other', label: 'Other', color: 'var(--muted-foreground)', swatch: 'bg-muted-foreground' }
  ] as const;

  const chartConfig = Object.fromEntries(
    sources.map((source) => [source.key, { label: source.label, color: source.color }])
  ) satisfies ChartConfig;

  let containerWidth = $state(0);

  const isHourly = $derived(earnings.bucketMs < 24 * 60 * 60 * 1000);
  const totals = $derived(
    sources.map((source) => ({
      ...source,
      total: earnings.buckets.reduce((sum, bucket) => sum + bucket[source.key], 0)
    }))
  );
  const visibleSources = $derived(totals.filter((source) => source.total > 0));
  const barWidth = $derived(
    Math.max(2, Math.min(maxBarWidth, ((containerWidth - plotSidePadding) / earnings.buckets.length) * 0.7))
  );
  const hasEarnings = $derived(visibleSources.length > 0);

  const formatBucket = (value: unknown, withDate = false) => {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '';
    if (!isHourly) return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    return date.toLocaleString('en-GB', {
      ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  const getXAxisTicks = (scale: unknown) => {
    const domain = (scale as { domain?: () => unknown[] }).domain?.() ?? [];
    const step = Math.ceil(domain.length / maxTickLabels);
    return domain.filter((_, index) => index % step === 0);
  };
</script>

<div class="space-y-2" bind:clientWidth={containerWidth}>
  {#if !hasEarnings}
    <div class="h-96 w-full">
      <p
        class="flex h-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-background/70 px-4 py-6 text-center text-sm text-muted-foreground">
        No points earned in this range.
      </p>
    </div>
  {:else}
    <ChartContainer config={chartConfig} class="h-96 w-full aspect-auto! overflow-hidden!">
      <BarChart
        data={earnings.buckets}
        x="startMs"
        series={visibleSources.map((source) => ({ key: source.key, label: source.label, color: source.color }))}
        seriesLayout="stack"
        stackPadding={2}
        padding={{ top: 8, right: 8, bottom: 20, left: 48 }}
        grid={{ x: false, y: true }}
        rule={false}
        props={{
          xAxis: { format: (value: unknown) => formatBucket(value), ticks: getXAxisTicks },
          yAxis: { format: (value: unknown) => formatCompactPoints(Number(value)) },
          bars: { width: barWidth, strokeWidth: 0 },
          highlight: { area: { class: 'fill-muted/30' } }
        }}>
        {#snippet tooltip()}
          <ChartTooltip labelFormatter={(value) => formatBucket(value, true)} />
        {/snippet}
      </BarChart>
    </ChartContainer>
    <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 pb-4 text-xs text-muted-foreground">
      {#each visibleSources as source (source.key)}
        <span class="inline-flex items-center gap-1.5">
          <span class={`size-2.5 rounded-[2px] ${source.swatch}`}></span>
          {source.label}
          <span class="text-foreground">{formatCompactPoints(source.total)}</span>
        </span>
      {/each}
    </div>
  {/if}
</div>
