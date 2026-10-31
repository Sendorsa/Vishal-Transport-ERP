/**
 * Dated history ("what was true on day X"). Each period runs startDate → endDate (inclusive,
 * yyyy-MM-dd; endDate null = still current). Built for status today; the same helpers fit
 * vehicle transfers / customer assignment later (a period carrying a customerId instead).
 *
 * Rule: month views resolve values with `statusOn(entity, asOfMonth(month, today))`,
 * never from the entity's current `status`.
 */
import { endOfMonth, format, parseISO, subDays } from "date-fns"
import type { StatusPeriod } from "@/lib/types"

export interface Span {
  startDate: string
  endDate: string | null
}

/** The period covering `date`, if any. */
export function periodOn<P extends Span>(history: P[], date: string): P | null {
  return history.find((p) => p.startDate <= date && (p.endDate === null || date <= p.endDate)) ?? null
}

const dayBefore = (date: string) => format(subDays(parseISO(date), 1), "yyyy-MM-dd")

/**
 * Closes the open period the day before `date` and opens `next` from `date`. History is only
 * appended to; a change on the same day as the last one replaces it (no zero-length periods).
 */
export function appendPeriod<P extends Span>(history: P[], next: Omit<P, keyof Span>, date: string, same: (a: P, b: Omit<P, keyof Span>) => boolean): P[] {
  const last = history.at(-1)
  if (last && last.endDate === null && same(last, next)) return history
  if (last && last.startDate >= date) {
    const before = history.slice(0, -1)
    const prev = before.at(-1)
    // Same-day undo (archive then restore today): reopen the previous period instead.
    if (prev && same(prev, next)) return [...before.slice(0, -1), { ...prev, endDate: null }]
    return [...before, { ...last, ...next, endDate: null }]
  }
  const closed = last ? [...history.slice(0, -1), { ...last, endDate: dayBefore(date) }] : []
  return [...closed, { ...next, startDate: date, endDate: null } as P]
}

/* ------------------------------------------------------------------ status */

interface HasStatus<S extends string> {
  status: S
  statusHistory?: StatusPeriod<S>[]
  createdAt: string
  updatedAt: string
}

/**
 * The entity's status history. Records saved before history existed get one inferred:
 * ACTIVE from creation, and — if the status is no longer ACTIVE — that status from the last
 * update (when the archive / status change was saved).
 */
export function historyOf<S extends string>(e: HasStatus<S>): StatusPeriod<S>[] {
  if (e.statusHistory?.length) return e.statusHistory
  const created = e.createdAt.slice(0, 10)
  const changed = e.updatedAt.slice(0, 10)
  if (e.status === "ACTIVE" || changed <= created) return [{ status: e.status, startDate: created, endDate: null }]
  return appendPeriod<StatusPeriod<S>>([{ status: "ACTIVE" as S, startDate: created, endDate: null }], { status: e.status }, changed, (a, b) => a.status === b.status)
}

/** Status on a date. Before the first period the first status applies. */
export function statusOn<S extends string>(e: HasStatus<S>, date: string): S {
  const h = historyOf(e)
  return (periodOn(h, date) ?? (date < h[0].startDate ? h[0] : h.at(-1)!)).status
}

/** History after changing to `status` on `date` (appended, never rewritten). */
export function withStatus<S extends string>(e: HasStatus<S>, status: S, date: string): StatusPeriod<S>[] {
  return appendPeriod(historyOf(e), { status }, date, (a, b) => a.status === b.status)
}

/** The day a month is judged on: its last day, or today for the month in progress. */
export function asOfMonth(month: string, todayIso: string) {
  const end = format(endOfMonth(parseISO(`${month}-01`)), "yyyy-MM-dd")
  return end < todayIso ? end : todayIso
}
