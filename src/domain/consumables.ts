/**
 * Fuel & consumables registry. Each consumable (Diesel, AdBlue — later Engine Oil, Coolant,
 * Charging…) contributes its own entries and its own formulas; screens loop over the registry,
 * so a new consumable adds columns/cards without redesign. Consumables are NEVER summed together.
 */
import type { DieselEntry } from "@/lib/types"
import { adBlueStats, type AdBlueRun } from "./adblue"
import { statsOf, type DieselIndex } from "./diesel"

/** Fields every consumable entry has. */
export interface ConsumableEntry {
  vehicleId: string
  customerId: string | null
  vendorId: string
  date: string
}

export interface ConsumableStats {
  entries: number
  /** Quantity in `unit` (litres for Diesel and AdBlue). */
  qty: number
  spend: number
  km: number
  /** km per unit — each consumable's own definition. */
  perUnit: number | null
  costPerKm: number | null
  /** spend per unit */
  avgRate: number | null
}

export interface ConsumableSource {
  key: "diesel" | "adblue"
  label: string
  unit: string
  entries: ConsumableEntry[]
  /** Stats over this consumable's entries matching `pred`. */
  stats: (pred: (e: ConsumableEntry) => boolean) => ConsumableStats
}

export function consumableSources(idx: DieselIndex, diesel: DieselEntry[], adblue: AdBlueRun[]): ConsumableSource[] {
  return [
    {
      key: "diesel",
      label: "Diesel",
      unit: "L",
      entries: diesel,
      stats: (pred) => {
        const s = statsOf(idx, diesel.filter(pred))
        return { entries: s.fills, qty: s.litres, spend: s.spend, km: s.km, perUnit: s.kmpl, costPerKm: s.costPerKm, avgRate: s.avgRate }
      },
    },
    {
      key: "adblue",
      label: "AdBlue",
      unit: "L",
      entries: adblue,
      stats: (pred) => {
        const list = adblue.filter(pred)
        const s = adBlueStats(list)
        return { entries: s.entries, qty: s.litres, spend: s.spend, km: s.km, perUnit: s.kmPerLitre, costPerKm: s.costPerKm, avgRate: s.litres ? s.spend / s.litres : null }
      },
    },
  ]
}

export const inPeriod = (prefix: string) => (e: ConsumableEntry) => e.date.startsWith(prefix)
