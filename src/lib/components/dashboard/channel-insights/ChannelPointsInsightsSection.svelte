<script lang="ts">
  import ActivityFeedCard from './ActivityFeedCard.svelte';
  import MissedTimeCard from './MissedTimeCard.svelte';
  import type { ActivityFeedItem, MissedTimeItem } from '../shared/types';

  let {
    feed = [],
    missed = [],
    days = 7
  }: {
    feed?: ActivityFeedItem[];
    missed?: MissedTimeItem[];
    days?: number;
  } = $props();
</script>

<section class="grid gap-4 md:grid-cols-2">
  <ActivityFeedCard items={feed} />
  <MissedTimeCard items={missed} {days} />
</section>
