<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import Square from '@lucide/svelte/icons/square';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { formatDuration } from '../shared/format';
  import type { MinerStatusResponse } from '../shared/types';

  let {
    minerStatus,
    startDisabled = false,
    stopDisabled = false,
    actionPhase = 'idle',
    onStart,
    onStop
  }: {
    minerStatus: MinerStatusResponse;
    startDisabled?: boolean;
    stopDisabled?: boolean;
    actionPhase?: 'idle' | 'starting' | 'stopping';
    onStart?: () => void | Promise<void>;
    onStop?: () => void | Promise<void>;
  } = $props();

  let dialogOpen = $state(false);

  const isStarting = $derived(actionPhase === 'starting' || minerStatus.lifecycle === 'starting');
  const canStop = $derived(!isStarting && minerStatus.running);
  const uptime = $derived(
    minerStatus.running && minerStatus.startedAtMs !== null
      ? formatDuration(Date.now() - minerStatus.startedAtMs)
      : null
  );

  const label = $derived.by(() => {
    if (isStarting) return 'Starting';
    if (minerStatus.running) return 'Running';
    if (minerStatus.lifecycle === 'authenticating') return 'Waiting';
    if (minerStatus.lifecycle === 'error') return 'Attention';
    return 'Stopped';
  });

  const dotClass = $derived.by(() => {
    if (isStarting || minerStatus.lifecycle === 'authenticating') return 'bg-amber-400';
    if (minerStatus.running) return 'bg-emerald-500';
    if (minerStatus.lifecycle === 'error') return 'bg-red-500';
    return 'bg-muted-foreground/60';
  });

  const description = $derived.by(() => {
    if (isStarting) return 'Miner startup is in progress.';
    if (minerStatus.running) return 'Miner is running and monitoring configured channels.';
    if (minerStatus.lifecycle === 'ready') return 'Twitch is connected. Miner can be started now.';
    if (minerStatus.lifecycle === 'authenticating') return 'Waiting for Twitch device authorization to complete.';
    if (minerStatus.reason === 'missing_token') return 'Miner is stopped because no Twitch token is configured yet.';
    if (minerStatus.reason === 'invalid_token') return 'Stored token is invalid. Reconnect Twitch to continue.';
    if (minerStatus.reason === 'startup_failed') return 'Miner startup failed. Check logs for details.';
    return 'Miner is stopped.';
  });

  const stop = async () => {
    await onStop?.();
    dialogOpen = false;
  };

  const start = async () => {
    await onStart?.();
    dialogOpen = false;
  };
</script>

<Tooltip.Root>
  <Tooltip.Trigger
    type="button"
    class="inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    onclick={() => (dialogOpen = true)}
    aria-label="Open miner controls">
    <span class={`size-2 rounded-full ${dotClass}`} aria-hidden="true"></span>
    <span>{label}</span>
    {#if uptime}
      <span class="hidden tabular-nums sm:inline">· {uptime}</span>
    {/if}
  </Tooltip.Trigger>
  <Tooltip.Content side="bottom" sideOffset={8}>
    {description}
  </Tooltip.Content>
</Tooltip.Root>

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <span class={`size-2.5 rounded-full ${dotClass}`} aria-hidden="true"></span>
        Miner {label.toLowerCase()}
      </Dialog.Title>
      <Dialog.Description>
        {description}
        {#if uptime}
          Up for {uptime}.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      {#if canStop}
        <p class="text-sm text-muted-foreground sm:mr-auto sm:self-center">Stopping pauses point collection.</p>
        <Button type="button" variant="destructive" disabled={stopDisabled} onclick={stop}>
          <Square class="size-4" />
          {actionPhase === 'stopping' ? 'Stopping...' : 'Stop Miner'}
        </Button>
      {:else}
        <Button type="button" disabled={startDisabled || isStarting} onclick={start}>
          <Play class="size-4" />
          {isStarting ? 'Starting...' : 'Start Miner'}
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
