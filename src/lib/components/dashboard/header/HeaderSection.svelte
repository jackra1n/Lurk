<script lang="ts">
  import BrandTitle from './BrandTitle.svelte';
  import AuthStatusControl from './AuthStatusControl.svelte';
  import MinerStatusControl from './MinerStatusControl.svelte';
  import ThemeSwitch from './ThemeSwitch.svelte';
  import type { AuthStatusResponse, MinerStatusResponse } from '../shared/types';

  let {
    authStatus,
    minerStatus,
    loadingStartAfterAuth = false,
    startDisabled = false,
    stopDisabled = false,
    actionPhase = 'idle',
    isDark,
    onAuthStatusChange,
    onStart,
    onStop,
    onToggleTheme
  }: {
    authStatus: AuthStatusResponse;
    minerStatus: MinerStatusResponse;
    loadingStartAfterAuth?: boolean;
    startDisabled?: boolean;
    stopDisabled?: boolean;
    actionPhase?: 'idle' | 'starting' | 'stopping';
    isDark: boolean;
    onAuthStatusChange?: () => void | Promise<void>;
    onStart?: () => void | Promise<void>;
    onStop?: () => void | Promise<void>;
    onToggleTheme: () => void;
  } = $props();
</script>

<header class="flex items-center justify-between gap-3">
  <BrandTitle />
  <div class="flex items-center gap-2">
    <MinerStatusControl {minerStatus} {startDisabled} {stopDisabled} {actionPhase} {onStart} {onStop} />
    <AuthStatusControl {authStatus} {loadingStartAfterAuth} {onAuthStatusChange} />
    <ThemeSwitch {isDark} onToggle={onToggleTheme} />
  </div>
</header>
