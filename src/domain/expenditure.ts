/**
 * Fuel-wise expenditure (owner, 12 Nov 2026): a customer's (or a vehicle's) spending split by what was bought —
 * vehicle Diesel, vehicle Petrol, EV charging, Industrial Diesel and AdBlue — and their Total Expenditure.
 *
 *   A vehicle fill's fuel = its vehicle's fuel type. There is no fuel type on a fill and no fuel-type history
 *   (core.vehicles.fuel_type only): changing a vehicle's fuel type would reclassify its past fills — an open decision
 *   (CLAUDE.md "Fuel-wise expenditure"). The customer of a fill = the assignment on its date (api.diesel.list).
 *   Spending is consumption at cost, each record once: a fill at litres × its own rate (a tanker fill at its source
 *   rate — the tanker load is the purchase, never added again), an industrial supply at its amount (never its tanker
 *   allocations), AdBlue at the amount the API reports (a stock draw at weighted-average cost, a direct purchase at its
 *   own amount — bulk purchases are stock, not expense). Tanker loads and transfers are never expenditure.
 *   Quantities: litres for Diesel, Petrol, Industrial Diesel and AdBlue; kWh for EV charging — never added together.
 */
import { round2 } from "@/lib/format"
import type { DieselEntry, FuelType } from "@/lib/types"
import { statsOf, type DieselIndex } from "./diesel"

export const FUEL_ORDER: FuelType[] = ["DIESEL", "PETROL", "EV"]
export const fuelName = (f: FuelType) => (f === "EV" ? "EV Charging" : f === "PETROL" ? "Petrol" : "Diesel")
export const fuelUnit = (f: FuelType) => (f === "EV" ? "kWh" : "L")
/** A fill's fuel: its vehicle's (a vehicle missing from the index counts as liquid fuel, as isLiquid does). */
export const fillFuel = (idx: DieselIndex, e: Pick<DieselEntry, "vehicleId">): FuelType => idx.vehicles.get(e.vehicleId)?.fuelType ?? "DIESEL"

export interface FuelTotals {
  fuelType: FuelType
  spend: number
  /** Litres (Diesel, Petrol) or kWh (EV). */
  qty: number
  fills: number
  /** Distinct vehicles with a fill of this fuel. */
  vehicles: number
  /** Σ KM since last fill of these fills — each vehicle's own fills, so never another fuel's. */
  km: number
  /** km ÷ litres (Diesel, Petrol only — never across fuels; EV: null). */
  kmpl: number | null
  /** spend ÷ km. */
  costPerKm: number | null
  /** spend ÷ qty: ₹ per litre (₹ per kWh for EV). */
  avgRate: number | null
}

/**
 * These fills split by fuel type — each fuel's figures from its own fills only (statsOf on that fuel's fills: a
 * vehicle's KM Run uses its own previous fill, and a vehicle runs on one fuel, so Petrol mileage never reads a Diesel
 * fill). The fuel types listed = those in `fuelTypes` (the vehicles in view) and in the fills, in FUEL_ORDER.
 */
export function fuelWise(idx: DieselIndex, entries: DieselEntry[], fuelTypes: Iterable<FuelType> = []): FuelTotals[] {
  const by = new Map<FuelType, DieselEntry[]>()
  for (const f of fuelTypes) by.set(f, [])
  for (const e of entries) {
    const f = fillFuel(idx, e)
    by.set(f, [...(by.get(f) ?? []), e])
  }
  return FUEL_ORDER.filter((f) => by.has(f)).map((f) => {
    const list = by.get(f)!
    const st = statsOf(idx, list)
    const qty = f === "EV" ? st.kwh : st.litres
    return {
      fuelType: f,
      spend: st.spend,
      qty,
      fills: list.length,
      vehicles: new Set(list.map((e) => e.vehicleId)).size,
      km: st.km,
      kmpl: f === "EV" ? null : st.kmpl,
      costPerKm: st.costPerKm,
      avgRate: qty > 0 ? round2(st.spend / qty) : null,
    }
  })
}

/** Vehicles by fuel type (e.g. the active fleet): DIESEL / PETROL / EV → count. */
export function vehiclesByFuel(vehicles: Iterable<{ fuelType: FuelType }>) {
  const out: Record<FuelType, number> = { DIESEL: 0, PETROL: 0, EV: 0 }
  for (const v of vehicles) out[v.fuelType] += 1
  return out
}

export interface Category {
  spend: number
  litres: number
  entries: number
}

/**
 * Total Expenditure = Σ vehicle fuels (Diesel + Petrol + EV charging) + Industrial Diesel + AdBlue, each record once.
 * `industrial` / `adblue` null = couldn't be loaded → total null (never a silently incomplete total).
 * `industrial` undefined = not applicable (no customer record: the Unallocated card).
 */
export function totalExpenditure(fuels: FuelTotals[], industrial: Category | null | undefined, adblue: Category | null) {
  if (industrial === null || adblue === null) return null
  return round2(fuels.reduce((t, f) => t + f.spend, 0) + (industrial?.spend ?? 0) + adblue.spend)
}

/** Litres of fuel (Diesel + Petrol + Industrial Diesel). AdBlue litres and EV kWh are never part of it. */
export function fuelLitres(fuels: FuelTotals[], industrial: Category | null | undefined) {
  if (industrial === null) return null
  return Number((fuels.filter((f) => f.fuelType !== "EV").reduce((t, f) => t + f.qty, 0) + (industrial?.litres ?? 0)).toFixed(3))
}

/**
 * Diesel landing customer cards (owner, 12 Nov 2026): each card's amount = that customer's Total Expenditure — its
 * vehicle fills (the card's existing figure, customerCards in domain/diesel.ts: Diesel + Petrol + EV charging) + its
 * industrial supplies + its AdBlue entries, over exactly the same days for every source: the selected month (`month`),
 * the comparison (`prev`, capped at day `day` when the month is in progress, like the fills) and the full previous
 * month. Each record once, by its own amount, under its own customer (AdBlue without a customer: the Unallocated card);
 * an industrial supply's tanker allocations are never spending. Σ cards = the dashboard's Total Expenditure.
 */
export function withCustomerExpenditure<C extends { group: { id: string | null }; spend: number; compareSpend: number; prevMonthSpend: number; changePct: number | null }>(
  cards: C[],
  records: { supplies: { customerId: string; date: string; amount: number }[]; adblue: { customerId: string | null; date: string; amount: number }[] },
  period: { month: string; prev: string; day?: number }
) {
  const sums = new Map<string, { cur: number; cmp: number; prev: number; industrial: number; adblue: number }>()
  const add = (customerId: string | null, date: string, amount: number, kind: "industrial" | "adblue") => {
    const m = date.slice(0, 7)
    if (m !== period.month && m !== period.prev) return
    const k = customerId ?? ""
    const t = sums.get(k) ?? { cur: 0, cmp: 0, prev: 0, industrial: 0, adblue: 0 }
    if (m === period.month) {
      t.cur += amount
      t[kind] += amount
    } else {
      t.prev += amount
      if (period.day === undefined || Number(date.slice(8, 10)) <= period.day) t.cmp += amount
    }
    sums.set(k, t)
  }
  for (const s of records.supplies) add(s.customerId, s.date, s.amount, "industrial")
  for (const a of records.adblue) add(a.customerId, a.date, a.amount, "adblue")
  return cards.map((c) => {
    const t = sums.get(c.group.id ?? "") ?? { cur: 0, cmp: 0, prev: 0, industrial: 0, adblue: 0 }
    const spend = round2(c.spend + t.cur)
    const compareSpend = round2(c.compareSpend + t.cmp)
    return {
      ...c,
      vehicleSpend: c.spend,
      industrialSpend: round2(t.industrial),
      adblueSpend: round2(t.adblue),
      spend,
      compareSpend,
      prevMonthSpend: round2(c.prevMonthSpend + t.prev),
      changePct: compareSpend > 0 ? ((spend - compareSpend) / compareSpend) * 100 : null,
    }
  })
}

/** Σ of a list of records' amounts / litres (the dashboard's Industrial Diesel and AdBlue categories). */
export const categoryOf = (records: { amount: number; litres: number }[]): Category => ({
  spend: round2(records.reduce((t, r) => t + r.amount, 0)),
  litres: Number(records.reduce((t, r) => t + r.litres, 0).toFixed(3)),
  entries: records.length,
})

/**
 * The main Diesel dashboard (owner, 12 Nov 2026): the fleet-wide fuel-wise figures for a month, from the same records
 * as the customer cards (every customer the role sees). Fuel types shown = this month's vehicles' (`cards`' vehicles:
 * deployed ones while the month is in progress) and the fills'. Total Expenditure = Σ the customer cards
 * (withCustomerExpenditure); `compare` = Σ their comparisons (the same days of the previous month).
 */
export function fleetExpenditure(input: {
  idx: DieselIndex
  fills: DieselEntry[]
  month: string
  cards: { vehicleIds: string[]; compareSpend: number }[]
  supplies: { customerId: string; date: string; amount: number; litres: number }[] | null
  adblue: { customerId: string | null; date: string; amount: number; quantityLitres: number }[] | null
}) {
  const { idx, month } = input
  const fills = input.fills.filter((e) => e.date.startsWith(month))
  const fuels = fuelWise(idx, fills, input.cards.flatMap((c) => c.vehicleIds.flatMap((id) => idx.vehicles.get(id)?.fuelType ?? [])))
  const customerIds = new Set(idx.groups.flatMap((g) => g.id ?? []))
  const industrial = input.supplies ? categoryOf(input.supplies.filter((x) => x.date.startsWith(month) && customerIds.has(x.customerId))) : null
  const adblue = input.adblue ? categoryOf(input.adblue.filter((x) => x.date.startsWith(month)).map((x) => ({ amount: x.amount, litres: x.quantityLitres }))) : null
  const total = totalExpenditure(fuels, industrial, adblue)
  const compare = total === null ? null : round2(input.cards.reduce((t, c) => t + c.compareSpend, 0))
  return { fuels, industrial, adblue, total, compare }
}

/**
 * The main Diesel dashboard's Vehicle Count (owner, 12 Nov 2026): every distinct vehicle whose status is ACTIVE today —
 * Diesel, Petrol and EV alike, fuelled in the period or not. Archived, inactive and in-workshop vehicles are left out
 * (the same "active" as the customer cards' Active Vehicles), and a vehicle is counted once however many assignment
 * records it has. `vehicles` = the vehicles the role sees (Tata Adblue: its granted customers'). Never reads a fill.
 */
export function activeFleetCount(vehicles: Iterable<{ id: string; status: string }>) {
  const ids = new Set<string>()
  for (const v of vehicles) if (v.status === "ACTIVE") ids.add(v.id)
  return ids.size
}
