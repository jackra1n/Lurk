<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Select from '$lib/components/ui/select';
	import * as Tooltip from '$lib/components/ui/tooltip';
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

	const sortOptions: ChannelPointsSortBy[] = ['lastActive', 'name', 'points', 'priority'];
	const sortLabels = {
		lastActive: 'Last Active',
		name: 'Name',
		points: 'Points',
		priority: 'Priority'
	} satisfies Record<ChannelPointsSortBy, string>;

	const relativeTime = (timestampMs: number | null) => {
		if (!timestampMs) return 'never';
		const diffMs = Date.now() - timestampMs;
		if (diffMs < 60_000) return 'just now';
		if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
		if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
		return `${Math.floor(diffMs / 86_400_000)}d ago`;
	};

	const runtimeStateByLogin = $derived(
		new Map(streamerRuntimeStates.map((streamerState) => [streamerState.login, streamerState]))
	);

	const streamerDotClass = (streamerState?: StreamerRuntimeState) => {
		if (!minerRunning) return 'bg-muted-foreground/60';
		if (streamerState?.isWatched) return 'bg-sky-400';
		if (streamerState?.isOnline) return 'bg-emerald-500';
		return 'bg-red-500';
	};

	const streamerDotLabel = (streamerState?: StreamerRuntimeState) => {
		if (streamerState?.isWatched) return 'Watching';
		if (streamerState?.isOnline) return 'Online';
		return 'Offline';
	};

	const streamerDotTooltip = (streamerState?: StreamerRuntimeState) => {
		if (!minerRunning) return "Streamer status is not updated while the miner service isn't running.";
		return streamerDotLabel(streamerState);
	};
</script>

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

	<ScrollArea class="h-90">
		<div class="space-y-1">
			{#each streamers as streamer (streamer.login)}
				{@const streamerState = runtimeStateByLogin.get(streamer.login)}
				<button
					type="button"
					class={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
						selectedStreamerLogin === streamer.login
							? 'border-primary/50 bg-primary/10'
							: 'border-border/70 bg-background/50 hover:bg-accent'
					}`}
					onclick={() => onControlChange({ type: 'selectStreamer', login: streamer.login })}
				>
					<div class="flex items-center gap-2.5">
						<Tooltip.Root>
							<Tooltip.Trigger aria-label={streamerDotTooltip(streamerState)}>
								{#snippet child({ props })}
									{@const { type: _type, ...triggerProps } = props}
									<span
										{...triggerProps}
										class={`size-2 shrink-0 rounded-full ${streamerDotClass(streamerState)}`}
									></span>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" sideOffset={8}>
								{streamerDotTooltip(streamerState)}
							</Tooltip.Content>
						</Tooltip.Root>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">{streamer.login}</p>
							<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
								<span>{streamer.latestBalance.toLocaleString()} pts</span>
								<span class="text-right">{relativeTime(streamer.lastActiveAtMs)}</span>
							</div>
						</div>
					</div>
				</button>
			{/each}
		</div>
	</ScrollArea>
</div>
