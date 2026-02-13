<script lang="ts">
	import { onMount } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import X from '@lucide/svelte/icons/x';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import type { DashboardNoticeState } from './types';

	let { autoDismissMs = 8000 }: { autoDismissMs?: number } = $props();
	let notice = $state<DashboardNoticeState | null>(null);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	const clearDismissTimer = () => {
		if (!dismissTimer) return;
		clearTimeout(dismissTimer);
		dismissTimer = null;
	};

	export const clear = () => {
		clearDismissTimer();
		notice = null;
	};

	export const setSuccess = (text: string) => {
		clearDismissTimer();
		notice = { kind: 'success', text };
		dismissTimer = setTimeout(() => {
			notice = null;
			dismissTimer = null;
		}, autoDismissMs);
	};

	export const setError = (text: string) => {
		clearDismissTimer();
		notice = { kind: 'error', text };
	};

	const dismissNotice = () => {
		clear();
	};

	onMount(() => () => clearDismissTimer());
</script>

{#if notice}
	<Alert.Root
		variant={notice.kind === 'error' ? 'destructive' : 'default'}
		class={notice.kind === 'error' ? 'border-destructive/40 bg-destructive/10 pr-12' : 'border-border/70 bg-muted/40 pr-12'}
	>
		{#if notice.kind === 'error'}
			<CircleAlert class="size-4 text-destructive" />
		{:else}
			<CircleCheck class="size-4 text-emerald-500" />
		{/if}
		<Alert.Description class={notice.kind === 'error' ? '' : 'text-muted-foreground'}>
			<p>{notice.text}</p>
		</Alert.Description>
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			class="absolute right-2 top-2"
			aria-label="Dismiss message"
			onclick={dismissNotice}
		>
			<X class="size-4" />
		</Button>
	</Alert.Root>
{/if}
