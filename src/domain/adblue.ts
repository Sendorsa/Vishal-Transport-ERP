/**
 * AdBlue (DEF) figures — computed only from AdBlue entries (vt:adBlueEntries), never from
 * fuel entries, so diesel litres / spend / km per litre are never affected.
 *
 * The user enters only the closing odometer. The previous reading is derived:
 *   Previous Odometer     = closing km of the same vehicle's previous AdBlue entry (by date, then km; any customer)
 *   KM Run (entry)        = Closing KM − Previous Odometer   (— for the vehicle's first entry)
 *   Total AdBlue Used     = Σ quantityLitres                 (all entries)
 *   Total AdBlue Spend    = Σ amount                         (all entries)
 *   KM per Litre AdBlue   = Σ KM Run ÷ Σ litres   } only entries that have a KM Run — a first entry has
 *   AdBlue Cost per KM    = Σ amount ÷ Σ KM Run   } no reference point, so its litres/₹ cover unknown km
 */
import type { AdBlueEntry } from "@/lib/types"
import { round2 } from "@/lib/format"

/** An AdBlue entry with its derived previous reading. */
export interface AdBlueRun extends AdBlueEntry {
  prevKm: number | null
  prevDate: string | null
  kmRun: number | null
}

const byDateKm = (a: AdBlueEntry, b: AdBlueEntry) => a.date.localeCompare(b.date) || a.closingKm - b.closingKm

/** The vehicle's entries just before and after `date` (ignoring `excludeId`, the entry being edited). */
export function adBlueNeighbours(all: AdBlueEntry[], vehicleId: string, date: string, excludeId?: string) {
  const mine = all.filter((e) => e.vehicleId === vehicleId && e.id !== excludeId).sort(byDateKm)
  return { prev: mine.filter((e) => e.date <= date).at(-1) ?? null, next: mine.find((e) => e.date > date) ?? null }
}

/** Derives Previous Odometer and KM Run for every entry. */
export function withRuns(all: AdBlueEntry[]): AdBlueRun[] {
  const prev = new Map<string, AdBlueEntry>()
  const last = new Map<string, AdBlueEntry>()
  for (const e of [...all].sort(byDateKm)) {
    const p = last.get(e.vehicleId)
    if (p) prev.set(e.id, p)
    last.set(e.vehicleId, e)
  }
  return all.map((e) => {
    const p = prev.get(e.id)
    return { ...e, prevKm: p?.closingKm ?? null, prevDate: p?.date ?? null, kmRun: p ? Math.max(0, e.closingKm - p.closingKm) : null }
  })
}

export interface AdBlueStats {
  entries: number
  litres: number
  spend: number
  km: number
  kmPerLitre: number | null
  costPerKm: number | null
}

export function adBlueStats(es: AdBlueRun[]): AdBlueStats {
  let litres = 0, spend = 0, km = 0, runLitres = 0, runSpend = 0
  for (const e of es) {
    litres += e.quantityLitres
    spend += e.amount
    if (e.kmRun === null) continue
    km += e.kmRun
    runLitres += e.quantityLitres
    runSpend += e.amount
  }
  return {
    entries: es.length,
    litres: round2(litres),
    spend: round2(spend),
    km,
    kmPerLitre: runLitres > 0 && km > 0 ? round2(km / runLitres) : null,
    costPerKm: km > 0 ? round2(runSpend / km) : null,
  }
}
