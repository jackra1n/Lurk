<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Tooltip from '$lib/components/ui/tooltip';

	type EventKind =
		| 'points_watch'
		| 'points_claim'
		| 'stream_online'
		| 'stream_offline'
		| 'watch_started'
		| 'watch_stopped'
		| 'other';

	interface RecentEventItem {
		id: string;
		login: string;
		occurredAtMs: number;
		kind: EventKind;
		pointsDelta: number | null;
	}

	const initialVisibleEvents = 24;
	const visibleEventsStep = 24;
	const lazyLoadThresholdPx = 96;

	let { events = [] }: { events?: RecentEventItem[] } = $props();

	let eventsViewport = $state<HTMLElement | null>(null);
	let visibleEventsCount = $state(0);

	const formatRelativeTime = (timestampMs: number) => {
		const diffMs = Math.max(0, Date.now() - timestampMs);
		if (diffMs < 60_000) return `${Math.max(1, Math.floor(diffMs / 1_000))}s ago`;
		if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
		if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
		return `${Math.floor(diffMs / 86_400_000)}d ago`;
	};

	const formatExactTime = (timestampMs: number) =>
		new Date(timestampMs).toLocaleString('en-GB', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		});

	const eventLabelByKind = {
		points_watch: 'Earned points for watching',
		points_claim: 'Earned points from claim bonus',
		stream_online: 'Streamer went online',
		stream_offline: 'Streamer went offline',
		watch_started: 'Started watching',
		watch_stopped: 'Stopped watching',
		other: 'Event'
	} satisfies Record<EventKind, string>;

	const eventDotClassByKind = {
		points_watch: '',
		points_claim: '',
		stream_online: 'bg-emerald-500',
		stream_offline: 'bg-muted-foreground/60',
		watch_started: '',
		watch_stopped: 'bg-red-500',
		other: 'bg-muted-foreground/70'
	} satisfies Record<EventKind, string>;

	const getEventLabel = (kind: EventKind) => eventLabelByKind[kind];
	const getEventDotClass = (kind: EventKind) => eventDotClassByKind[kind];
	const usesPointsTone = (kind: EventKind) =>
		kind === 'points_watch' || kind === 'points_claim' || kind === 'watch_started';

	const visibleEvents = $derived(events.slice(0, visibleEventsCount));

	const loadMoreEventsIfNeeded = () => {
		const viewport = eventsViewport;
		if (!viewport || visibleEventsCount >= events.length) return;
		const remainingScrollPx = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		if (remainingScrollPx > lazyLoadThresholdPx) return;
		visibleEventsCount = Math.min(events.length, visibleEventsCount + visibleEventsStep);
	};

	$effect(() => {
		visibleEventsCount = Math.min(initialVisibleEvents, events.length);
	});

	$effect(() => {
		const viewport = eventsViewport;
		if (!viewport) return;

		const onScroll = () => {
			loadMoreEventsIfNeeded();
		};

		viewport.addEventListener('scroll', onScroll, { passive: true });
		loadMoreEventsIfNeeded();

		return () => {
			viewport.removeEventListener('scroll', onScroll);
		};
	});
</script>

<Card class="bg-card/80 block">
	<CardHeader class="gap-3">
		<CardTitle class="text-lg">Recent Events</CardTitle>
	</CardHeader>
	<CardContent>
		{#if events.length === 0}
			<p
				class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground"
			>
				No recent events yet.
			</p>
		{:else}
			<ScrollArea class="h-56" viewportRef={eventsViewport}>
				<div class="space-y-1 pr-3">
					{#each visibleEvents as event (event.id)}
						<div class="rounded-md border border-border/70 bg-background/50 px-3 py-2">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span
											class={`inline-flex size-2 shrink-0 rounded-full ${getEventDotClass(event.kind)}`}
											style={usesPointsTone(event.kind)
												? 'background-color: color-mix(in oklch, var(--primary) 72%, var(--background));'
												: undefined}
										></span>
										<p class="truncate text-sm font-medium">{event.login}</p>
									</div>
									<p class="truncate text-xs text-muted-foreground">{getEventLabel(event.kind)}</p>
								</div>
								<div class="shrink-0 text-right">
									<p
										class={`text-sm font-medium tabular-nums ${
											event.pointsDelta !== null && event.pointsDelta > 0
												? 'text-emerald-700 dark:text-emerald-400'
												: 'text-muted-foreground'
										}`}
									>
										{event.pointsDelta !== null ? `+${event.pointsDelta.toLocaleString('en-GB')}` : '-'}
									</p>
									<Tooltip.Root>
										<Tooltip.Trigger aria-label={formatExactTime(event.occurredAtMs)}>
											{#snippet child({ props })}
												{@const { type: _type, ...triggerProps } = props}
												<span
													{...triggerProps}
													class="inline-flex text-xs text-muted-foreground tabular-nums"
												>
													{formatRelativeTime(event.occurredAtMs)}
												</span>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content side="top" sideOffset={8}>
											{formatExactTime(event.occurredAtMs)}
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
