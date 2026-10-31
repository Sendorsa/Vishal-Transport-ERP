/**
 * Monthly / Yearly Master sheets: entries in a period grouped by customer, vehicle and vendor,
 * for every consumable in the registry. Diesel keeps its full figures (`statsOf`); every other
 * consumable adds its own quantity / spend / km-per-unit next to it. The only combined figure is
 * the clearly labelled Running Fluid total (`fluid`): Diesel + AdBlue spend, and Diesel + AdBlue litres.
 * Formulas: CLAUDE.md → "Diesel master sheets — design review" §6, docs/DIESEL_CALCULATIONS.md.
 */
import type { Customer, DieselEntry, DieselVendor, Vehicle } from "@/lib/types"
import type { AdBlueRun } from "./adblue"
import { consumableSources, type ConsumableEntry, type ConsumableSource, type ConsumableStats } from "./consumables"
import { statsOf, type DieselIndex, type DieselStats } from "./diesel"
import { round2 } from "@/lib/format"

/** Per-row figures of the non-diesel consumables, keyed by consumable key. */
export type ExtraStats = Record<string, ConsumableStats>

/** Running Fluid = Diesel + every other consumable (today: AdBlue). Cost = Σ spend, Volume = Σ litres. */
export interface Fluid {
  spend: number
  qty: number
}
// ponytail: sums every registry consumable; filter by unit === "L" when a non-litre one (Charging) is added
const fluidOf = (d: DieselStats, extras: ConsumableStats[]): Fluid => ({
  spend: round2(d.spend + extras.reduce((t, x) => t + x.spend, 0)),
  qty: round2(d.litres + extras.reduce((t, x) => t + x.qty, 0)),
})

export interface CustomerRow extends DieselStats {
  id: string
  name: string
  vehicles: number
  share: number
  extras: ExtraStats
  fluid: Fluid
}
export interface VehicleRow extends DieselStats {
  vehicle: Vehicle
  customers: string
  extras: ExtraStats
  fluid: Fluid
}
export interface VendorRow extends ConsumableStats {
  id: string
  name: string
}

export interface MasterInput {
  idx: DieselIndex
  diesel: DieselEntry[]
  adblue: AdBlueRun[]
  customers: Map<string, Customer>
  vendors: Map<string, DieselVendor>
}

export function buildMaster({ idx, diesel, adblue, customers, vendors }: MasterInput, inScope: (e: ConsumableEntry) => boolean) {
  const sources = consumableSources(idx, diesel, adblue)
  const extras = sources.filter((s) => s.key !== "diesel")
  const scoped = sources.flatMap((s) => s.entries.filter(inScope))
  const custKey = (e: ConsumableEntry) => e.customerId ?? "none"
  const custName = (id: string) => (id === "none" ? "Unallocated" : customers.get(id)?.shortName || customers.get(id)?.name || "Unknown")
  const extrasFor = (pred: (e: ConsumableEntry) => boolean): ExtraStats => Object.fromEntries(extras.map((s) => [s.key, s.stats((e) => inScope(e) && pred(e))]))
  const dieselFor = (pred: (e: ConsumableEntry) => boolean) => statsOf(idx, diesel.filter((e) => inScope(e) && pred(e)))

  const totals = dieselFor(() => true)
  const extraTotals = extrasFor(() => true)

  const byCustomer: CustomerRow[] = [...new Set(scoped.map(custKey))].map((id) => {
    const mine = (e: ConsumableEntry) => custKey(e) === id
    const d = dieselFor(mine)
    const extras = extrasFor(mine)
    return {
      ...d,
      id,
      name: custName(id),
      vehicles: new Set(scoped.filter(mine).map((e) => e.vehicleId)).size,
      share: totals.spend ? (d.spend / totals.spend) * 100 : 0,
      extras,
      fluid: fluidOf(d, Object.values(extras)),
    }
  })

  const byVehicle: VehicleRow[] = [...new Set(scoped.map((e) => e.vehicleId))].flatMap((vid) => {
    const vehicle = idx.vehicles.get(vid)
    if (!vehicle) return []
    const mine = (e: ConsumableEntry) => e.vehicleId === vid
    const d = dieselFor(mine)
    const extras = extrasFor(mine)
    return [{ ...d, vehicle, customers: [...new Set(scoped.filter(mine).map((e) => custName(custKey(e))))].join(", "), extras, fluid: fluidOf(d, Object.values(extras)) }]
  })

  /** One vendor table per consumable — purchases are never merged across consumables. */
  // Pumps sell fuel only — AdBlue is bought in bulk into inventory (vendor table: AdBlue Inventory / masters).
  const byVendor = sources.filter((s) => s.key === "diesel").map((s: ConsumableSource) => ({
    key: s.key,
    label: s.label,
    unit: s.unit,
    total: s.stats(inScope),
    rows: [...new Set(s.entries.filter(inScope).map((e) => e.vendorId))].map(
      (id): VendorRow => ({ ...s.stats((e) => inScope(e) && e.vendorId === id), id, name: vendors.get(id)?.name ?? "Unknown" })
    ),
  }))

  return {
    totals,
    fluid: fluidOf(totals, Object.values(extraTotals)),
    extras: extras.map((s) => ({ key: s.key, label: s.label, unit: s.unit, total: extraTotals[s.key] })),
    byCustomer,
    byVehicle,
    byVendor,
    vehicleCount: byVehicle.length,
    customerCount: byCustomer.filter((c) => c.id !== "none").length,
  }
}

/** Fill litres split by the vehicle's fuel type (EV in kWh) for entries in scope — for Diesel vs Petrol totals. */
export function litresByFuelType(idx: DieselIndex, diesel: DieselEntry[], inScope: (e: ConsumableEntry) => boolean) {
  const out = { DIESEL: 0, PETROL: 0, EV: 0 }
  for (const e of diesel) if (inScope(e)) out[idx.vehicles.get(e.vehicleId)?.fuelType ?? "DIESEL"] += e.litres
  return { DIESEL: round2(out.DIESEL), PETROL: round2(out.PETROL), EV: round2(out.EV) }
}

/** The 12 month keys ending at `month` (inclusive), oldest first. */
export function last12Months(month: string) {
  const [y, m] = month.split("-").map(Number)
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, m - 1 - (11 - i), 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  })
}
