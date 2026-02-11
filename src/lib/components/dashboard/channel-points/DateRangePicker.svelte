<script lang="ts">
	import { Popover } from 'bits-ui';
	import { getLocalTimeZone, parseDate, type DateValue } from '@internationalized/date';
	import CalendarRange from '@lucide/svelte/icons/calendar-range';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { RangeCalendar } from '$lib/components/ui/range-calendar';

	let {
		rangeFromMs,
		rangeToMs,
		onApply,
		disabled = false
	}: {
		rangeFromMs: number;
		rangeToMs: number;
		onApply: (range: { fromMs: number; toMs: number }) => void | Promise<void>;
		disabled?: boolean;
	} = $props();

	let open = $state(false);
	type DateRangeValue = { start: DateValue | undefined; end: DateValue | undefined };
	const localTimeZone = getLocalTimeZone();
	let selectedRange = $state<DateRangeValue>({ start: undefined, end: undefined });

	const pad = (value: number) => String(value).padStart(2, '0');
	const toDateValue = (valueMs: number) => {
		const date = new Date(valueMs);
		return parseDate(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
	};

	const toDayStartMs = (value: DateValue) => value.toDate(localTimeZone).getTime();
	const toDayEndMs = (value: DateValue) => value.add({ days: 1 }).toDate(localTimeZone).getTime() - 1;
	const formatDate = (valueMs: number) => new Date(valueMs).toLocaleDateString('en-GB');
	const isSameLocalDay = (leftMs: number, rightMs: number) => {
		const left = new Date(leftMs);
		const right = new Date(rightMs);

		return (
			left.getFullYear() === right.getFullYear() &&
			left.getMonth() === right.getMonth() &&
			left.getDate() === right.getDate()
		);
	};
	const rangeLabel = $derived.by(() =>
		isSameLocalDay(rangeFromMs, rangeToMs)
			? formatDate(rangeFromMs)
			: `${formatDate(rangeFromMs)} - ${formatDate(rangeToMs)}`
	);
	const canApply = $derived(Boolean(selectedRange.start && selectedRange.end));
	const syncSelectedRange = () => {
		selectedRange = {
			start: toDateValue(rangeFromMs),
			end: toDateValue(rangeToMs)
		};
	};

	const applyRange = async () => {
		const start = selectedRange.start;
		const end = selectedRange.end;
		if (!start || !end) return;
		const nextFrom = toDayStartMs(start);
		const nextTo = toDayEndMs(end);
		if (nextFrom > nextTo) return;
		await onApply({ fromMs: nextFrom, toMs: nextTo });
		open = false;
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) syncSelectedRange();
		open = nextOpen;
	};
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
	<Popover.Trigger
		type="button"
		class={buttonVariants({ variant: 'outline', size: 'sm' })}
		{disabled}
	>
		<CalendarRange class="size-4" />
		{rangeLabel}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={4}
			align="end"
			class="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-end-2 data-[side=right]:slide-in-from-start-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-auto origin-(--bits-popover-content-transform-origin) rounded-md border p-0 shadow-md outline-hidden"
		>
			<RangeCalendar bind:value={selectedRange} numberOfMonths={1} class="rounded-md border-0" />
			<div class="flex justify-end border-t px-3 py-3">
				<Button type="button" size="sm" onclick={applyRange} disabled={disabled || !canApply}>
					Apply Range
				</Button>
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
