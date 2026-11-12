/**
 * Diesel analytics organised the way the owner reads it:
 *   Customer (company served) → Month → Vehicle → Fills
 *
 * Each fill is costed to a customer (`DieselEntry.customerId`, the Excel "USING IN WHICH
 * COMPANY" column). Every figure is built only from fill records — see docs/DIESEL_CALCULATIONS.md:
 *
 *   KM since last fill = this fill's odometer − the vehicle's previous fill odometer (any customer)
 *   KM Run             = Σ KM since last fill, over the fills in scope
 *   Total Litres       = Σ litres of fills by Diesel/Petrol vehicles (EV vehicles' fills are kWh, kept separate)
 *   Fuel type is read from the vehicle — fuel entries never store it.
 *   Total Spend        = Σ amount of all fills (litres × rate)
 *   Diesel Cost per KM = Total Spend ÷ KM Run
 *   KM per Litre       = KM Run of Diesel/Petrol fills ÷ Total Litres
 *
 * Trips are used only to show the usual driver — never for km.
 *
 * Deliberately no rankings, efficiency scores or performance insights — see CLAUDE.md.
 */
import { format, parseISO } from "date-fns"
import type { Customer, DieselEntry, Driver, Trip, Vehicle } from "@/lib/types"
import { monthKey, round2 } from "@/lib/format"
import type { Dataset } from "./analytics"
import { assignmentIndex, assignmentOn } from "./assignments"

export const UNALLOCATED = "unallocated"

/* ------------------------------------------------------------------ Months */

export function monthLabel(key: string) {
  return format(parseISO(`${key}-01`), "MMMM yyyy")
}

export function shortMonthLabel(key: string) {
  return format(parseISO(`${key}-01`), "MMM yy")
}

export function prevMonthKey(key: string) {
  const [y, m] = key.split("-").map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

export function isMonthKey(s: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}

/* ------------------------------------------------------------------ Index */

export interface DieselIndex {
  vehicles: Map<string, Vehicle>
  drivers: Map<string, Driver>
  /** `${customerId|unallocated}|${yyyy-MM}` → fills */
  fills: Map<string, DieselEntry[]>
  /** `${customerId}|${yyyy-MM}` → completed trips (driver lookup only) */
  trips: Map<string, Trip[]>
  /** fill id → odometer of the same vehicle's previous fill (any customer, any month); null for its first fill */
  prevOdometer: Map<string, number | null>
  /** Months with any diesel or trip activity, newest first. */
  months: string[]
  groups: DieselGroup[]
}

export interface DieselGroup {
  id: string | null
  slug: string
  name: string
  shortName: string
  logo: string | null
  customer: Customer | null
  /** Vehicles currently deployed with this customer (customer owns vehicles). */
  vehicleIds: string[]
  /** Latest time a fill for this customer was recorded (ISO), null if none. */
  lastUpdated: string | null
}

const groupKey = (customerId: string | null) => customerId ?? UNALLOCATED

export function customerSlug(c: Pick<Customer, "code">) {
  return c.code.toLowerCase()
}

/** fill id → the odometer of the same vehicle's previous fill (any customer), or its go-live opening odometer; null for its first. */
export function previousOdometers(diesel: DieselEntry[], vehicles: Vehicle[]): Map<string, number | null> {
  const prevOdometer = new Map<string, number | null>()
  const byVehicle = new Map<string, DieselEntry[]>()
  const opening = new Map(vehicles.filter((v) => v.openingOdometerKm != null && v.openingOdometerDate).map((v) => [v.id, v]))
  for (const e of diesel) byVehicle.set(e.vehicleId, [...(byVehicle.get(e.vehicleId) ?? []), e])
  for (const [vehicleId, list] of byVehicle) {
    list.sort(fillOrder)
    const o = opening.get(vehicleId)
    let last: number | null = o && !list.some((e) => e.date < o.openingOdometerDate!) ? o.openingOdometerKm! : null
    for (const e of list) {
      prevOdometer.set(e.id, last)
      if (e.odometerKm !== null) last = e.odometerKm
    }
  }
  return prevOdometer
}

export function buildDieselIndex(ds: Dataset): DieselIndex {
  const fills = new Map<string, DieselEntry[]>()
  const trips = new Map<string, Trip[]>()
  const months = new Set<string>()
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const arr = m.get(k)
    if (arr) arr.push(v)
    else m.set(k, [v])
  }
  for (const e of ds.diesel) {
    const mk = monthKey(e.date)
    months.add(mk)
    push(fills, `${groupKey(e.customerId)}|${mk}`, e)
  }
  // A trip lists a vehicle under its customer only while the vehicle was assigned there.
  const assignmentsByVehicle = assignmentIndex(ds.assignments ?? [])
  for (const t of ds.trips) {
    if (t.status !== "COMPLETED") continue
    const a = assignmentOn(assignmentsByVehicle, t.vehicleId, t.date)
    if (a && a.customerId !== t.customerId) continue
    const mk = monthKey(t.date)
    months.add(mk)
    push(trips, `${t.customerId}|${mk}`, t)
  }
  // Previous recorded odometer per vehicle, ordered by date then odometer. A fill without an
  // odometer (imported history) has no KM of its own and is skipped as anyone's "previous".
  // A vehicle's go-live opening odometer (its last fill before records began) is the previous reading of its first
  // fill on or after that date — never a fill itself: no litres, no spend, no entry.
  // A customer-scoped list (Tata Adblue) carries each fill's previous reading, worked out by the server on every fill.
  const prevOdometer = previousOdometers(ds.diesel, ds.vehicles)
  for (const e of ds.diesel) if (e.prevOdometerKm !== undefined) prevOdometer.set(e.id, e.prevOdometerKm)
  const lastUpdated = new Map<string, string>()
  for (const e of ds.diesel) {
    const k = groupKey(e.customerId)
    const t = e.updatedAt || e.createdAt
    if (!lastUpdated.has(k) || t > lastUpdated.get(k)!) lastUpdated.set(k, t)
  }
  const assigned = new Map<string, string[]>()
  for (const v of ds.vehicles) {
    if (!v.assignedCustomerId || v.status === "INACTIVE" || v.status === "ARCHIVED") continue
    assigned.set(v.assignedCustomerId, [...(assigned.get(v.assignedCustomerId) ?? []), v.id])
  }
  // Every customer, whatever its status: archiving must never change a report or hide history.
  const groups: DieselGroup[] = ds.customers.map((c) => ({
    id: c.id,
    slug: customerSlug(c),
    name: c.name,
    shortName: c.shortName || c.name,
    logo: c.logoDataUrl ?? null,
    customer: c,
    vehicleIds: assigned.get(c.id) ?? [],
    lastUpdated: lastUpdated.get(c.id) ?? null,
  }))
  if (lastUpdated.has(UNALLOCATED))
    groups.push({
      id: null,
      slug: UNALLOCATED,
      name: "Unallocated / pool",
      shortName: "Unallocated",
      logo: null,
      customer: null,
      vehicleIds: [],
      lastUpdated: lastUpdated.get(UNALLOCATED)!,
    })
  return {
    vehicles: new Map(ds.vehicles.map((v) => [v.id, v])),
    drivers: new Map(ds.drivers.map((d) => [d.id, d])),
    fills,
    trips,
    prevOdometer,
    months: [...months].sort().reverse(),
    groups,
  }
}

export function findGroup(idx: DieselIndex, slug: string) {
  return idx.groups.find((g) => g.slug === slug.toLowerCase()) ?? null
}

/* ------------------------------------------------------------------ Fills */

/** Fuel type comes from the vehicle master record. */
export const isLiquid = (idx: DieselIndex, e: DieselEntry) => idx.vehicles.get(e.vehicleId)?.fuelType !== "EV"

/** A vehicle's fills in KM order: date, then odometer (fills without one last that day). */
export const fillOrder = (a: Pick<DieselEntry, "date" | "odometerKm">, b: Pick<DieselEntry, "date" | "odometerKm">) =>
  a.date.localeCompare(b.date) || (a.odometerKm ?? Number.MAX_SAFE_INTEGER) - (b.odometerKm ?? Number.MAX_SAFE_INTEGER)

/**
 * Does an odometer reading fit the vehicle's fill sequence (fillOrder: date, then odometer)? It may not be below the
 * nearest fill dated before it, nor above the nearest fill dated after it (that fill's KM Run would go negative).
 * Fills on the same day reorder by odometer, so they never conflict; fills without an odometer (imported history) are
 * skipped. `others` = the vehicle's other fills (leave the edited one out). Returns the conflicting neighbour, or null.
 * One rule for the entry dialog and the API.
 */
export function odometerConflict(others: Pick<DieselEntry, "date" | "odometerKm">[], date: string, km: number): { side: "previous" | "next"; date: string; km: number } | null {
  const sorted = others.filter((e) => e.odometerKm !== null).sort(fillOrder)
  const prev = sorted.filter((e) => e.date < date).at(-1)
  if (prev && km < prev.odometerKm!) return { side: "previous", date: prev.date, km: prev.odometerKm! }
  const next = sorted.find((e) => e.date > date)
  if (next && km > next.odometerKm!) return { side: "next", date: next.date, km: next.odometerKm! }
  return null
}

export interface FillRow {
  entry: DieselEntry
  /** Odometer of the vehicle's previous fill; null for its first-ever fill. */
  prevOdometer: number | null
  /** odometer − prevOdometer; null when there is no previous fill or no odometer. Negative = data entry error. */
  kmSince: number | null
  /** This fill's mileage: kmSince ÷ litres (fillMileage). */
  kmpl: number | null
}

/**
 * Mileage of one fill = KM since last fill ÷ litres filled (units for an EV charge: km/kWh), rounded to 2 decimals.
 * null — shown as "—" — when there is no KM since last fill (first fill, no odometer, no previous reading), when that
 * KM isn't positive (a lower or equal reading is a data error, never a mileage), or when no litres were filled.
 * Derived on read like KM since last fill, so it follows every edit or delete of this fill or its neighbours.
 */
export const fillMileage = (kmSince: number | null, litres: number): number | null =>
  kmSince !== null && kmSince > 0 && litres > 0 ? round2(kmSince / litres) : null

export function fillRow(idx: DieselIndex, e: DieselEntry): FillRow {
  const prev = idx.prevOdometer.get(e.id) ?? null
  const kmSince = prev === null || e.odometerKm === null ? null : e.odometerKm - prev
  return { entry: e, prevOdometer: prev, kmSince, kmpl: fillMileage(kmSince, e.litres) }
}

/* ------------------------------------------------------------------ Stats */

export interface DieselStats {
  /** Σ amount of all fills. */
  spend: number
  /** Σ litres of Diesel/Petrol fills. */
  litres: number
  /** Σ units of EV charges (kWh). */
  kwh: number
  /** Σ KM since last fill (negative gaps count as 0). */
  km: number
  fills: number
  /** KM run of Diesel/Petrol fills ÷ litres. */
  kmpl: number | null
  /** Spend ÷ KM run. */
  costPerKm: number | null
  /** Diesel/Petrol spend ÷ litres. */
  avgRate: number | null
}

export function statsOf(idx: DieselIndex, entries: DieselEntry[]): DieselStats {
  let spend = 0,
    spendLiquid = 0,
    litres = 0,
    kwh = 0,
    km = 0,
    kmLiquid = 0
  for (const e of entries) {
    const d = Math.max(0, fillRow(idx, e).kmSince ?? 0)
    spend += e.amount
    km += d
    if (isLiquid(idx, e)) {
      spendLiquid += e.amount
      litres += e.litres
      kmLiquid += d
    } else kwh += e.litres
  }
  return {
    spend: round2(spend),
    litres: round2(litres),
    kwh: round2(kwh),
    km,
    fills: entries.length,
    kmpl: litres > 0 && kmLiquid > 0 ? round2(kmLiquid / litres) : null,
    costPerKm: km > 0 && spend > 0 ? round2(spend / km) : null,
    avgRate: litres > 0 ? round2(spendLiquid / litres) : null,
  }
}

export interface VehicleMonth extends DieselStats {
  vehicle: Vehicle
  driver: Driver | null
  entries: DieselEntry[]
  trips: Trip[]
}

/** Optional day cap (inclusive) for like-for-like comparison of a partial month. */
const withinDay = (iso: string, dayCap?: number) => dayCap === undefined || Number(iso.slice(8, 10)) <= dayCap

/**
 * "Vehicle Fuel (Diesel / Petrol)" as the Combined Fuel Outflow counts it (owner, 12 Nov 2026): the diesel and petrol
 * fills of these entries — the same fills as "Total Diesel Litres" (EV charging is kWh, not litres, so it is left out
 * of both the litres and the ₹). Read-only: no KM, mileage or cost-per-km figure uses it.
 */
export function vehicleDiesel(idx: DieselIndex, entries: DieselEntry[]) {
  const liquid = entries.filter((e) => isLiquid(idx, e))
  return { litres: round2(liquid.reduce((t, e) => t + e.litres, 0)), value: round2(liquid.reduce((t, e) => t + e.amount, 0)), entries: liquid.length }
}

export function groupMonth(idx: DieselIndex, groupId: string | null, month: string, dayCap?: number, includeAssigned = false) {
  const entries = (idx.fills.get(`${groupKey(groupId)}|${month}`) ?? []).filter((e) => withinDay(e.date, dayCap))
  const trips = groupId ? (idx.trips.get(`${groupId}|${month}`) ?? []).filter((t) => withinDay(t.date, dayCap)) : []
  const vehicleIds = new Set([...entries.map((e) => e.vehicleId), ...trips.map((t) => t.vehicleId)])
  if (includeAssigned) idx.groups.find((g) => g.id === groupId)?.vehicleIds.forEach((id) => vehicleIds.add(id))
  const vehicles: VehicleMonth[] = [...vehicleIds]
    .map((vid) =>
      vehicleMonthFrom(
        idx,
        vid,
        entries.filter((e) => e.vehicleId === vid),
        trips.filter((t) => t.vehicleId === vid)
      )
    )
    .filter((v): v is VehicleMonth => v !== null)
  return { ...statsOf(idx, entries), vehicles, entries }
}

function vehicleMonthFrom(idx: DieselIndex, vehicleId: string, entries: DieselEntry[], trips: Trip[]): VehicleMonth | null {
  const vehicle = idx.vehicles.get(vehicleId)
  if (!vehicle) return null
  const counts = new Map<string, number>()
  trips.forEach((t) => t.driverId && counts.set(t.driverId, (counts.get(t.driverId) ?? 0) + 1))
  const topDriver = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? vehicle.defaultDriverId
  return {
    ...statsOf(idx, entries),
    vehicle,
    driver: topDriver ? (idx.drivers.get(topDriver) ?? null) : null,
    entries: [...entries].sort(fillOrder),
    trips,
  }
}

export function vehicleMonth(idx: DieselIndex, groupId: string | null, vehicleId: string, month: string) {
  const entries = (idx.fills.get(`${groupKey(groupId)}|${month}`) ?? []).filter((e) => e.vehicleId === vehicleId)
  const trips = groupId ? (idx.trips.get(`${groupId}|${month}`) ?? []).filter((t) => t.vehicleId === vehicleId) : []
  return vehicleMonthFrom(idx, vehicleId, entries, trips)
}

/* ------------------------------------------------------------------ Level 1: customer cards */

export interface CustomerCard {
  group: DieselGroup
  vehicleCount: number
  /** Vehicles with activity for this customer in the month (for the "historical" count on the card). */
  vehicleIds: string[]
  /** Spend in the selected month (month to date when it is the current month). */
  spend: number
  litres: number
  km: number
  /** Comparison base: previous month — same days when the selected month is in progress. */
  compareSpend: number
  prevMonthSpend: number
  changePct: number | null
  share: number
}

/** Months a user can report on: every month with data plus the current one, newest first. */
/**
 * The reporting month a page opens on. `stored` is "picked@pickedIn": a month picked by hand is kept only during the
 * India calendar month it was picked in; otherwise (and for a stored value in the old plain "yyyy-MM" form) the
 * current month — the latest of dieselMonths, never a future one.
 */
export function pickMonth(available: string[], stored: string, current: string) {
  const [picked, pickedIn] = stored.split("@")
  if (pickedIn === current && available.includes(picked)) return picked
  return available.includes(current) ? current : (available[0] ?? current)
}

export function dieselMonths(idx: DieselIndex, todayIso: string) {
  const current = monthKey(todayIso)
  return [...new Set([current, ...idx.months])]
    .filter((m) => m <= current)
    .sort()
    .reverse()
}

/** Landing page: one card per customer for the selected reporting month. */
export function customerCards(idx: DieselIndex, month: string, todayIso: string) {
  const current = monthKey(todayIso)
  const inProgress = month === current
  const prev = prevMonthKey(month)
  const day = inProgress ? Number(todayIso.slice(8, 10)) : undefined
  const cards: CustomerCard[] = idx.groups.map((g) => {
    const cur = groupMonth(idx, g.id, month, undefined, inProgress)
    const cmp = groupMonth(idx, g.id, prev, day)
    const prevFull = day ? groupMonth(idx, g.id, prev).spend : cmp.spend
    return {
      group: g,
      vehicleCount: cur.vehicles.length,
      vehicleIds: cur.vehicles.map((v) => v.vehicle.id),
      spend: cur.spend,
      litres: cur.litres,
      km: cur.km,
      compareSpend: cmp.spend,
      prevMonthSpend: prevFull,
      changePct: cmp.spend > 0 ? ((cur.spend - cmp.spend) / cmp.spend) * 100 : null,
      share: 0,
    }
  })
  const total = cards.reduce((t, c) => t + c.spend, 0)
  cards.forEach((c) => (c.share = total ? (c.spend / total) * 100 : 0))
  const km = cards.reduce((t, c) => t + c.km, 0)
  const litres = cards.reduce((t, c) => t + c.litres, 0)
  return {
    cards,
    month,
    prev,
    inProgress,
    day,
    total,
    compareTotal: cards.reduce((t, c) => t + c.compareSpend, 0),
    km,
    litres,
    vehicleCount: cards.reduce((t, c) => t + c.vehicleCount, 0),
    customerCount: cards.filter((c) => c.spend > 0 || c.vehicleCount > 0).length,
    costPerKm: km > 0 ? round2(total / km) : null,
    kmpl: litres > 0 && km > 0 ? round2(km / litres) : null,
  }
}

export function monthProgress(month: string, todayIso: string) {
  const inProgress = monthKey(todayIso) === month
  return { inProgress, day: Number(todayIso.slice(8, 10)) }
}
