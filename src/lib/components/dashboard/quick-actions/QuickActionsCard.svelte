<script lang="ts">
	import Play from '@lucide/svelte/icons/play';
	import Square from '@lucide/svelte/icons/square';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { MinerLifecycle } from '../shared/types';

	let {
		minerRunning,
		lifecycle,
		startDisabled = false,
		stopDisabled = false,
		actionPhase = 'idle',
		onStart,
		onStop
	}: {
		minerRunning: boolean;
		lifecycle: MinerLifecycle;
		startDisabled?: boolean;
		stopDisabled?: boolean;
		actionPhase?: 'idle' | 'starting' | 'stopping';
		onStart?: () => void | Promise<void>;
		onStop?: () => void | Promise<void>;
	} = $props();

	const showStartingState = $derived(actionPhase === 'starting' || lifecycle === 'starting');
	const showStopState = $derived(!showStartingState && minerRunning);
</script>

<section>
	<Card class="bg-card/80">
		<CardHeader>
			<CardTitle class="text-lg">Quick Actions</CardTitle>
		</CardHeader>
		<CardContent class="space-y-2">
			{#if showStopState}
				<Button
					class="w-full justify-start"
					variant="destructive"
					disabled={stopDisabled || actionPhase === 'stopping'}
					onclick={onStop}
				>
					<Square class="size-4" />
					{actionPhase === 'stopping' ? 'Stopping...' : 'Stop Miner'}
				</Button>
			{:else}
				<Button
					class="w-full justify-start"
					variant="secondary"
					disabled={startDisabled || showStartingState}
					onclick={onStart}
				>
					<Play class="size-4" />
					{showStartingState ? 'Starting...' : 'Start Miner'}
				</Button>
			{/if}
		</CardContent>
	</Card>
</section>
