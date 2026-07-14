export type SchedulerName = "gmail_poll" | "upi_correlation" | "automatic_inference";

interface SchedulerState {
  name: SchedulerName;
  label: string;
  interval_minutes: number;
  schedule: string;
  enabled: boolean;
  running: boolean;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_failed_at: string | null;
  last_error: string | null;
  last_outcome: "success" | "error" | null;
}

export interface SchedulerHealth extends SchedulerState {
  next_tick_at: string;
  next_run_at: string | null;
  next_run_in_seconds: number | null;
}

const schedulerStates = new Map<SchedulerName, SchedulerState>();

export function normalizeCronInterval(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Math.min(59, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

export function nextCronTick(intervalMinutes: number, now = new Date()): Date {
  const interval = normalizeCronInterval(intervalMinutes, 1);
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  while (next.getUTCMinutes() % interval !== 0) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  return next;
}

export function configureScheduler(
  name: SchedulerName,
  options: {
    label: string;
    interval_minutes: number;
    enabled: boolean;
    last_completed_at?: string | null;
  }
): void {
  const interval = normalizeCronInterval(options.interval_minutes, 5);
  const previous = schedulerStates.get(name);
  schedulerStates.set(name, {
    name,
    label: options.label,
    interval_minutes: interval,
    schedule: `*/${interval} * * * *`,
    enabled: options.enabled,
    running: previous?.running ?? false,
    last_started_at: previous?.last_started_at ?? null,
    last_completed_at: previous?.last_completed_at ?? options.last_completed_at ?? null,
    last_failed_at: previous?.last_failed_at ?? null,
    last_error: previous?.last_error ?? null,
    last_outcome: previous?.last_outcome ?? null,
  });
}

export async function runSchedulerCycle(name: SchedulerName, task: () => Promise<void>): Promise<void> {
  const state = schedulerStates.get(name);
  if (!state || !state.enabled || state.running) return;

  state.running = true;
  state.last_started_at = new Date().toISOString();
  try {
    await task();
    state.last_completed_at = new Date().toISOString();
    state.last_outcome = "success";
  } catch (error) {
    state.last_failed_at = new Date().toISOString();
    state.last_error = error instanceof Error ? error.message : String(error);
    state.last_outcome = "error";
    console.error(`[scheduler:${name}] cycle failed:`, error);
  } finally {
    state.running = false;
  }
}

export function getSchedulerHealth(now = new Date()): {
  next_cron_at: string | null;
  next_cron_in_seconds: number | null;
  schedulers: Record<string, SchedulerHealth>;
} {
  const schedulers: Record<string, SchedulerHealth> = {};
  let earliest: Date | null = null;

  for (const state of schedulerStates.values()) {
    const nextTick = nextCronTick(state.interval_minutes, now);
    const nextRun = state.enabled ? nextTick : null;
    if (nextRun && (!earliest || nextRun.getTime() < earliest.getTime())) earliest = nextRun;
    schedulers[state.name] = {
      ...state,
      next_tick_at: nextTick.toISOString(),
      next_run_at: nextRun?.toISOString() ?? null,
      next_run_in_seconds: nextRun
        ? Math.max(0, Math.ceil((nextRun.getTime() - now.getTime()) / 1000))
        : null,
    };
  }

  return {
    next_cron_at: earliest?.toISOString() ?? null,
    next_cron_in_seconds: earliest
      ? Math.max(0, Math.ceil((earliest.getTime() - now.getTime()) / 1000))
      : null,
    schedulers,
  };
}

export function resetSchedulerHealthForTests(): void {
  schedulerStates.clear();
}
