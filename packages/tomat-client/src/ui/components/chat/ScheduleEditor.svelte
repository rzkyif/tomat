<!-- Editor for one ScheduleSpec: a kind select plus the fields that kind
     needs. Controlled component (value + onchange), shared by the in-chat
     schedule confirm form and the Scheduled Prompt detail view in Settings.
     Edits always produce a structurally valid spec; the one thing a parent
     may still want to check is a "once" date-time that is already past. -->
<script lang="ts">
  import type { ScheduleSpec } from "@tomat/shared";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import Select from "@tomat/shared/ui/components/primitives/Select.svelte";

  let {
    schedule,
    onchange,
    disabled = false,
  }: {
    schedule: ScheduleSpec;
    onchange: (next: ScheduleSpec) => void;
    disabled?: boolean;
  } = $props();

  const KIND_OPTIONS = [
    { value: "once", label: "Once" },
    { value: "interval", label: "Interval" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "yearly", label: "Yearly" },
  ];

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const MONTH_OPTIONS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ].map((label, i) => ({ value: i + 1, label }));

  function pad(n: number): string {
    return String(n).padStart(2, "0");
  }

  /** Epoch ms -> the local "YYYY-MM-DDTHH:MM" a datetime-local input wants. */
  function toLocalInput(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${
      pad(d.getMinutes())
    }`;
  }

  function fromLocalInput(text: string): number | null {
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
    return Number.isFinite(t) ? t : null;
  }

  /** Hour/minute carried between kinds so switching doesn't lose the time. */
  function timeOf(spec: ScheduleSpec): { hour: number; minute: number } {
    if (spec.kind === "weekly" || spec.kind === "monthly" || spec.kind === "yearly") {
      return { hour: spec.hour, minute: spec.minute };
    }
    if (spec.kind === "once") {
      const d = new Date(spec.atMs);
      return { hour: d.getHours(), minute: d.getMinutes() };
    }
    return { hour: 9, minute: 0 };
  }

  function switchKind(kind: string): void {
    if (kind === schedule.kind) return;
    const { hour, minute } = timeOf(schedule);
    switch (kind) {
      case "once": {
        // Default to this time tomorrow so the spec starts out in the future.
        const now = new Date();
        const atMs = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() + 1,
          hour,
          minute,
          0,
          0,
        ).getTime();
        onchange({ kind: "once", atMs });
        return;
      }
      case "interval":
        onchange({ kind: "interval", everyMinutes: 60 });
        return;
      case "weekly":
        onchange({ kind: "weekly", weekdays: [1], hour, minute });
        return;
      case "monthly":
        onchange({ kind: "monthly", day: 1, hour, minute });
        return;
      case "yearly":
        onchange({ kind: "yearly", month: 1, day: 1, hour, minute });
        return;
    }
  }

  function toggleWeekday(day: number): void {
    if (schedule.kind !== "weekly") return;
    const has = schedule.weekdays.includes(day);
    // Keep at least one weekday selected so the spec stays valid.
    if (has && schedule.weekdays.length === 1) return;
    const weekdays = has
      ? schedule.weekdays.filter((d) => d !== day)
      : [...schedule.weekdays, day].sort((a, b) => a - b);
    onchange({ ...schedule, weekdays });
  }

  function setTime(text: string): void {
    if (schedule.kind === "once" || schedule.kind === "interval") return;
    const m = text.match(/^(\d{2}):(\d{2})/);
    if (!m) return;
    onchange({ ...schedule, hour: +m[1], minute: +m[2] });
  }

  function setIntField(key: "day" | "everyMinutes", raw: string, min: number, max: number): void {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    onchange({ ...schedule, [key]: Math.min(max, Math.max(min, n)) } as ScheduleSpec);
  }

  const rawInputClass =
    "bg-surface-inset text-default-800 rounded-medium h-8 px-2 text-sm outline-none focus:ring-blue-500";
</script>

<div class="flex flex-col gap-2 text-sm {disabled ? 'opacity-60 pointer-events-none' : ''}">
  <div class="flex items-center gap-2">
    <span class="text-xs text-default-600 w-16 shrink-0">Repeat</span>
    <Select
      value={schedule.kind}
      options={KIND_OPTIONS}
      onchange={switchKind}
      {disabled}
      ariaLabel="Repeat"
      class="max-w-44"
    />
  </div>

  {#if schedule.kind === "once"}
    <div class="flex items-center gap-2">
      <span class="text-xs text-default-600 w-16 shrink-0">When</span>
      <input
        type="datetime-local"
        class={rawInputClass}
        value={toLocalInput(schedule.atMs)}
        aria-label="Date and time"
        {disabled}
        onchange={(e) => {
          const ms = fromLocalInput((e.target as HTMLInputElement).value);
          if (ms !== null) onchange({ kind: "once", atMs: ms });
        }}
      />
    </div>
  {:else if schedule.kind === "interval"}
    <div class="flex items-center gap-2">
      <span class="text-xs text-default-600 w-16 shrink-0">Every</span>
      <div class="w-24">
        <Input
          type="number"
          value={schedule.everyMinutes}
          min={1}
          max={10080}
          {disabled}
          ariaLabel="Minutes between runs"
          onchange={(v) => setIntField("everyMinutes", v, 1, 10080)}
        />
      </div>
      <span class="text-xs text-default-600">minutes</span>
    </div>
  {:else}
    {#if schedule.kind === "weekly"}
      <div class="flex items-center gap-2">
        <span class="text-xs text-default-600 w-16 shrink-0">Days</span>
        <div class="flex flex-wrap gap-1">
          {#each WEEKDAYS as label, day}
            {@const active = schedule.weekdays.includes(day)}
            <button
              type="button"
              {disabled}
              aria-pressed={active}
              class="px-2 h-7 rounded-medium text-xs font-medium transition-colors hover:cursor-pointer {active
                ? 'bg-blue-500 text-white'
                : 'bg-surface-inset text-default-700 hover:text-default-900'}"
              onclick={() => toggleWeekday(day)}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>
    {:else if schedule.kind === "monthly"}
      <div class="flex items-center gap-2">
        <span class="text-xs text-default-600 w-16 shrink-0">Day</span>
        <div class="w-24">
          <Input
            type="number"
            value={schedule.day}
            min={1}
            max={31}
            {disabled}
            ariaLabel="Day of the month"
            onchange={(v) => setIntField("day", v, 1, 31)}
          />
        </div>
        <span class="text-xs text-default-600">of the month</span>
      </div>
    {:else if schedule.kind === "yearly"}
      <div class="flex items-center gap-2">
        <span class="text-xs text-default-600 w-16 shrink-0">Date</span>
        <Select
          value={schedule.month}
          options={MONTH_OPTIONS}
          onchange={(v) => onchange({ ...schedule, month: Number(v) } as ScheduleSpec)}
          {disabled}
          ariaLabel="Month"
          class="max-w-36"
        />
        <div class="w-20">
          <Input
            type="number"
            value={schedule.day}
            min={1}
            max={31}
            {disabled}
            ariaLabel="Day of the month"
            onchange={(v) => setIntField("day", v, 1, 31)}
          />
        </div>
      </div>
    {/if}
    <div class="flex items-center gap-2">
      <span class="text-xs text-default-600 w-16 shrink-0">Time</span>
      <input
        type="time"
        class={rawInputClass}
        value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
        aria-label="Time of day"
        {disabled}
        onchange={(e) => setTime((e.target as HTMLInputElement).value)}
      />
    </div>
  {/if}
</div>
