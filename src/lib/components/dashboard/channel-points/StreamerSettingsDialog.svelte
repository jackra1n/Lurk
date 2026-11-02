<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Input } from '$lib/components/ui/input';
  import { parseStreamerLogin } from '$lib/streamers';
  import StreamerAvatar from '../shared/StreamerAvatar.svelte';

  let {
    streamers,
    profileImages,
    onSaved
  }: {
    streamers: string[];
    profileImages: ReadonlyMap<string, string | null>;
    onSaved: () => void | Promise<void>;
  } = $props();

  let open = $state(false);
  let draft = $state<string[]>([]);
  let input = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let dragIndex = $state<number | null>(null);

  const changed = $derived(draft.join() !== streamers.join());

  export const show = () => {
    draft = [...streamers];
    input = '';
    error = null;
    open = true;
  };

  const addFromInput = () => {
    const entries = input.split(/[\s,]+/).filter(Boolean);
    const invalid = entries.filter((entry) => !parseStreamerLogin(entry));
    const logins = entries.flatMap((entry) => parseStreamerLogin(entry) ?? []);
    draft = [...draft, ...logins.filter((login, index) => !draft.includes(login) && logins.indexOf(login) === index)];
    input = invalid.join(' ');
    error = invalid.length > 0 ? `Not a valid Twitch name: ${invalid.join(', ')}` : null;
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.length || from === to) return;
    const next = [...draft];
    next.splice(to, 0, ...next.splice(from, 1));
    draft = next;
  };

  const remove = (index: number) => {
    draft = draft.filter((_, i) => i !== index);
  };

  const save = async () => {
    error = null;
    if (input.trim()) addFromInput();
    if (error) return;

    saving = true;
    try {
      const response = await fetch('/api/miner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setStreamers', value: draft })
      });
      const payload = (await response.json().catch(() => null)) as { success?: boolean; message?: string } | null;
      if (!response.ok || !payload?.success) throw new Error(payload?.message ?? 'Failed to save streamers');
      open = false;
      await onSaved();
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'Failed to save streamers';
    } finally {
      saving = false;
    }
  };
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Streamers</Dialog.Title>
      <Dialog.Description>
        When more streamers are live than Lurk can watch, the ones higher on this list go first. Drag to reorder.
      </Dialog.Description>
    </Dialog.Header>

    <form
      class="flex gap-2"
      onsubmit={(event) => {
				event.preventDefault();
				addFromInput();
			}}>
      <Input bind:value={input} placeholder="Name or twitch.tv link" aria-label="Streamer to add" />
      <Button type="submit" variant="outline" disabled={!input.trim()}>
        <Plus />
        Add
      </Button>
    </form>

    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}

    {#if draft.length === 0}
      <p class="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-sm text-muted-foreground">
        No streamers yet.
      </p>
    {:else}
      <ol class="max-h-80 space-y-1 overflow-y-auto">
        {#each draft as login, index (login)}
          <li
            draggable="true"
            class={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
              dragIndex === index ? 'border-primary/50 bg-primary/10' : 'border-border/70 bg-background/50'
            }`}
            ondragstart={(event) => {
							dragIndex = index;
							event.dataTransfer?.setData('text/plain', login);
						}}
            ondragover={(event) => {
							event.preventDefault();
							if (dragIndex === null || dragIndex === index) return;
							move(dragIndex, index);
							dragIndex = index;
						}}
            ondragend={() => (dragIndex = null)}>
            <GripVertical class="size-4 shrink-0 cursor-grab text-muted-foreground" />
            <span class="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            <StreamerAvatar name={login} src={profileImages.get(login) ?? null} class="size-6" />
            <span class="min-w-0 flex-1 truncate text-sm">{login}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              aria-label={`Move ${login} up`}
              disabled={index === 0}
              onclick={() => move(index, index - 1)}>
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              aria-label={`Move ${login} down`}
              disabled={index === draft.length - 1}
              onclick={() => move(index, index + 1)}>
              <ArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${login}`}
              onclick={() => remove(index)}>
              <X />
            </Button>
          </li>
        {/each}
      </ol>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={save} disabled={saving || (!changed && !input.trim())}>
        {#if saving}
          <LoaderCircle class="animate-spin" />
        {/if}
        Save
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
