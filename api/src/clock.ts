/** Time seam: the system clock in production, a hand-driven clock in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private t: number;

  constructor(start: Date | string = '2026-01-05T09:00:00.000Z') {
    this.t = typeof start === 'string' ? Date.parse(start) : start.getTime();
    if (Number.isNaN(this.t)) throw new Error(`invalid start time: ${String(start)}`);
  }

  now(): Date {
    return new Date(this.t);
  }

  advance(ms: number): Date {
    if (ms < 0) throw new Error('clock cannot go backwards');
    this.t += ms;
    return this.now();
  }

  advanceMinutes(minutes: number): Date {
    return this.advance(minutes * 60_000);
  }

  set(at: Date | string): Date {
    const next = typeof at === 'string' ? Date.parse(at) : at.getTime();
    if (next < this.t) throw new Error('clock cannot go backwards');
    this.t = next;
    return this.now();
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** UTC calendar day (YYYY-MM-DD) of an instant. Budgets and daily metrics roll over at UTC midnight. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** Milliseconds between two ISO timestamps, or null when either is missing. */
export function elapsedMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
}

/** Inclusive list of UTC days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(t) || Number.isNaN(end)) throw new Error(`invalid day range ${from}..${to}`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += DAY;
  }
  return out;
}
