/**
 * Indian financial year (FY) — 1 April to 31 March. The one place FY dates are worked out: yearly views
 * offer it next to the calendar year (Jan–Dec), and document numbers use its label.
 *
 *   FY 2026–27 = 2026-04-01 … 2027-03-31 (inclusive), months Apr 2026 … Mar 2027
 *
 * A FY is identified by the calendar year it starts in (2026 → FY 2026–27).
 */

/** The start year of the FY a yyyy-MM-dd (or yyyy-MM) date falls in: 2026-03-31 → 2025, 2026-04-01 → 2026. */
export const fyStartYear = (iso: string) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1)

/** "FY 2026–27". */
export const fyName = (startYear: number) => `FY ${startYear}–${String(startYear + 1).slice(2)}`

/** First and last day, inclusive. */
export const fyRange = (startYear: number) => ({ from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` })

/** The twelve yyyy-MM months, April first. */
export const fyMonths = (startYear: number) =>
  Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1
    return `${m >= 4 ? startYear : startYear + 1}-${String(m).padStart(2, "0")}`
  })

/** Predicate for records dated in the FY. */
export const inFY = (startYear: number) => {
  const { from, to } = fyRange(startYear)
  return (e: { date: string }) => e.date >= from && e.date <= to
}

/** Short label used in document numbers, e.g. 2026-10-05 → "26-27". */
export function fyLabel(iso: string) {
  const start = fyStartYear(iso)
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`
}

/** First day of the FY a date falls in, e.g. 2026-10-05 → "2026-04-01". */
export const fyStart = (iso: string) => fyRange(fyStartYear(iso)).from
