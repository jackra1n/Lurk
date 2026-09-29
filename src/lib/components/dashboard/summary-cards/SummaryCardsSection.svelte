<script lang="ts">
  import EarningsCard from './EarningsCard.svelte';
  import WatchingNowCard from './WatchingNowCard.svelte';
  import type { DashboardSummaryResponse, MinerStatusResponse } from '../shared/types';

  let {
    minerStatus,
    summary
  }: {
    minerStatus: MinerStatusResponse;
    summary: DashboardSummaryResponse | null;
  } = $props();

  const emptyEarnings = { total: 0, watch: 0, claim: 0, streak: 0, other: 0 };
</script>

<section class="grid gap-4 md:grid-cols-3">
  <WatchingNowCard
    watching={summary?.watching ?? []}
    streamerRuntimeStates={minerStatus.streamerRuntimeStates}
    minerRunning={minerStatus.running} />
  <EarningsCard
    earnings={summary?.earnings.last24h ?? emptyEarnings}
    dailyAverage={summary?.earnings.dailyAverage ?? null}
    allTime={summary?.earnings.allTime ?? 0}
    sinceMs={summary?.earnings.sinceMs ?? null} />
</section>
