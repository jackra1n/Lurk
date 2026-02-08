<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';

	let { actions }: { actions: string[] } = $props();
</script>

<section>
	<Card class="bg-card/80">
		<CardHeader>
			<CardTitle class="text-lg">Quick Actions</CardTitle>
		</CardHeader>
		<CardContent class="space-y-2">
			{#each actions as action}
				<Button class="w-full justify-start" variant="secondary" disabled>
					{action}
				</Button>
			{/each}
		</CardContent>
	</Card>
</section>
