// Background jobs: what Ajé does with the app closed, and when. The page asks the shell to wake it at
// nextWake (wakeAt); at that time the shell loads background.html without a window, or sends a wake
// event to the open page, and either one runs `wake`. The shell decides nothing: every rule of when
// lives here. Each job is {id, nextAt(state, now), run(ctx)}; `run` may return fields to keep in its
// record, which jobRuns holds as {at, ok, fails, ...}, `fails` counting the failures of the day of `at`.
import { nextAt as ruleNextAt } from "./automations.js";
import { runRule } from "./autorun.js";
import { checkForUpdate, shouldAutoCheck } from "./update.js";

/** Nothing runs from 22:00 to 7:00: a USSD holds the line and a notice at night is a nuisance. */
export const NIGHT_FROM = 22;
export const DAY_FROM = 7;
/** A failed job tries again an hour later, three times a day at most, then waits for its next slot. */
export const RETRY_MS = 3_600_000;
export const MAX_FAILS = 3;
const FLUSH_MS = 10_000;
const HOURS_UPDATE = [7, 13, 19];

const dayOf = (t) => new Date(t).toDateString();

/** The first of `hours` (local, on the hour) strictly after `t`. */
export function nextSlot(hours, t) {
  const d = new Date(t);
  for (let add = 0; add < 2; add++) {
    for (const h of hours) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, h).getTime();
      if (at > t) return at;
    }
  }
  return null;
}

/** `t`, or 7:00 when `t` falls in the night. */
export function daytime(t) {
  const d = new Date(t);
  if (d.getHours() >= NIGHT_FROM) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, DAY_FROM).getTime();
  if (d.getHours() < DAY_FROM) return new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_FROM).getTime();
  return t;
}

/** When a job on `hours` is due again: its next slot, or an hour after a failure while it has retries left today. */
function onHours(hours) {
  return (run) => {
    if (!run) return 0; // never ran: due now
    if (!run.ok && run.fails < MAX_FAILS) return run.at + RETRY_MS;
    return nextSlot(hours, run.at);
  };
}

const currentCode = (config) => Number(config.versionCode ?? 0);

/** Looks for a newer release in the person's channel and notifies it once per version. */
export const updateJob = {
  id: "update",
  nextAt: (state) => onHours(HOURS_UPDATE)(state.jobRuns.update),
  async run({ store, bridge, config, fetch, now }) {
    const s = store.state;
    const channel = s.settings.channel;
    // The open app checks at most once an hour; a check that recent is reused, not repeated.
    let found = s.update.available;
    if (shouldAutoCheck(s.update.checkedAt, now)) {
      found = await checkForUpdate({ fetch, channel, currentCode: currentCode(config) });
      await store.setUpdate({ checkedAt: now, available: found });
    }
    const u = found && found.versionCode > currentCode(config) ? found : null;
    const notified = s.jobRuns.update?.notified ?? null;
    if (!u || u.version === notified) return { notified };
    await bridge.notify({
      id: `update:${u.version}`, channel: "updates", route: "home",
      title: `Ajé ${u.version} disponible`, text: u.prerelease ? "Una beta nueva. Toca para actualizar." : "Toca para actualizar.",
    });
    return { notified: u.version };
  },
};

/** Pays saved services by rule (web/core/autorun.js): the due rules, one at a time, in the order saved. */
export const automationJob = {
  id: "automations",
  nextAt(state, now) {
    if (!state.settings.automation?.on) return Infinity;
    return Math.min(Infinity, ...state.automations.map((r) => ruleNextAt(r, now)).filter((t) => t !== null));
  },
  async run(ctx) {
    const done = [];
    for (const rule of ctx.store.state.automations) {
      const r = ctx.store.state.automations.find((x) => x.id === rule.id);
      if (!r || !ctx.store.state.settings.automation.on) continue;
      const at = ruleNextAt(r, ctx.now);
      if (at === null || at > ctx.now) continue;
      try {
        done.push(await runRule(ctx, r, ctx.now));
      } catch {
        // Counted as a failure, so the rule waits an hour instead of waking Ajé again at once.
        const fails = r.last && new Date(r.last.at).toDateString() === new Date(ctx.now).toDateString() ? r.last.failsToday : 0;
        await ctx.store.patchAutomation(r.id, { last: { at: ctx.now, outcome: "failed", failsToday: fails + 1 } });
        done.push("error");
      }
    }
    return { outcomes: done };
  },
};

export const JOBS = [updateJob, automationJob];

/** When the shell should wake Ajé next: the earliest job, never in the past, moved out of the night. */
export function nextWake(state, now, jobs = JOBS) {
  const at = Math.min(...jobs.map((j) => j.nextAt(state, now)));
  return daytime(Math.max(at, now));
}

/** Runs, in order and one at a time, the jobs that are due, and records each one's result. Night runs nothing. */
export async function runDue(ctx, now, jobs = JOBS) {
  if (daytime(now) !== now) return [];
  const done = [];
  for (const job of jobs) {
    if (job.nextAt(ctx.store.state, now) > now) continue;
    const prev = ctx.store.state.jobRuns[job.id] ?? {};
    const failsToday = prev.at && dayOf(prev.at) === dayOf(now) ? prev.fails : 0;
    try {
      const kept = await job.run({ ...ctx, now });
      await ctx.store.setJobRun(job.id, { ...prev, ...kept, at: now, ok: true, fails: failsToday });
      done.push(`${job.id}:ok`);
    } catch {
      await ctx.store.setJobRun(job.id, { ...prev, at: now, ok: false, fails: failsToday + 1 });
      done.push(`${job.id}:error`);
    }
  }
  return done;
}

/**
 * One wake-up, in the page without a window or the open one: the due jobs, then the next wake-up, then
 * done, which lets the shell close the page. The last two run whatever a job does. `at` is when this
 * wake-up was asked for, so telemetry can measure how late Android ran it.
 */
export async function wake(ctx, at, jobs = JOBS) {
  const now = ctx.now ?? Date.now;
  try {
    const ran = await runDue(ctx, now(), jobs);
    if (at) {
      ctx.telemetry?.event("wake", { late_min: Math.max(0, Math.round((now() - at) / 60_000)), jobs: ran.join(" ") });
      // The shell closes the page on done: give the event a moment to leave.
      let timer;
      await Promise.race([ctx.telemetry?.flush(), new Promise((r) => { timer = setTimeout(r, FLUSH_MS); })]);
      clearTimeout(timer);
    }
  } finally {
    try {
      await ctx.bridge.wakeAt(nextWake(ctx.store.state, now(), jobs));
    } finally {
      await ctx.bridge.done();
    }
  }
}
