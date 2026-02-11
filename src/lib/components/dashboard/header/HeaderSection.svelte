<script lang="ts">
	import BrandTitle from './BrandTitle.svelte';
	import AuthStatusControl from './AuthStatusControl.svelte';
	import ThemeSwitch from './ThemeSwitch.svelte';
	import type { AuthStatusResponse } from '../shared/types';

	let {
		authStatus,
		loadingStartAfterAuth = false,
		isDark,
		onAuthStatusChange,
		onToggleTheme
	}: {
		authStatus: AuthStatusResponse;
		loadingStartAfterAuth?: boolean;
		isDark: boolean;
		onAuthStatusChange?: () => void | Promise<void>;
		onToggleTheme: () => void;
	} = $props();
</script>

<header class="flex items-center justify-between gap-3">
	<BrandTitle />
	<div class="flex items-center gap-2">
		<AuthStatusControl {authStatus} {loadingStartAfterAuth} {onAuthStatusChange} />
		<ThemeSwitch {isDark} onToggle={onToggleTheme} />
	</div>
</header>
