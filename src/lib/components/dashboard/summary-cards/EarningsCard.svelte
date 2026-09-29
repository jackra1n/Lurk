<script lang="ts">
  import TrendingDown from '@lucide/svelte/icons/trending-down';
  import TrendingUp from '@lucide/svelte/icons/trending-up';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { formatCompactPoints, formatPoints } from '../shared/format';
  import type { EarningsBreakdown } from '../shared/types';

  let {
    earnings,
    dailyAverage
  }: {
    earnings: EarningsBreakdown;
    dailyAverage: number | null;
  } = $props();

  const sources = [
    { key: 'claim', label: 'Claims', class: 'bg-primary' },
    { key: 'watch', label: 'Watch', class: 'bg-sky-600' },
    { key: 'streak', label: 'Streaks', class: 'bg-orange-600' },
    { key: 'other', label: 'Other', class: 'bg-muted-foreground/60' }
  ] as const;

  const visibleSources = $derived(sources.filter((source) => earnings[source.key] > 0));
  const changePercent = $derived(
    dailyAverage ? Math.round(((earnings.total - dailyAverage) / dailyAverage) * 100) : null
  );
</script>

<Card class="bg-card/80">
  <CardHeader class="gap-2">
    <p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Earned · 24h</p>
    <CardTitle class="text-2xl">+{formatPoints(earnings.total)}</CardTitle>
    {#if changePercent !== null && dailyAverage !== null}
      <p
        class={`inline-flex items-center gap-1.5 text-sm ${
          changePercent >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
        }`}>
        {#if changePercent >= 0}
          <TrendingUp class="size-4" />
        {:else}
          <TrendingDown class="size-4" />
        {/if}
        {changePercent >= 0 ? '+' : ''}{changePercent}%
        <span class="text-muted-foreground">vs 7-day avg ({formatCompactPoints(dailyAverage)})</span>
      </p>
    {:else}
      <CardDescription class="text-sm">Not enough history to compare yet.</CardDescription>
    {/if}
  </CardHeader>
  {#if visibleSources.length > 0}
    <CardContent class="space-y-2 pt-0">
      <div class="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {#each visibleSources as source (source.key)}
          <span
            class={`h-full ${source.class}`}
            style={`flex-grow: ${earnings[source.key]}`}
            title={`${source.label}: ${formatPoints(earnings[source.key])}`}></span>
        {/each}
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {#each visibleSources as source (source.key)}
          <span class="inline-flex items-center gap-1.5">
            <span class={`size-2 rounded-[2px] ${source.class}`}></span>
            {source.label}
            <span class="text-foreground">{formatCompactPoints(earnings[source.key])}</span>
          </span>
        {/each}
      </div>
    </CardContent>
  {/if}
</Card>
