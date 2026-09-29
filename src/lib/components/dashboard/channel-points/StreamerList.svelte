<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import { Badge } from '$lib/components/ui/badge';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Select from '$lib/components/ui/select';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import StreamerAvatar from '../shared/StreamerAvatar.svelte';
  import { formatCompactPoints, formatPoints, formatRelativeTime, formatStreamerName } from '../shared/format';
  import type {
    ChannelPointsControlChange,
    ChannelPointsControls,
    ChannelPointsSortBy,
    StreamerAnalyticsItem,
    StreamerRuntimeState
  } from '../shared/types';

  let {
    streamers,
    selectedStreamerLogin,
    controls,
    streamerRuntimeStates = [],
    minerRunning = false,
    onControlChange
  }: {
    streamers: StreamerAnalyticsItem[];
    selectedStreamerLogin: string | null;
    controls: ChannelPointsControls;
    streamerRuntimeStates?: StreamerRuntimeState[];
    minerRunning?: boolean;
    onControlChange: (change: ChannelPointsControlChange) => void | Promise<void>;
  } = $props();

  const sortOptions: ChannelPointsSortBy[] = ['lastActive', 'lastWatched', 'name', 'points', 'priority'];
  const sortLabels = {
    lastActive: 'Last Active',
    lastWatched: 'Last Watched',
    name: 'Name',
    points: 'Points',
    priority: 'Priority'
  } satisfies Record<ChannelPointsSortBy, string>;

  const runtimeStateByLogin = $derived(
    new Map(streamerRuntimeStates.map((streamerState) => [streamerState.login, streamerState]))
  );

  type StreamerStatus = 'unknown' | 'watching' | 'waiting' | 'live' | 'offline';

  const getStatus = (streamerState?: StreamerRuntimeState): StreamerStatus => {
    if (!minerRunning) return 'unknown';
    if (streamerState?.isWatched) return 'watching';
    if (streamerState?.isOnline) return streamerState.channelPointsDisabled ? 'live' : 'waiting';
    return 'offline';
  };

  const statusDotClass = {
    unknown: 'bg-muted-foreground/60',
    watching: 'bg-primary',
    waiting: 'bg-amber-400',
    live: 'bg-emerald-500',
    offline: 'bg-red-500'
  } satisfies Record<StreamerStatus, string>;

  const statusTooltip = {
    unknown: "Streamer status is not updated while the miner service isn't running.",
    watching: 'Live · watching now',
    waiting: 'Live · waiting for a free watch slot',
    live: 'Live · not watched because channel points are off',
    offline: 'Offline'
  } satisfies Record<StreamerStatus, string>;

  const channelPointsDisabledTooltip =
    'This streamer has disabled channel points. Lurk will not use watch slots here until points are enabled again.';
</script>

<div class="space-y-2">
  <Select.Root
    type="single"
    value={controls.sortBy}
    onValueChange={(value) => {
			if (value === controls.sortBy) return;
			onControlChange({ type: 'sortBy', value: value as ChannelPointsSortBy });
		}}>
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
					}}>
          {sortLabels[key]}
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>

  <ScrollArea class="h-90">
    <div class="space-y-1">
      {#each streamers as streamer (streamer.login)}
        {@const streamerState = runtimeStateByLogin.get(streamer.login)}
        {@const timestampMs = controls.sortBy === 'lastWatched' ? streamer.lastWatchedAtMs : streamer.lastActiveAtMs}
        {@const status = getStatus(streamerState)}
        <button
          type="button"
          class={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
            selectedStreamerLogin === streamer.login
              ? 'border-primary/50 bg-primary/10'
              : 'border-border/70 bg-background/50 hover:bg-accent'
          }`}
          onclick={() => onControlChange({ type: 'selectStreamer', login: streamer.login })}>
          <div class="flex items-center gap-2.5">
            <Tooltip.Root>
              <Tooltip.Trigger aria-label={statusTooltip[status]}>
                {#snippet child({ props })}
                  {@const { type: _type, ...triggerProps } = props}
                  <span {...triggerProps} class="relative inline-flex shrink-0">
                    <StreamerAvatar name={streamer.login} src={streamer.profileImageUrl} />
                    <span class="absolute -right-0.5 -bottom-0.5 inline-flex size-3 items-center justify-center">
                      {#if status === 'watching'}
                        <span
                          class="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:animate-none"></span>
                      {/if}
                      <span class={`relative size-2.5 rounded-full ring-2 ring-card ${statusDotClass[status]}`}></span>
                    </span>
                  </span>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content side="top" sideOffset={8}>
                {statusTooltip[status]}
              </Tooltip.Content>
            </Tooltip.Root>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <p class="min-w-0 truncate text-sm font-medium">{formatStreamerName(streamer)}</p>
                {#if streamerState?.channelPointsDisabled}
                  <div class="shrink-0">
                    <Tooltip.Root>
                      <Tooltip.Trigger aria-label={channelPointsDisabledTooltip}>
                        {#snippet child({ props })}
                          {@const { type: _type, ...triggerProps } = props}
                          <Badge
                            {...triggerProps}
                            variant="outline"
                            class="border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300">
                            <TriangleAlert class="size-3" />
                            Points Off
                          </Badge>
                        {/snippet}
                      </Tooltip.Trigger>
                      <Tooltip.Content side="top" sideOffset={8}>
                        {channelPointsDisabledTooltip}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                {/if}
              </div>
              <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span class="min-w-0 truncate">
                  {formatPoints(streamer.latestBalance)}
                  pts
                  {#if streamer.pointsEarned > 0}
                    <span class="text-emerald-700 dark:text-emerald-400"
                      >+{formatCompactPoints(streamer.pointsEarned)}</span
                    >
                  {/if}
                </span>
                <span class="shrink-0 text-right">
                  {#if status === 'watching'}
                    Watching
                  {:else if status === 'waiting'}
                    Waiting for slot
                  {:else}
                    {timestampMs ? formatRelativeTime(timestampMs) : 'never'}
                  {/if}
                </span>
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  </ScrollArea>
</div>
