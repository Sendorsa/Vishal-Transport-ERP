/**
 * Calendar quarters — calculated from the same transactions as monthly / yearly reports, never
 * stored. Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.
 */
export type Quarter = 1 | 2 | 3 | 4
export const QUARTERS: Quarter[] = [1, 2, 3, 4]

export const QUARTER_MONTHS: Record<Quarter, string> = { 1: "Jan – Mar", 2: "Apr – Jun", 3: "Jul – Sep", 4: "Oct – Dec" }

/** The quarter a yyyy-MM month (or yyyy-MM-dd date) falls in. */
export const quarterOf = (date: string) => (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1) as Quarter

/** The three yyyy-MM months of a quarter. */
export const quarterMonths = (year: string, q: Quarter) => [1, 2, 3].map((i) => `${year}-${String((q - 1) * 3 + i).padStart(2, "0")}`)

/** Predicate for entries dated in that quarter. */
export const inQuarter = (year: string, q: Quarter) => (e: { date: string }) => e.date.startsWith(year) && quarterOf(e.date) === q

export const quarterLabel = (year: string, q: Quarter) => `Q${q} ${year}`

/** Change between two values: difference and % (null when the earlier value is 0). */
export function change(from: number, to: number) {
  return { diff: to - from, pct: from ? ((to - from) / from) * 100 : null }
}
