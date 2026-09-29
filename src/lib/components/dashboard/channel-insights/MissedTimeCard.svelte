<script lang="ts">
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { formatCompactPoints, formatDuration } from '../shared/format';
  import type { MissedTimeItem } from '../shared/types';

  let { items = [], days = 7 }: { items?: MissedTimeItem[]; days?: number } = $props();

  const maxLiveMs = $derived(Math.max(1, ...items.map((item) => item.liveMs)));

  // Watching starts shortly after a stream goes live, so a few minutes per stream are always missed.
  const isFullyWatched = (item: MissedTimeItem) =>
    item.liveMs - item.watchedMs < Math.max(5 * 60_000, item.liveMs * 0.01);
</script>

<Card class="bg-card/80">
  <CardHeader class="gap-2">
    <CardTitle class="text-lg">Missed Time</CardTitle>
    <CardDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>Live but not watched · last {days} days</span>
      <span class="inline-flex items-center gap-1.5 text-xs">
        <span class="size-2 rounded-[2px] bg-primary"></span>
        Watched
      </span>
      <span class="inline-flex items-center gap-1.5 text-xs">
        <span class="size-2 rounded-[2px] bg-primary/25"></span>
        Missed
      </span>
    </CardDescription>
  </CardHeader>
  <CardContent>
    {#if items.length === 0}
      <p
        class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground">
        No live streams in the last {days} days.
      </p>
    {:else}
      <ScrollArea class="h-72">
        <div class="space-y-3 pr-3">
          {#each items as item (item.login)}
            {@const missedMs = item.liveMs - item.watchedMs}
            {@const fullyWatched = isFullyWatched(item)}
            <div class="space-y-1.5">
              <div class="flex items-baseline justify-between gap-3">
                <p class="min-w-0 truncate text-sm font-medium">{item.login}</p>
                <p class="shrink-0 text-sm tabular-nums">
                  {fullyWatched ? 'Fully watched' : `${formatDuration(missedMs)} missed`}
                </p>
              </div>
              <div class="h-2 rounded-full bg-muted/60">
                <div class="flex h-full gap-0.5" style={`width: ${(item.liveMs / maxLiveMs) * 100}%`}>
                  {#if item.watchedMs > 0}
                    <span class="h-full rounded-full bg-primary" style={`flex-grow: ${item.watchedMs}`}></span>
                  {/if}
                  {#if !fullyWatched}
                    <span class="h-full rounded-full bg-primary/25" style={`flex-grow: ${missedMs}`}></span>
                  {/if}
                </div>
              </div>
              <p class="text-xs text-muted-foreground">
                {#if fullyWatched}
                  Watched all {formatDuration(item.liveMs)} live
                {:else}
                  {Math.floor((item.watchedMs / item.liveMs) * 100)}% of {formatDuration(item.liveMs)} live watched
                {/if}
                {#if !fullyWatched && item.missedPoints !== null && item.missedPoints > 0}
                  · ~{formatCompactPoints(item.missedPoints)}
                  pts missed
                {/if}
              </p>
            </div>
          {/each}
        </div>
      </ScrollArea>
    {/if}
  </CardContent>
</Card>
