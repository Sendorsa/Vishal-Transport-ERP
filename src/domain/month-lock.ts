/**
 * Monthly sheet lock. Employees can add or change diesel / AdBlue
 * data only while the month is open:
 *
 *   automatic   → the current month is open; once the next month starts, it locks by itself
 *   override    → the Owner, Dev or Employee can lock a month early, or unlock a closed month for users
 *   Owner, Dev  → can always edit, locked or not (owner's decision, 3 Nov 2026); the Employee follows the lock
 */
import type { MonthLock, Role } from "@/lib/types"
import { canBypassMonthLock } from "@/lib/permissions"
import { monthKey } from "@/lib/format"

export type LockState = "OPEN" | "LOCKED"

export interface MonthLockInfo {
  month: string
  /** State for employees, after any Owner override. */
  state: LockState
  /** What the calendar alone would give (current month open, past months locked). */
  auto: LockState
  /** The Owner's override, if any (who/when on the record). */
  override: MonthLock | null
}

export function monthLockInfo(month: string, todayIso: string, locks: MonthLock[]): MonthLockInfo {
  const auto: LockState = month >= monthKey(todayIso) ? "OPEN" : "LOCKED"
  const override = locks.find((l) => l.month === month) ?? null
  return { month, auto, override, state: override?.state ?? auto }
}

/** Whether `role` may add or change data dated in `month`. */
export function canEditMonth(role: Role, month: string, todayIso: string, locks: MonthLock[]) {
  return canBypassMonthLock(role) || monthLockInfo(month, todayIso, locks).state === "OPEN"
}
