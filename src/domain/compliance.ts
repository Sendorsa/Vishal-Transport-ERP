/**
 * Vehicle compliance documents and drivers — one list, used by the vehicle page, the vehicle list and the dashboard.
 * Expiry: Expired (before today), Expiring (within 30 days), Valid; a date never entered is "not recorded".
 */
import { differenceInCalendarDays, parseISO } from "date-fns"
import { formatDate } from "@/lib/format"
import type { Driver, DriverPeriod, ResolvedDocumentAlert, Vehicle } from "@/lib/types"

export const EXPIRING_WITHIN_DAYS = 30

export type ComplianceDocument = "Insurance" | "Road tax" | "Fitness" | "Permit" | "PUC"
export type ExpiryState = "VALID" | "EXPIRING" | "EXPIRED" | "MISSING"

export function expiryOf(date: string | null | undefined, today: string): { state: ExpiryState; days: number | null } {
  if (!date) return { state: "MISSING", days: null }
  const days = differenceInCalendarDays(parseISO(date), parseISO(today))
  return { state: days < 0 ? "EXPIRED" : days <= EXPIRING_WITHIN_DAYS ? "EXPIRING" : "VALID", days }
}

/** A vehicle's documents and their valid-till dates ("" = not recorded). */
export const vehicleDocuments = (v: Vehicle): { document: ComplianceDocument; validTill: string }[] => [
  { document: "Insurance", validTill: v.insurance?.validTill ?? "" },
  { document: "Road tax", validTill: v.roadTax?.validTill ?? "" },
  { document: "Fitness", validTill: v.fitnessValidTill ?? "" },
  { document: "Permit", validTill: v.permitValidTill ?? "" },
  { document: "PUC", validTill: v.pucValidTill ?? "" },
]

/**
 * The vehicle page's Documents card: the most urgent recorded document (earliest valid-till date — an expired one before
 * any expiring or valid one), how many are expired / expiring, and which have no date. "All valid" only when every
 * document is recorded and valid; a date never entered is "not recorded", never valid and never an alert.
 */
export function complianceSummary(v: Vehicle, today: string) {
  const docs = vehicleDocuments(v).map((d) => ({ ...d, ...expiryOf(d.validTill, today) }))
  const recorded = docs.filter((d) => d.days !== null).sort((a, b) => a.validTill.localeCompare(b.validTill))
  const missing = docs.filter((d) => d.days === null).map((d) => d.document)
  const expired = recorded.filter((d) => d.state === "EXPIRED").length
  const expiring = recorded.filter((d) => d.state === "EXPIRING").length
  const state: ExpiryState = expired ? "EXPIRED" : expiring ? "EXPIRING" : missing.length ? "MISSING" : "VALID"
  return { state, next: recorded[0] ?? null, expired, expiring, missing }
}

/* ------------------------------------------------------------------ document expiry alerts (owner, 22 Nov 2026) */

/**
 * Days before the expiry date each document's alert begins. Permit: null — its warning period is not confirmed, so
 * Permits raise no alert (the vehicle page still shows the Permit's own state).
 */
export const ALERT_LEAD_DAYS: Record<ComplianceDocument, number | null> = { Insurance: 7, "Road tax": 5, PUC: 30, Fitness: 30, Permit: null }

/** yyyy-MM-dd ± n calendar days (UTC arithmetic: exact across month ends and leap years, any device time zone). */
const shiftDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10)

/** Vehicles whose documents raise alerts: not Inactive or Archived (as the dashboard always did). */
export const raisesAlerts = (v: Vehicle) => v.status !== "INACTIVE" && v.status !== "ARCHIVED"

/**
 * The alert one document's expiry date raises on `today` (IST yyyy-MM-dd), or null: no date, Permit, or before the
 * warning period. Active from expiry − lead days, on the expiry day (daysLeft 0) and every day after (daysLeft < 0),
 * until the date is changed.
 */
export function alertFor(document: ComplianceDocument, expiryDate: string, today: string): { alertDate: string; daysLeft: number } | null {
  const lead = ALERT_LEAD_DAYS[document]
  const { days } = expiryOf(expiryDate, today)
  if (lead === null || days === null || days > lead) return null
  return { alertDate: shiftDays(expiryDate, -lead), daysLeft: days }
}

export interface ActiveDocumentAlert {
  /** One alert per vehicle, document and expiry date. */
  key: string
  vehicle: Vehicle
  document: ComplianceDocument
  expiryDate: string
  alertDate: string
  daysLeft: number
}

/**
 * Active alerts, the most urgent first. Calculated from the stored expiry dates on every read — nothing is generated or
 * stored, so a page load can never duplicate one and a day nobody opened the ERP is never missed.
 */
export function activeDocumentAlerts(vehicles: Vehicle[], today: string): ActiveDocumentAlert[] {
  return vehicles
    .filter(raisesAlerts)
    .flatMap((vehicle) =>
      vehicleDocuments(vehicle).flatMap(({ document, validTill }) => {
        const a = alertFor(document, validTill, today)
        return a ? [{ key: `${vehicle.id}|${document}|${validTill}`, vehicle, document, expiryDate: validTill, ...a }] : []
      })
    )
    .sort((a, b) => a.daysLeft - b.daysLeft || a.vehicle.regNo.localeCompare(b.vehicle.regNo))
}

/**
 * The alerts an edit resolves: each document whose expiry date changed while its alert was active on `today`. A new
 * date inside its warning period raises a new alert by itself (activeDocumentAlerts); a date removed shows "Not recorded".
 */
export function resolvedByEdit(before: Vehicle, after: Vehicle, today: string, resolvedAt: string, newId: () => string): ResolvedDocumentAlert[] {
  if (!raisesAlerts(before)) return []
  const now = new Map(vehicleDocuments(after).map((d) => [d.document, d.validTill]))
  return vehicleDocuments(before).flatMap(({ document, validTill }) => {
    const next = now.get(document) ?? ""
    const a = next === validTill ? null : alertFor(document, validTill, today)
    if (!a) return []
    return [{ id: newId(), document: document as ResolvedDocumentAlert["document"], regNo: before.regNo, expiryDate: validTill, alertDate: a.alertDate, newExpiryDate: next || null, resolvedAt }]
  })
}

/** Drivers on the vehicle now (an open period). */
export const currentDriverIds = (v: Vehicle) => (v.driverPeriods ?? []).filter((p) => p.endDate === null).map((p) => p.driverId)

/** The vehicle's drivers now: the default driver (even without a dated period) and every open period's driver, once. */
export const vehicleDriverIds = (v: Vehicle) => [...new Set([...(v.defaultDriverId ? [v.defaultDriverId] : []), ...currentDriverIds(v)])]

/** The vehicle's current drivers, resolved from the driver master (a missing record is skipped): the default first, then by name. */
export function vehicleDrivers(v: Vehicle, drivers: Driver[]): { driver: Driver; isDefault: boolean; since: string | null }[] {
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const open = new Map((v.driverPeriods ?? []).filter((p) => p.endDate === null).map((p) => [p.driverId, p.startDate]))
  return vehicleDriverIds(v)
    .flatMap((id) => (byId.has(id) ? [{ driver: byId.get(id)!, isDefault: id === v.defaultDriverId, since: open.get(id) ?? null }] : []))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.driver.name.localeCompare(b.driver.name))
}

/** Closed periods, the most recently ended first (the vehicle page's "Previous drivers"). */
export const pastDriverPeriods = (v: Vehicle) =>
  (v.driverPeriods ?? []).filter((p) => p.endDate !== null).sort((a, b) => b.endDate!.localeCompare(a.endDate!) || b.startDate.localeCompare(a.startDate))

/** Drivers who drove the vehicle on `date` (any period covering it). */
export const driverIdsOn = (v: Vehicle, date: string) =>
  [...new Set((v.driverPeriods ?? []).filter((p) => p.startDate <= date && (p.endDate === null || p.endDate >= date)).map((p) => p.driverId))]

const ISO = /^\d{4}-\d{2}-\d{2}$/
const dayBefore = (iso: string) => new Date(Date.parse(iso) - 86_400_000).toISOString().slice(0, 10)

/**
 * A driver starts on the vehicle `since` (today or back-dated, never in the future). Their periods never overlap. A
 * period closed today and continuing (re-added from its last day or the day after) is reopened — a removal undone the
 * same day — instead of starting a second one. Throws the reason when refused.
 */
export function withDriverAdded(periods: DriverPeriod[], driverId: string, since: string, today: string, newId: () => string): DriverPeriod[] {
  if (!ISO.test(since)) throw new Error("Enter the date the driver started driving this vehicle")
  if (since > today) throw new Error("Driving since can't be in the future.")
  const mine = periods.filter((p) => p.driverId === driverId)
  if (mine.some((p) => p.endDate === null)) throw new Error("This driver already drives this vehicle.")
  const last = mine.sort((a, b) => a.endDate!.localeCompare(b.endDate!)).at(-1)
  if (last && last.endDate! >= today && since >= last.startDate && dayBefore(since) <= last.endDate!) return periods.map((p) => (p === last ? { ...p, endDate: null } : p))
  if (last && since <= last.endDate!) throw new Error(`This driver drove this vehicle until ${formatDate(last.endDate!)} — choose a later date.`)
  // Kept in the database's order (start date, then id), so both stores read the same.
  return [...periods, { id: newId(), driverId, startDate: since, endDate: null }].sort((x, y) => x.startDate.localeCompare(y.startDate) || (x.id < y.id ? -1 : 1))
}

/**
 * A driver stops driving the vehicle; `lastDay` is their last day on it (inclusive; not before they started, not in the
 * future). A period that started today is removed altogether — an add undone the same day leaves no history.
 */
export function withDriverRemoved(periods: DriverPeriod[], driverId: string, lastDay: string, today: string): DriverPeriod[] {
  const open = periods.find((p) => p.driverId === driverId && p.endDate === null)
  if (!open) throw new Error("This driver isn't on this vehicle now.")
  if (open.startDate >= today) return periods.filter((p) => p !== open)
  if (!ISO.test(lastDay)) throw new Error("Enter the driver's last day on this vehicle")
  if (lastDay > today) throw new Error("The last day can't be in the future.")
  if (lastDay < open.startDate) throw new Error("The last day can't be before the driver started on this vehicle.")
  return periods.map((p) => (p === open ? { ...p, endDate: lastDay } : p))
}

/** A DL number as stored: trimmed, single spaces, upper case. */
export const cleanLicenceNo = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase()
