/**
 * Audit trail — pure helpers. Events are written by the API (src/lib/api/index.ts) in the same
 * storage transaction as the change they describe; this file only shapes and reads them.
 * Rules: CLAUDE.md → "Audit Trail and Edit History Rules".
 *
 *   before / after = structured snapshot of the record (never just a text summary)
 *   changes        = top-level fields whose value differs (bookkeeping fields ignored)
 *   Edited badge   = the record has an UPDATED event since the last data reset
 *
 * The audit log only describes what happened. It never feeds a total or a report.
 */
import type { AuditAction, AuditActor, AuditChange, AuditEvent, AuditReview } from "@/lib/types"
import { formatDate, formatINR, formatNumber } from "@/lib/format"
import { roleLabel } from "@/lib/permissions"

/** Not compared: bookkeeping, or a dated history whose meaning shows in `status`. Kept in the snapshot. */
const IGNORED = new Set(["id", "createdAt", "updatedAt", "statusHistory", "assignmentPeriods", "averageCost"])
const SECRET = /password|token|secret|otp/i

/** A structured copy of a record for the audit trail: images reduced to a marker, secrets dropped. */
export function snapshot(record: object | null | undefined): Record<string, unknown> | null {
  if (!record) return null
  const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  for (const k of Object.keys(copy)) {
    if (SECRET.test(k)) delete copy[k]
    else if (k === "logoDataUrl" && copy[k]) copy[k] = "[image]"
  }
  return copy
}

/** Fields whose value differs between two snapshots, in the record's field order. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): AuditChange[] {
  if (!before || !after) return []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys
    .filter((k) => !IGNORED.has(k) && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null }))
}

/** ARCHIVED / RESTORED when a status change is the point of an update, otherwise UPDATED. */
export function statusAction(before: { status?: string } | null, after: { status?: string } | null): AuditAction {
  if (before?.status !== after?.status) {
    if (after?.status === "ARCHIVED") return "ARCHIVED"
    if (before?.status === "ARCHIVED") return "RESTORED"
  }
  return "UPDATED"
}

export interface AuditInput {
  action: AuditAction
  module: string
  recordType: string
  recordId: string
  label: string
  recordDate?: string | null
  before?: object | null
  after?: object | null
  reason?: string | null
  restoresEventId?: string | null
  note?: string | null
}

/** A complete event: snapshots, changed fields, actor and time. */
export function buildEvent(input: AuditInput, actor: AuditActor, id: string, at: string): AuditEvent {
  const before = snapshot(input.before)
  const after = snapshot(input.after)
  return {
    id,
    at,
    actor,
    action: input.action,
    module: input.module,
    recordType: input.recordType,
    recordId: input.recordId,
    label: input.label,
    recordDate: input.recordDate ?? null,
    before,
    after,
    changes: diff(before, after),
    reason: input.reason?.trim() || null,
    ...(input.restoresEventId ? { restoresEventId: input.restoresEventId } : {}),
    ...(input.note ? { note: input.note } : {}),
  }
}

/* ------------------------------------------------------------------ Deletions */

/** A deletion reason must say something: at least this many characters once trimmed. */
export const DELETION_REASON_MIN = 3

/** Why a deletion reason is invalid (null when it's fine). Trimmed; empty or whitespace-only is refused. */
export function deletionReasonError(reason: string | null | undefined, purpose: "deleting" | "restoring" | "adjusting stock" | "correcting" | "back-dating" = "deleting") {
  const r = reason?.trim() ?? ""
  if (!r) return purpose === "adjusting stock" ? "Enter the reason for adjusting stock." : `Enter the reason for ${purpose} this record.`
  if (r.length < DELETION_REASON_MIN) return `The reason must be at least ${DELETION_REASON_MIN} characters.`
  return null
}

/** Deletion event id → the RESTORED event that brought the record back. */
export function restorations(events: AuditEvent[]) {
  return new Map(events.filter((e) => e.restoresEventId).map((e) => [e.restoresEventId!, e]))
}

/**
 * A deletion's status — kept apart so "restored" and "reviewed" never blur:
 *   NEEDS_REVIEW → REVIEWED (Owner looked, kept it deleted) or RESTORED (record brought back).
 *   A restored deletion can still be marked reviewed; a reviewed one can still be restored.
 */
export type DeletionStatus = "NEEDS_REVIEW" | "REVIEWED" | "RESTORED"
export function deletionStatus(reviewed: boolean, restored: boolean): DeletionStatus {
  return restored ? "RESTORED" : reviewed ? "REVIEWED" : "NEEDS_REVIEW"
}

/** Deletion events still needing the Owner — not reviewed and not restored. Counted per event, not per record. */
export function unreviewedDeletions(events: AuditEvent[], reviews: AuditReview[]) {
  const reviewed = new Set(reviews.map((r) => r.eventId))
  const restored = restorations(events)
  return events.filter((e) => e.action === "DELETED" && !reviewed.has(e.id) && !restored.has(e.id))
}

/* ------------------------------------------------------------------ Reading events */

/** Events after the most recent data reset — record ids before it may belong to other records. */
export function sinceLastReset(events: AuditEvent[]) {
  const i = events.findLastIndex((e) => e.action === "DATA_RESET")
  return i < 0 ? events : events.slice(i + 1)
}

/** Ids of records that have been edited (the "Edited" badge). */
export function editedIds(events: AuditEvent[]) {
  return new Set(sinceLastReset(events).filter((e) => e.action === "UPDATED").map((e) => e.recordId))
}

/** Every event for one record since the last reset, oldest first. */
export function recordHistory(events: AuditEvent[], recordId: string) {
  return sinceLastReset(events).filter((e) => e.recordId === recordId)
}

export interface AuditFilter {
  from?: string
  to?: string
  role?: string
  /** actorLabel(), e.g. "Employee (unverified session)" — the user, until real login exists. */
  user?: string
  module?: string
  action?: string
  recordId?: string
  q?: string
}

/** Audit log filter. `from` / `to` are yyyy-MM-dd in IST; `q` searches label, record, reason and fields. */
export function matchesAudit(e: AuditEvent, f: AuditFilter) {
  const day = istDate(e.at)
  if (f.from && day < f.from) return false
  if (f.to && day > f.to) return false
  if (f.role && (e.actor.kind === "SYSTEM" ? "SYSTEM" : e.actor.role) !== f.role) return false
  if (f.user && actorLabel(e.actor) !== f.user) return false
  if (f.module && e.module !== f.module) return false
  if (f.action && e.action !== f.action) return false
  if (f.recordId && !e.recordId.toLowerCase().includes(f.recordId.trim().toLowerCase())) return false
  const q = f.q?.trim().toLowerCase()
  if (q && ![e.label, e.recordId, e.recordType, e.module, e.reason ?? "", actorLabel(e.actor), ...e.changes.map((c) => fieldLabel(c.field))].some((s) => s.toLowerCase().includes(q))) return false
  return true
}

/** Newest first. Same-millisecond events keep their reversed append order (stable sort). */
export const newestFirst = (events: AuditEvent[]) => [...events].reverse().sort((a, b) => b.at.localeCompare(a.at))

/* ------------------------------------------------------------------ Display */

/** All events are stored in UTC and shown in the business's timezone. */
export const AUDIT_TIMEZONE = "Asia/Kolkata"

/** yyyy-MM-dd of an instant in IST. */
export const istDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: AUDIT_TIMEZONE }).format(new Date(iso))

/** "12 Oct 2026, 2:30 pm IST" */
export function formatAuditTime(iso: string) {
  return `${new Intl.DateTimeFormat("en-IN", { timeZone: AUDIT_TIMEZONE, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso))} IST`
}

export const ACTION_LABEL: Record<AuditAction, string> = {
  CREATED: "Created",
  UPDATED: "Edited",
  DELETED: "Deleted",
  ARCHIVED: "Archived",
  RESTORED: "Restored",
  TRANSFERRED: "Transferred",
  PAYMENT_RECORDED: "Payment recorded",
  MONTH_LOCKED: "Month locked",
  MONTH_UNLOCKED: "Month unlocked",
  DATA_RESET: "Data reset",
}

/** "Owner (unverified session)" until real login exists; "System" for app-generated events. */
export function actorLabel(a: AuditActor) {
  if (a.kind === "SYSTEM") return "System"
  if (a.name) return a.name
  return a.role ? `${roleLabel(a.role)} (unverified session)` : "Unknown (not signed in)"
}

const FIELD_LABEL: Record<string, string> = {
  date: "Date",
  vehicleId: "Vehicle",
  customerId: "Customer",
  assignedCustomerId: "Customer",
  vendorId: "Fuel station",
  stationId: "Fuel station",
  driverId: "Driver",
  defaultDriverId: "Driver",
  litres: "Litres",
  quantityLitres: "Litres",
  totalLitres: "Total litres",
  litresPerBucket: "Litres per bucket",
  rate: "Rate",
  amount: "Amount",
  odometerKm: "Odometer",
  closingKm: "Odometer",
  billNo: "Bill no",
  invoiceNo: "Invoice no",
  paymentMode: "Payment",
  mode: "Payment mode",
  vehicleNo: "Vehicle number",
  vendorName: "Vendor",
  pricePerBucket: "Price per bucket",
  totalCost: "Total cost",
  regNo: "Registration",
  shortName: "Short name",
  effectiveDate: "Effective date",
  paymentNo: "Voucher no",
  tripNo: "Trip no",
  startKm: "Start km",
  endKm: "End km",
  distanceKm: "Distance",
  tdsAmount: "TDS",
}
const MONEY = new Set(["amount", "rate", "totalCost", "pricePerBucket", "revenue", "baseAmount", "extraKmAmount", "bataAmount", "tollParking", "subtotal", "cgst", "sgst", "igst", "total", "tdsAmount", "emiAmount", "openingBalance"])
const LITRES = new Set(["litres", "quantityLitres", "totalLitres", "litresPerBucket"])
const KM = new Set(["odometerKm", "closingKm", "startKm", "endKm", "distanceKm"])
const DATES = new Set(["date", "startDate", "endDate", "dueDate", "periodFrom", "periodTo", "effectiveDate", "fitnessValidTill", "permitValidTill", "licenseValidTill"])
/** Fields holding another record's id → resolved to a name for display. */
export const REF_KIND: Record<string, "vehicle" | "customer" | "station" | "driver"> = {
  vehicleId: "vehicle",
  customerId: "customer",
  assignedCustomerId: "customer",
  vendorId: "station",
  stationId: "station",
  driverId: "driver",
  defaultDriverId: "driver",
}

export const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())

export type RefLookup = (kind: "vehicle" | "customer" | "station" | "driver", id: string) => string | undefined

/** A field's value as the Owner should read it: ₹ exact, L, km, dd-MM-yyyy, names for ids. */
export function formatAuditValue(field: string, value: unknown, ref?: RefLookup): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number") {
    if (MONEY.has(field)) return formatINR(value)
    if (LITRES.has(field)) return `${formatNumber(value, 2)} L`
    if (KM.has(field)) return `${formatNumber(value)} km`
    return formatNumber(value, 2)
  }
  if (typeof value === "string") {
    if (DATES.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value)
    const kind = REF_KIND[field]
    if (kind) return ref?.(kind, value) ?? value
    return value
  }
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return JSON.stringify(value)
}

/** "Litres: 100 L → 110 L · Amount: ₹9,500.00 → ₹10,450.00" (first `max` changes). */
export function summarizeChanges(changes: AuditChange[], ref?: RefLookup, max = 3) {
  const shown = changes.slice(0, max).map((c) => `${fieldLabel(c.field)}: ${formatAuditValue(c.field, c.before, ref)} → ${formatAuditValue(c.field, c.after, ref)}`)
  return shown.join(" · ") + (changes.length > max ? ` · +${changes.length - max} more` : "")
}
