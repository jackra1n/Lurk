<script lang="ts">
	import { Card, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';

	let { pointsEarned }: { pointsEarned: number } = $props();
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-2">
		<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Points Earned This Session</p>
		<CardTitle class="text-2xl">+{pointsEarned.toLocaleString()}</CardTitle>
		<CardDescription class="text-sm">Total from active run.</CardDescription>
	</CardHeader>
</Card>
