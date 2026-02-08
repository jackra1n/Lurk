<script lang="ts">
	import { onMount } from 'svelte';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';

	const statusCards = [
		{
			label: 'Miner Status',
			value: 'Idle'
		},
		{
			label: 'Auth Status',
			value: 'Auth Required'
		},
		{
			label: 'Tracked Streamers',
			value: '0'
		}
	];

	const quickActions = ['Connect Twitch', 'Start Miner', 'Add Streamer'];
	const themeStorageKey = 'theme';
	let isDark = $state(true);

	onMount(() => {
		const root = document.documentElement;
		isDark = root.classList.contains('dark');
	});

	const toggleTheme = () => {
		const root = document.documentElement;
		const nextIsDark = !root.classList.contains('dark');

		root.classList.toggle('dark', nextIsDark);
		root.style.colorScheme = nextIsDark ? 'dark' : 'light';
		localStorage.setItem(themeStorageKey, nextIsDark ? 'dark' : 'light');
		isDark = nextIsDark;
	};
</script>

<svelte:head>
	<title>Lurk | Control Surface</title>
</svelte:head>

<div class="relative min-h-screen overflow-hidden bg-background text-foreground">
	<main class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
			<header class="flex items-center justify-between gap-3">
				<h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Lurk</h1>
				<Button type="button" variant="outline" size="sm" onclick={toggleTheme}>
					{#if isDark}
						<Moon class="size-4" />
					{:else}
						<Sun class="size-4" />
					{/if}
					{isDark ? 'Dark' : 'Light'}
				</Button>
			</header>

		<section class="grid gap-4 md:grid-cols-3">
			{#each statusCards as card}
				<Card class="bg-card/80">
					<CardHeader class="gap-2">
						<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">{card.label}</p>
						<CardTitle class="text-2xl">{card.value}</CardTitle>
					</CardHeader>
				</Card>
			{/each}
		</section>

		<section class="grid gap-4 lg:grid-cols-[2fr_1fr]">
			<Card class="bg-card/80">
				<CardHeader class="flex-row items-center justify-between gap-3">
					<div>
						<CardTitle class="text-lg">Tracked Streamers</CardTitle>
						<CardDescription class="text-sm">Manage channels monitored for points.</CardDescription>
					</div>
					<Badge variant="outline">0 tracked</Badge>
				</CardHeader>
				<CardContent>
					<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-6 text-center text-sm text-muted-foreground">
						No streamers tracked.
					</p>
				</CardContent>
			</Card>

			<Card class="bg-card/80">
				<CardHeader>
					<CardTitle class="text-lg">Quick Actions</CardTitle>
				</CardHeader>
				<CardContent class="space-y-2">
					{#each quickActions as action}
						<Button class="w-full justify-start" variant="secondary" disabled>
							{action}
						</Button>
					{/each}
				</CardContent>
			</Card>
		</section>
	</main>
</div>
