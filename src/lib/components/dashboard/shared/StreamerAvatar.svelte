<script lang="ts">
  import { cn } from '$lib/utils';

  let {
    name,
    src,
    class: className
  }: {
    name: string;
    src: string | null;
    class?: string;
  } = $props();

  let failedSrc = $state<string | null>(null);
  const showImage = $derived(src !== null && src !== failedSrc);
</script>

{#if showImage}
  <img
    {src}
    alt=""
    loading="lazy"
    referrerpolicy="no-referrer"
    class={cn('size-8 shrink-0 rounded-full bg-muted object-cover', className)}
    onerror={() => (failedSrc = src)}>
{:else}
  <span
    class={cn(
      'inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground',
      className
    )}
    aria-hidden="true">
    {name.slice(0, 1)}
  </span>
{/if}
