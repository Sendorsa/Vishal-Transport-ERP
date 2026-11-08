/**
 * Vehicle → customer assignment history. Vehicles are permanent assets; customers are dated
 * assignments. An entry is reported under the customer assigned on the entry's date, so a
 * transfer moves only entries from its effective date on — earlier months never change.
 *
 *   customer of an entry = assignment covering entry.date → its customerId
 *                          (no assignment covers that date → the customer stored on the entry)
 *
 * Periods use the shared Span helpers (src/domain/status-history.ts).
 */
import type { Vehicle, VehicleAssignment } from "@/lib/types"
import { appendPeriod, periodOn } from "./status-history"
import { matchesSearch } from "@/lib/utils"

export type AssignmentPeriod = Pick<VehicleAssignment, "vehicleId" | "customerId" | "startDate" | "endDate" | "status">

interface Dated {
  vehicleId: string
  customerId: string | null
  date: string
}

const statusOf = (p: { endDate: string | null }) => (p.endDate === null ? "ACTIVE" : "ENDED") as VehicleAssignment["status"]
const sameCustomer = (a: { customerId: string | null }, b: { customerId: string | null }) => a.customerId === b.customerId

/** vehicleId → its periods, oldest first. */
export function assignmentIndex(assignments: AssignmentPeriod[]) {
  const m = new Map<string, AssignmentPeriod[]>()
  for (const a of assignments) m.set(a.vehicleId, [...(m.get(a.vehicleId) ?? []), a])
  for (const list of m.values()) list.sort((a, b) => a.startDate.localeCompare(b.startDate))
  return m
}

/** The assignment covering `date` (undefined when none does). */
export function assignmentOn(idx: Map<string, AssignmentPeriod[]>, vehicleId: string, date: string) {
  return periodOn(idx.get(vehicleId) ?? [], date) ?? undefined
}

/** Entries with `customerId` taken from the assignment on their date. */
export function resolveCustomers<E extends Dated>(entries: E[], assignments: AssignmentPeriod[]): E[] {
  const idx = assignmentIndex(assignments)
  if (!idx.size) return entries
  return entries.map((e) => {
    const a = assignmentOn(idx, e.vehicleId, e.date)
    return a && a.customerId !== e.customerId ? { ...e, customerId: a.customerId } : e
  })
}

/**
 * Vehicles a customer has right now: assignment open on `todayIso` and vehicle status ACTIVE
 * (not archived, inactive, in workshop, or transferred away). Display only — never a report input.
 */
export function activeVehicleIds(assignments: AssignmentPeriod[], vehicles: Map<string, Vehicle>, customerId: string, todayIso: string) {
  return new Set(
    assignments
      .filter((a) => a.customerId === customerId && a.startDate <= todayIso && (a.endDate === null || a.endDate >= todayIso))
      .map((a) => a.vehicleId)
      .filter((id) => vehicles.get(id)?.status === "ACTIVE")
  )
}

/**
 * For a customer viewing a period: if the vehicle was assigned elsewhere by `date`, who took it
 * over and from when. Non-null = previous owner → read-only historical view.
 */
export function handoverFrom(periods: AssignmentPeriod[], customerId: string, date: string) {
  const now = periodOn(periods, date)
  if (!now || now.customerId === customerId) return null
  const i = periods.findLastIndex((p) => p.customerId === customerId && p.startDate <= date)
  const next = i >= 0 ? periods[i + 1] : now
  return { toCustomerId: next?.customerId ?? null, effectiveDate: i >= 0 ? (next?.startDate ?? null) : null }
}

/**
 * History for a vehicle that has none yet (migration): one period per run of entries for the
 * same customer, in date order, ending with the vehicle's current assignment. Reproduces how
 * the entries were already reported, so no report changes.
 */
export function inferAssignments(vehicle: Vehicle, entries: Dated[], todayIso: string): AssignmentPeriod[] {
  const mine = entries.filter((e) => e.vehicleId === vehicle.id).sort((a, b) => a.date.localeCompare(b.date))
  const created = vehicle.createdAt.slice(0, 10)
  let periods: AssignmentPeriod[] = []
  for (const e of mine) {
    const start = periods.length ? e.date : e.date < created ? e.date : created
    periods = appendPeriod(periods, { vehicleId: vehicle.id, customerId: e.customerId, status: "ACTIVE" }, start, sameCustomer)
  }
  const current = vehicle.assignedCustomerId ?? null
  if (!periods.length) return current ? [{ vehicleId: vehicle.id, customerId: current, startDate: created, endDate: null, status: "ACTIVE" }] : []
  const last = periods.at(-1)!
  if (last.customerId !== current) periods = appendPeriod(periods, { vehicleId: vehicle.id, customerId: current, status: "ACTIVE" }, last.startDate < todayIso ? todayIso : last.startDate, sameCustomer)
  return periods.map((p) => ({ ...p, status: statusOf(p) }))
}

/**
 * Periods after transferring to `customerId` from `effectiveDate`: the open period ends the day
 * before, a new one starts. Throws if the date would rewrite an earlier assignment.
 */
export function transferPeriods(current: AssignmentPeriod[], vehicleId: string, customerId: string | null, effectiveDate: string): AssignmentPeriod[] {
  const open = current.at(-1)
  if (open && open.customerId === customerId) throw new Error("The vehicle is already assigned to that customer.")
  if (open && effectiveDate <= open.startDate) throw new Error(`Effective date must be after ${open.startDate}, when the current assignment started.`)
  return appendPeriod(current, { vehicleId, customerId, status: "ACTIVE" }, effectiveDate, sameCustomer).map((p) => ({ ...p, status: statusOf(p) }))
}

/** The vehicle search boxes' match: registration (partial, any case), a name (e.g. a tanker's "JIO"), make / model / type. */
export const vehicleMatches = (query: string, v: Vehicle, name?: string) => matchesSearch(query, v.regNo, name, v.make, v.model, `${v.make} ${v.model}`, v.typeCode)

export interface VehicleHit {
  vehicle: Vehicle
  /** The vehicle's customer today (open assignment), null = Unassigned. Never the cached assignedCustomerId. */
  currentCustomerId: string | null
  /** Its customer on `asOf` (a past month's reference day, see asOfMonth), null = Unassigned then. */
  customerIdAsOf: string | null
}

/**
 * Vehicle search (Diesel landing): registration, make / model / type or a name (e.g. a tanker's "JIO"), each
 * vehicle once; exact registration first, then registrations starting with the query, then A–Z.
 */
export function searchVehicles(query: string, vehicles: Vehicle[], assignments: AssignmentPeriod[], todayIso: string, asOf: string, names = new Map<string, string>()): VehicleHit[] {
  const idx = assignmentIndex(assignments)
  const q = query.replace(/[\s-]+/g, "").toUpperCase()
  const reg = (v: Vehicle) => v.regNo.replace(/[\s-]+/g, "").toUpperCase()
  const rank = (v: Vehicle) => (reg(v) === q ? 0 : reg(v).startsWith(q) ? 1 : 2)
  return [...new Map(vehicles.map((v) => [v.id, v])).values()]
    .filter((v) => q && vehicleMatches(query, v, names.get(v.id)))
    .sort((a, b) => rank(a) - rank(b) || a.regNo.localeCompare(b.regNo))
    .map((vehicle) => ({
      vehicle,
      currentCustomerId: assignmentOn(idx, vehicle.id, todayIso)?.customerId ?? null,
      customerIdAsOf: assignmentOn(idx, vehicle.id, asOf)?.customerId ?? null,
    }))
}

export interface CustomerVehicle {
  vehicle: Vehicle
  /** An assignment to this customer covers today. */
  current: boolean
  /** The assignment period: the open one (current), else the latest that ended. */
  startDate: string
  endDate: string | null
  /** Previously assigned only: the vehicle's customer today (null = Unassigned). */
  nowWith: string | null
}

/**
 * A customer's vehicles from the assignment history (never the cached assignedCustomerId): current = an assignment
 * to it covers today; previous = assigned to it before, not today. Periods starting after today are ignored.
 */
export function customerVehicles(customerId: string, assignments: AssignmentPeriod[], vehicles: Map<string, Vehicle>, todayIso: string): CustomerVehicle[] {
  const idx = assignmentIndex(assignments)
  return [...idx.entries()].flatMap(([vehicleId, periods]): CustomerVehicle[] => {
    const vehicle = vehicles.get(vehicleId)
    const mine = periods.filter((p) => p.customerId === customerId && p.startDate <= todayIso)
    if (!vehicle || !mine.length) return []
    const now = assignmentOn(idx, vehicleId, todayIso)
    if (now?.customerId === customerId) return [{ vehicle, current: true, startDate: now.startDate, endDate: now.endDate, nowWith: null }]
    const last = mine.at(-1)!
    return [{ vehicle, current: false, startDate: last.startDate, endDate: last.endDate, nowWith: now?.customerId ?? null }]
  })
}

/* ------------------------------------------------------------------ correcting a start date */

/** An assignment as stored (with its id), for the start-date correction. */
type StoredPeriod = AssignmentPeriod & { id: string }

/** What a start-date correction must never move: entries reported by assignment, and trips shown by assignment. */
export interface AttributedRecords {
  /** Diesel and AdBlue entries: reported under the customer assigned on their date (`resolveCustomers`). */
  entries: (Dated & { kind: "diesel" | "AdBlue" })[]
  /** Trips keep their own customer; the Diesel customer page lists one only while no other customer's assignment covers it. */
  trips: Dated[]
}

/** Why the correction can't be made — the first problem, with what's needed to explain it. */
export type StartDateProblem =
  | { kind: "INVALID_DATE" }
  | { kind: "UNCHANGED" }
  | { kind: "FUTURE" }
  | { kind: "AFTER_END"; endDate: string }
  | { kind: "OVERLAP"; other: StoredPeriod }
  | { kind: "MOVES_ENTRY"; record: "diesel" | "AdBlue"; date: string; from: string | null; to: string | null }
  | { kind: "MOVES_TRIP"; date: string; customerId: string | null }

/** A real yyyy-MM-dd date (not 2026-02-30 or 2026-13-01). */
const isCalendarDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d
/** `[a, b)` on ISO dates; the days whose assignment the correction changes. */
const between = (date: string, a: string, b: string) => date >= a && date < b
const overlaps = (a: { startDate: string; endDate: string | null }, b: { startDate: string; endDate: string | null }) =>
  a.startDate <= (b.endDate ?? "9999-12-31") && b.startDate <= (a.endDate ?? "9999-12-31")

/**
 * Correcting the start date of one assignment (a data-entry fix — same id, customer, end date and status; never a
 * transfer). `periods`: that vehicle's assignments. Refused when the new date is invalid, in the future or after the
 * end date; when it would overlap another assignment of the vehicle (the rule the database enforces today); or when
 * any diesel / AdBlue entry would be reported under a different customer, or a trip shown or hidden on a customer's
 * Diesel page. History never moves silently: the user corrects the record first, or picks another date.
 *
 * ponytail: overlap is per vehicle, as the database's exclusion constraint is now; the shared-vehicle model would
 * narrow it to the same customer (`other.customerId === target.customerId`) together with that constraint.
 */
export function startDateProblem(periods: StoredPeriod[], id: string, startDate: string, records: AttributedRecords, todayIso: string): StartDateProblem | null {
  const target = periods.find((p) => p.id === id)!
  if (!isCalendarDate(startDate)) return { kind: "INVALID_DATE" }
  if (startDate === target.startDate) return { kind: "UNCHANGED" }
  if (startDate > todayIso) return { kind: "FUTURE" }
  if (target.endDate && startDate > target.endDate) return { kind: "AFTER_END", endDate: target.endDate }
  const next = { ...target, startDate }
  const other = periods.find((p) => p.id !== id && overlaps(p, next))
  if (other) return { kind: "OVERLAP", other }
  const after = periods.map((p) => (p.id === id ? next : p))
  const [from, to] = [startDate, target.startDate].sort()
  const before = assignmentIndex(periods)
  const changed = assignmentIndex(after)
  const customerOn = (idx: typeof before, e: Dated) => assignmentOn(idx, e.vehicleId, e.date)?.customerId ?? e.customerId
  for (const e of [...records.entries].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.vehicleId !== target.vehicleId || !between(e.date, from, to)) continue
    const [was, now] = [customerOn(before, e), customerOn(changed, e)]
    if (was !== now) return { kind: "MOVES_ENTRY", record: e.kind, date: e.date, from: was, to: now }
  }
  const listed = (idx: typeof before, t: Dated) => {
    const a = assignmentOn(idx, t.vehicleId, t.date)
    return !a || a.customerId === t.customerId
  }
  for (const t of [...records.trips].sort((a, b) => a.date.localeCompare(b.date))) {
    if (t.vehicleId !== target.vehicleId || !between(t.date, from, to)) continue
    if (listed(before, t) !== listed(changed, t)) return { kind: "MOVES_TRIP", date: t.date, customerId: t.customerId }
  }
  return null
}
