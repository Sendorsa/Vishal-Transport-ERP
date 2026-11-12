/**
 * Industrial Diesel Supply (owner, 12 Nov 2026) — diesel supplied to a customer for industrial use, recorded per
 * customer (never a vehicle). Separate from vehicle Diesel: no KM Run, mileage, AdBlue, station purchase, ledger or
 * payment ever reads it.
 *
 *   Amount                 litres × the rate of that supply (round2, the same as the database's round(numeric, 2))
 *   Weighted average rate  Σ amount ÷ Σ litres of the supplies in the period
 */
import { round2 } from "@/lib/format"

export const INDUSTRIAL_PURPOSES = ["Generator operation", "Industrial machinery", "Construction equipment", "Factory operations"] as const
export const OTHER_PURPOSE = "Other"

/** Litres to 3 decimals, rate to 4, amount to 2 — the database's numeric(12,3) / numeric(12,4) / numeric(14,2). */
export const LITRES_DECIMALS = 3
export const RATE_DECIMALS = 4
export const industrialAmount = (litres: number, rate: number) => round2(litres * rate)

const decimals = (n: number) => (String(n).split(".")[1] ?? "").length

/** Why this supply can't be saved, or null. The same rules in the dialog and the API (and the database's checks). */
export function industrialProblem(input: { date: string; litres: number; rate: number; purpose: string }, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) return "Enter the supply date"
  if (input.date > today) return "A supply can't be dated in the future."
  if (!Number.isFinite(input.litres) || !(input.litres > 0)) return "Quantity must be more than 0 litres"
  if (decimals(input.litres) > LITRES_DECIMALS) return `Quantity: at most ${LITRES_DECIMALS} decimals`
  if (!Number.isFinite(input.rate) || !(input.rate > 0)) return "Rate per litre must be more than ₹0"
  if (decimals(input.rate) > RATE_DECIMALS) return `Rate per litre: at most ${RATE_DECIMALS} decimals`
  if (!input.purpose?.trim()) return "Enter the purpose"
  if (input.purpose.trim() === OTHER_PURPOSE) return "Describe the purpose (Other)"
  return null
}

/** A period's totals, from the supplies in it only. */
export function industrialTotals<E extends { litres: number; amount: number }>(entries: E[]) {
  const litres = Number(entries.reduce((t, e) => t + e.litres, 0).toFixed(LITRES_DECIMALS))
  const value = round2(entries.reduce((t, e) => t + e.amount, 0))
  return { litres, value, avgRate: litres ? round2(value / litres) : null, count: entries.length }
}

/** Litres from one tanker of an industrial supply (owner, 12 Nov 2026: industrial diesel comes out of the tankers). */
export interface TankerAllocation {
  tankerId: string
  litres: number
}

const millilitres = (n: number) => Math.round(n * 1000)

/**
 * Why these tanker allocations can't be saved for a supply of `litres`, or null: at least one tanker, each once, each
 * more than 0 L (3 decimals), and together exactly the quantity supplied. Stock is checked separately (per tanker,
 * on the supply's date — domain/tanker.ts tankerAvailability), in the API and by the database.
 */
export function allocationProblem(litres: number, allocations: TankerAllocation[]): string | null {
  if (!allocations?.length) return "Choose the tanker the diesel was supplied from"
  if (new Set(allocations.map((a) => a.tankerId)).size !== allocations.length) return "Choose each tanker once"
  for (const a of allocations) {
    if (!a.tankerId) return "Choose the tanker"
    if (!Number.isFinite(a.litres) || !(a.litres > 0)) return "Litres from each tanker must be more than 0"
    if (decimals(a.litres) > LITRES_DECIMALS) return `Litres from a tanker: at most ${LITRES_DECIMALS} decimals`
  }
  const total = allocations.reduce((t, a) => t + millilitres(a.litres), 0)
  if (total !== millilitres(litres)) return `The tankers' litres (${(total / 1000).toLocaleString("en-IN")} L) must add up to the quantity supplied (${litres.toLocaleString("en-IN")} L).`
  return null
}

/** Allocations in a stable order (by tanker id, byte order — the database's `collate "C"`), so a change of order alone is never an edit. */
export const sortedAllocations = (allocations: TankerAllocation[]) =>
  [...allocations].map((a) => ({ tankerId: a.tankerId, litres: a.litres })).sort((a, b) => (a.tankerId < b.tankerId ? -1 : a.tankerId > b.tankerId ? 1 : 0))

/** Litres of industrial diesel supplied out of each tanker by these supplies (tanker id → litres). */
export function industrialByTanker(entries: { allocations: TankerAllocation[] }[]) {
  const by = new Map<string, number>()
  for (const e of entries) for (const a of e.allocations) by.set(a.tankerId, Number(((by.get(a.tankerId) ?? 0) + a.litres).toFixed(LITRES_DECIMALS)))
  return by
}

/**
 * A period's Industrial Diesel report (the supplies already filtered to the period): totals, each customer's totals,
 * and the litres supplied out of each tanker. Separate from vehicle Diesel — no KM, mileage or vehicle figure here.
 */
export function industrialReport<E extends { customerId: string; litres: number; amount: number; allocations: TankerAllocation[] }>(entries: E[]) {
  const byCustomer = new Map<string, E[]>()
  for (const e of entries) byCustomer.set(e.customerId, [...(byCustomer.get(e.customerId) ?? []), e])
  return {
    totals: industrialTotals(entries),
    byCustomer: [...byCustomer].map(([customerId, list]) => ({ customerId, ...industrialTotals(list) })),
    byTanker: [...industrialByTanker(entries)].map(([tankerId, litres]) => ({ tankerId, litres })),
  }
}

/**
 * Reports module (owner, 12 Nov 2026): the industrial supplies in view — dated in the report's range and belonging to
 * the customers in view (the company scope's customers; the role's own visibility already limits what was loaded).
 */
export const industrialInView = <E extends { date: string; customerId: string }>(entries: E[], range: { from: string; to: string }, customerIds: ReadonlySet<string>) =>
  entries.filter((e) => e.date >= range.from && e.date <= range.to && customerIds.has(e.customerId))
