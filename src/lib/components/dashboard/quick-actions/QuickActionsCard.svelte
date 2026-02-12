<script lang="ts">
	import Play from '@lucide/svelte/icons/play';
	import Square from '@lucide/svelte/icons/square';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';

	let {
		minerRunning,
		startDisabled = false,
		stopDisabled = false,
		busy = false,
		onStart,
		onStop
	}: {
		minerRunning: boolean;
		startDisabled?: boolean;
		stopDisabled?: boolean;
		busy?: boolean;
		onStart?: () => void | Promise<void>;
		onStop?: () => void | Promise<void>;
	} = $props();
</script>

<section>
	<Card class="bg-card/80">
		<CardHeader>
			<CardTitle class="text-lg">Quick Actions</CardTitle>
		</CardHeader>
		<CardContent class="space-y-2">
			{#if minerRunning}
				<Button class="w-full justify-start" variant="destructive" disabled={stopDisabled} onclick={onStop}>
					<Square class="size-4" />
					{busy ? 'Stopping...' : 'Stop Miner'}
				</Button>
			{:else}
				<Button class="w-full justify-start" variant="secondary" disabled={startDisabled} onclick={onStart}>
					<Play class="size-4" />
					{busy ? 'Starting...' : 'Start Miner'}
				</Button>
			{/if}
		</CardContent>
	</Card>
</section>
