<script lang="ts">
  import Flame from '@lucide/svelte/icons/flame';
  import { Badge } from '$lib/components/ui/badge';
  import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
  import { formatDuration, formatPoints } from '../shared/format';
  import type { StreamerRuntimeState, WatchingStreamer } from '../shared/types';

  const watchSlots = 2;

  let {
    watching,
    streamerRuntimeStates,
    minerRunning
  }: {
    watching: WatchingStreamer[];
    streamerRuntimeStates: StreamerRuntimeState[];
    minerRunning: boolean;
  } = $props();

  const liveCount = $derived(streamerRuntimeStates.filter((state) => state.isOnline).length);
  const waitingCount = $derived(
    streamerRuntimeStates.filter((state) => state.isOnline && !state.isWatched && !state.channelPointsDisabled).length
  );
  const slots = $derived(Array.from({ length: watchSlots }, (_, index) => watching[index] ?? null));
</script>

<Card class="bg-card/80 md:col-span-2">
  <CardHeader class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Watching Now</p>
    {#if minerRunning}
      <p class="text-xs text-muted-foreground">
        {liveCount}
        of {streamerRuntimeStates.length} live
        {#if waitingCount > 0}
          · {waitingCount} waiting for a slot
        {/if}
      </p>
    {/if}
  </CardHeader>
  <CardContent class="grid gap-2 sm:grid-cols-2">
    {#if !minerRunning}
      <div
        class="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border/70 bg-background/30 px-3 text-sm text-muted-foreground sm:col-span-2">
        Miner is stopped
      </div>
    {:else}
      {#each slots as stream, index (stream?.login ?? `slot-${index}`)}
        {#if stream}
          <div
            class="min-w-0 rounded-md border border-border/70 bg-background/50 px-3 py-2.5"
            title={stream.title ?? undefined}>
            <div class="flex items-center gap-2">
              <span class="relative inline-flex size-2.5 shrink-0 items-center justify-center">
                <span
                  class="absolute inset-0 rounded-full bg-primary/35 animate-ping motion-reduce:animate-none"></span>
                <span class="relative size-2 rounded-full bg-primary"></span>
              </span>
              <p class="min-w-0 flex-1 truncate font-medium">{stream.login}</p>
              {#if stream.streak}
                <Badge
                  variant="outline"
                  class="border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-300">
                  <Flame />
                  Streak
                </Badge>
              {/if}
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              {stream.game ?? 'Unknown category'}
              · {formatPoints(stream.viewers)} viewers
            </p>
            <div class="mt-2 flex items-baseline justify-between gap-2">
              <span class="text-lg font-semibold">+{formatPoints(stream.points)}</span>
              {#if stream.watchingSinceMs !== null}
                <span class="text-xs text-muted-foreground tabular-nums">
                  for {formatDuration(Date.now() - stream.watchingSinceMs)}
                </span>
              {/if}
            </div>
          </div>
        {:else}
          <div
            class="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border/70 bg-background/30 px-3 text-sm text-muted-foreground">
            Free slot
          </div>
        {/if}
      {/each}
    {/if}
  </CardContent>
</Card>
