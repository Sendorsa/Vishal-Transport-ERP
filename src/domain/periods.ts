import { addMonths, endOfMonth, format, parseISO, startOfMonth, subMonths } from "date-fns"
import { toISODate, todayDate } from "@/lib/format"
import { fyRange, fyStart, fyStartYear } from "./financial-year"

export type PeriodPreset = "this_month" | "last_month" | "last_3_months" | "last_6_months" | "fy_to_date" | "last_fy" | "all"

export interface DateRange {
  from: string
  to: string
}

export const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "last_6_months", label: "Last 6 months" },
  { value: "fy_to_date", label: "FY to date" },
  { value: "last_fy", label: "Last financial year" },
  { value: "all", label: "All time" },
]

export function rangeForPreset(preset: PeriodPreset, today = todayDate()): DateRange {
  const to = toISODate(today)
  switch (preset) {
    case "this_month":
      return { from: toISODate(startOfMonth(today)), to }
    case "last_month": {
      const m = subMonths(startOfMonth(today), 1)
      return { from: toISODate(m), to: toISODate(endOfMonth(m)) }
    }
    case "last_3_months":
      return { from: toISODate(subMonths(startOfMonth(today), 2)), to }
    case "last_6_months":
      return { from: toISODate(subMonths(startOfMonth(today), 5)), to }
    case "fy_to_date":
      return { from: fyStart(to), to }
    case "last_fy":
      return fyRange(fyStartYear(to) - 1)
    case "all":
      return { from: "2000-01-01", to }
  }
}

export function inRange(iso: string, range: DateRange) {
  return iso >= range.from && iso <= range.to
}

/** yyyy-MM keys from range start to end (inclusive), capped to `max` most recent. */
export function monthKeysInRange(range: DateRange, max = 12, earliest?: string): string[] {
  const fromIso = earliest && earliest > range.from ? earliest : range.from
  const keys: string[] = []
  for (let m = startOfMonth(parseISO(fromIso)); toISODate(m) <= range.to; m = addMonths(m, 1)) {
    keys.push(format(m, "yyyy-MM"))
  }
  return keys.slice(-max)
}
