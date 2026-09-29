<script lang="ts">
  import Flame from '@lucide/svelte/icons/flame';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { formatDuration, formatExactTime, formatPoints, formatRelativeTime } from '../shared/format';
  import type { ActivityFeedItem } from '../shared/types';

  let { items = [] }: { items?: ActivityFeedItem[] } = $props();

  const describe = (item: ActivityFeedItem) => {
    if (item.kind === 'watch') {
      return item.ongoing
        ? `Watching for ${formatDuration(item.durationMs)}`
        : `Watched ${formatDuration(item.durationMs)}`;
    }
    if (item.kind === 'online') return item.game ? `Went live · ${item.game}` : 'Went live';
    if (item.kind === 'offline') return 'Went offline';
    return 'Bonus claim failed';
  };

  const dotClass = (item: ActivityFeedItem) => {
    if (item.kind === 'watch') return 'bg-primary';
    if (item.kind === 'online') return 'bg-emerald-500';
    if (item.kind === 'claim_failed') return 'bg-red-500';
    return 'bg-muted-foreground/60';
  };
</script>

<Card class="bg-card/80">
  <CardHeader class="gap-2">
    <CardTitle class="text-lg">Activity</CardTitle>
    <CardDescription>Watch sessions and stream changes</CardDescription>
  </CardHeader>
  <CardContent>
    {#if items.length === 0}
      <p
        class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground">
        No activity yet.
      </p>
    {:else}
      <ScrollArea class="h-72">
        <div class="space-y-1 pr-3">
          {#each items as item (item.id)}
            <div class="rounded-md border border-border/70 bg-background/50 px-3 py-2">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="relative inline-flex size-2 shrink-0">
                      {#if item.kind === 'watch' && item.ongoing}
                        <span
                          class="absolute inset-0 rounded-full bg-primary/35 animate-ping motion-reduce:animate-none"></span>
                      {/if}
                      <span class={`relative size-2 rounded-full ${dotClass(item)}`}></span>
                    </span>
                    <p class="truncate text-sm font-medium">{item.login}</p>
                    {#if item.kind === 'watch' && item.streak}
                      <Flame class="size-3.5 shrink-0 text-orange-600" aria-label="Watch streak" />
                    {/if}
                  </div>
                  <p class="truncate text-xs text-muted-foreground">{describe(item)}</p>
                </div>
                <div class="shrink-0 text-right">
                  {#if item.kind === 'watch'}
                    <p class="text-sm font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                      +{formatPoints(item.points)}
                    </p>
                  {/if}
                  <Tooltip.Root>
                    <Tooltip.Trigger aria-label={formatExactTime(item.occurredAtMs)}>
                      {#snippet child({ props })}
                        {@const { type: _type, ...triggerProps } = props}
                        <span {...triggerProps} class="inline-flex text-xs text-muted-foreground tabular-nums">
                          {item.kind === 'watch' && item.ongoing ? 'now' : formatRelativeTime(item.occurredAtMs)}
                        </span>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content side="top" sideOffset={8}>
                      {formatExactTime(item.occurredAtMs)}
                    </Tooltip.Content>
                  </Tooltip.Root>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </ScrollArea>
    {/if}
  </CardContent>
</Card>
