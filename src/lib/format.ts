import { format, parseISO } from "date-fns"

/** Money is always exact: ₹ symbol, Indian commas, 2 decimals — never rounded or abbreviated. */
const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 })
const num2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 })

/** ₹12,34,567.89 — every money value in the app. */
export function formatINR(value: number) {
  if (!Number.isFinite(value)) return "—"
  return inr.format(value)
}

/**
 * Chart-axis scale labels only (₹30 L, ₹1.2 Cr). Never for a figure: values, cards, tables and
 * tooltips use formatINR.
 */
export function formatAxisINR(value: number) {
  if (!Number.isFinite(value)) return "—"
  const sign = value < 0 ? "-" : ""
  const v = Math.abs(value)
  if (v >= 1e7) return `${sign}₹${+(v / 1e7).toFixed(2)} Cr`
  if (v >= 1e5) return `${sign}₹${+(v / 1e5).toFixed(2)} L`
  if (v >= 1e3) return `${sign}₹${+(v / 1e3).toFixed(1)} K`
  return `${sign}₹${v.toFixed(0)}`
}

export function formatNumber(value: number, decimals = 0) {
  return (decimals ? num2 : num).format(value)
}

/** "1,234.5 L" — litres with up to 2 decimals. */
export function formatLitres(value: number) {
  return `${formatNumber(value, 2)} L`
}

export function formatPercent(value: number, decimals = 1) {
  if (!Number.isFinite(value)) return "—"
  return `${value.toFixed(decimals)}%`
}

/** dd-MM-yyyy */
export function formatDate(iso: string | null | undefined) {
  if (!iso) return "—"
  return format(parseISO(iso), "dd-MM-yyyy")
}

/** 05 Oct 2026 */
export function formatDateLong(iso: string | null | undefined) {
  if (!iso) return "—"
  return format(parseISO(iso), "dd MMM yyyy")
}

/** yyyy-MM → "Oct 26" */
export function formatMonthKey(key: string) {
  return format(parseISO(`${key}-01`), "MMM yy")
}

export function toISODate(d: Date) {
  return format(d, "yyyy-MM-dd")
}

/** The business runs on Indian dates: Asia/Kolkata (UTC+5:30, no daylight saving), whatever the device's time zone. */
const IST_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })

/** Today in India, "yyyy-MM-dd" — every business date rule (month lock, default month, "today" limits) uses it. */
export function todayISO() {
  const p = Object.fromEntries(IST_DATE.formatToParts(new Date()).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

/** Today in India as a local Date at 00:00, for date-fns arithmetic (subDays, addYears…). */
export const todayDate = () => parseISO(todayISO())

/** Milliseconds until the next 00:00 in India. ponytail: fixed +5:30 — India has no daylight saving. */
export function msUntilIndiaMidnight(now = Date.now()) {
  const DAY = 86_400_000
  return DAY - ((now + 19_800_000) % DAY)
}

export function monthKey(iso: string) {
  return iso.slice(0, 7)
}

export function round2(n: number) {
  return Math.round(n * 100) / 100
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function twoDigits(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`
}

function threeDigits(n: number) {
  const h = Math.floor(n / 100)
  const rest = n % 100
  return [h ? `${ONES[h]} Hundred` : "", rest ? twoDigits(rest) : ""].filter(Boolean).join(" ")
}

/** Indian numbering: 1,23,45,678.50 → "Rupees One Crore Twenty Three Lakh … and Fifty Paise Only" */
export function amountInWords(value: number) {
  const rupees = Math.floor(Math.abs(value))
  const paise = Math.round((Math.abs(value) - rupees) * 100)
  const parts: string[] = []
  const crore = Math.floor(rupees / 1e7)
  const lakh = Math.floor((rupees % 1e7) / 1e5)
  const thousand = Math.floor((rupees % 1e5) / 1e3)
  const rest = rupees % 1e3
  if (crore) parts.push(`${crore >= 100 ? threeDigits(crore) : twoDigits(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (rest) parts.push(threeDigits(rest))
  const words = parts.join(" ") || "Zero"
  return `Rupees ${words}${paise ? ` and ${twoDigits(paise)} Paise` : ""} Only`
}

/** The last day of the month before `iso` — the default opening-balance date (2026-11-05 → "2026-10-31"). */
export function previousMonthEnd(iso: string) {
  const [y, m] = iso.split("-").map(Number)
  return toISODate(new Date(y, m - 1, 0))
}

/** "2026-09" → "2026-09-30" */
export function endOfMonthISO(month: string) {
  const [y, m] = month.split("-").map(Number)
  return toISODate(new Date(y, m, 0))
}
