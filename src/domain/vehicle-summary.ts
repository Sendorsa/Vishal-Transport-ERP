/**
 * The vehicle page's KM Run and mileage cards: the Diesel module's own figures (buildDieselIndex / statsOf) over the
 * vehicle's fills dated in the current financial year — the same numbers its Diesel pages and the FY Yearly Master show.
 * KM Run = Σ odometer gaps between fills (each fill closes the gap before it; a fill without an odometer or a previous
 * reading adds none; a negative gap counts 0). Mileage = KM Run ÷ litres (Diesel / Petrol), or ÷ units charged for an
 * EV (km/kWh) — never mixed. Trips are not a distance source here (a revenue record; counting both would double-count).
 *
 * Data quality (shown, never corrected; the formula is unchanged). The Diesel module measures each reading's gap from the
 * last earlier reading, skipping fills without one (previousOdometers), so a fill without a reading BETWEEN two readings
 * is covered: the later reading's gap spans it. Flagged — fuel counted with no measured KM, so the figure may read low:
 *   noEarlier  — no earlier reading on record (the first fill, or fills before it without one);
 *   uncovered  — no reading, and no later reading measures a positive gap past it yet (e.g. the latest fill);
 *   repeated   — a reading equal to the previous one (0 km).
 * And separately `lower` — a reading below the previous one (counted 0 km; it is also the next fill's previous reading,
 * so the next gap is inflated): the figure may be wrong either way.
 * No full-tank / partial-fill flag exists: the figure is the period's km ÷ fuel filled, not a tank-to-tank test.
 */
import { buildDieselIndex, fillOrder, fillRow, statsOf } from "./diesel"
import { fyName, fyRange, fyStartYear } from "./financial-year"
import { round2 } from "@/lib/format"
import type { DieselEntry, Vehicle } from "@/lib/types"

export function vehicleFyFuel(vehicle: Vehicle, diesel: DieselEntry[], today: string) {
  const own = diesel.filter((e) => e.vehicleId === vehicle.id)
  const idx = buildDieselIndex({ vehicles: [vehicle], diesel: own, drivers: [], trips: [], customers: [], assignments: [] } as never)
  const start = fyStartYear(today)
  const { from, to } = fyRange(start)
  const inFy = own.filter((e) => e.date >= from && e.date <= to)
  const stats = statsOf(idx, inFy)
  const ev = vehicle.fuelType === "EV"
  // Each fill's next reading in the same order the Diesel module uses (fillOrder; fills without a reading skipped).
  const ordered = [...own].sort(fillOrder)
  const nextReading = new Map<string, DieselEntry | null>()
  let next: DieselEntry | null = null
  for (let i = ordered.length - 1; i >= 0; i--) {
    nextReading.set(ordered[i].id, next)
    if (ordered[i].odometerKm !== null) next = ordered[i]
  }
  const kind = (e: DieselEntry) => {
    const row = fillRow(idx, e)
    if (row.prevOdometer === null) return "noEarlier"
    if (e.odometerKm === null) {
      const later = nextReading.get(e.id)
      return later && (fillRow(idx, later).kmSince ?? 0) > 0 ? "covered" : "uncovered"
    }
    return row.kmSince! < 0 ? "lower" : row.kmSince === 0 ? "repeated" : "measured"
  }
  const kinds = inFy.map((e) => ({ e, k: kind(e) }))
  const issue = (k: string) => {
    const xs = kinds.filter((x) => x.k === k)
    return { fills: xs.length, quantity: round2(xs.reduce((t, x) => t + x.e.litres, 0)) }
  }
  return {
    fyLabel: fyName(start),
    km: stats.km,
    fills: stats.fills,
    /** null = not enough data (no fill with a KM Run, or no litres / units). */
    mileage: ev ? (stats.kwh > 0 && stats.km > 0 ? round2(stats.km / stats.kwh) : null) : stats.kmpl,
    unit: ev ? "km/kWh" : "km/L",
    /** Litres (Diesel / Petrol) or units (EV) filled this FY — the mileage's divisor. */
    quantity: ev ? stats.kwh : stats.litres,
    /** This FY's fills by data quality (see above): flagged groups, and `covered` (no reading, but counted — not a problem). */
    incomplete: { noEarlier: issue("noEarlier"), uncovered: issue("uncovered"), repeated: issue("repeated"), lower: issue("lower") },
    covered: issue("covered"),
    /** The latest fill with an odometer reading (any date) — the last verified reading. */
    lastReading: own.filter((e) => e.odometerKm !== null).sort(fillOrder).at(-1) ?? null,
  }
}

/**
 * The vehicle's latest recorded odometer — a reference for typing tyre KM (owner, 21 Nov 2026). The value is the
 * vehicle's own `odometerKm`, which the fuel-entry workflow keeps at its highest fill reading (raised by a new reading,
 * lowered back when a mistyped one is corrected or deleted; the database raises it too). Its date is that of the fill
 * holding the reading (readings rise with date, so the latest one), or of the go-live opening odometer; a value entered
 * only on the vehicle record has no date. null = no reading recorded. Read only: nothing is stored or changed.
 */
export function currentOdometer(vehicle: Vehicle, diesel: DieselEntry[]): { km: number; date: string | null } | null {
  const fill = diesel.filter((e) => e.vehicleId === vehicle.id && e.odometerKm !== null && e.odometerKm === vehicle.odometerKm).sort(fillOrder).at(-1)
  if (fill) return { km: vehicle.odometerKm, date: fill.date }
  if (vehicle.openingOdometerDate && vehicle.openingOdometerKm === vehicle.odometerKm) return { km: vehicle.odometerKm, date: vehicle.openingOdometerDate }
  return vehicle.odometerKm > 0 ? { km: vehicle.odometerKm, date: null } : null
}
