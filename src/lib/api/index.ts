/**
 * The prototype's "backend". Every screen goes through `api.*`; each method maps 1:1
 * to a future REST endpoint (noted alongside). Business rules that the server will own
 * — document numbering, revenue calculation, invoice totals, allocation limits —
 * live here so the UI never computes authoritative values itself.
 */
import { buildInvoice, type InvoiceDraftInput } from "@/domain/invoicing"
import { calculateTripRevenue, fyLabel } from "@/domain/pricing"
import { settlementIndex } from "@/domain/analytics"
import { cleanLicenceNo, currentDriverIds, resolvedByEdit, withDriverAdded, withDriverRemoved } from "@/domain/compliance"
import { adBlueNeighbours } from "@/domain/adblue"
import { allocationProblem, industrialAmount, industrialProblem, sortedAllocations, type TankerAllocation } from "@/domain/industrial"
import { odometerConflict } from "@/domain/diesel"
import { dayBefore, statusOn, withStatus } from "@/domain/status-history"
import { withCompanyChange } from "@/domain/drivers"
import { COMPANIES } from "@/lib/constants"
import { canEditMonth } from "@/domain/month-lock"
import { ADBLUE_PAYMENT_MODES, CREDIT as AB_CREDIT, directPayable, ON_ACCOUNT, isPayableDirect, paidByPurchase, payableLabel, payablesOf, type Payable, paymentProblem as abPaymentProblem, purchaseValue, referenceNoun as abReferenceNoun, refKey, settledOf as abSettled, tdsProblem as abTdsProblem, tdsSplit as abTdsSplit, unallocated as abUnallocated, type PurchasePaymentType } from "@/domain/adblue-payments"
import { adBlueTotals, isDirectAdBlue, NO_VENDOR_LABEL, adBlueShortfallMessage, stockDraws, valueInventory } from "@/domain/adblue-inventory"
import { availabilityMessage, fillAmount, fitsTanker, isStockPool, isTankerFill, normReg, shortfallMessage, tankerAvailability, tankerOf, valueTankers, type TankerRecords } from "@/domain/tanker"
import { STATION_PAYMENT_CATEGORY, isStationPayment, tdsDate, tdsPaymentProblem, tdsSplit, tdsTakenOn } from "@/domain/station-ledger"
import { currentActor, currentRole, customerScope } from "@/lib/identity"
import { can, canChangeAdBluePurchases, canLockExpenseMonths, canManageAdBluePayments, canSetMonthLock, expenseSectionAllowed, hasHiddenExpenseSections, hasOwnerAuthority, isAdBlueProfile, type Resource } from "@/lib/permissions"
import { buildEvent, deletionReasonError, editedIds, newestFirst, recordHistory, restorations, statusAction, unreviewedDeletions, type AuditInput } from "@/domain/audit"
import { addMonths, format, parseISO } from "date-fns"
import { cleanName, CREDIT, financialChanges, itemProblem, lineAmounts, masterKey, OFFICE_LABEL, paidByInvoice, paymentProblem, referenceNoun, settledOf, tdsProblem, TYRE_MASTER_LABEL, TYRE_PAYMENT_MODES, tyreTdsSplit, tyreTotals, unallocated, utrKey } from "@/domain/tyre"
import { assignmentIndex, assignmentOn, correctedPeriods, handedOverBy, inferAssignments, isCalendarDate, movedRecords, resolveCustomers, startDateProblem, transferPeriods, type AssignmentPeriod, type AttributedRecords, type MovedRecord, type StartDateProblem } from "@/domain/assignments"
import { formatDate, formatINR, formatNumber, round2, todayISO, formatLitres } from "@/lib/format"
import { appendAuditEvent, appendAuditReviews, readAuditEvents, readAuditReviews, readCollection, readSettings, runInTransaction, writeCollection, writeSettings } from "@/lib/storage/local-store"
import type { AdBlueEntry, AdBluePayment, AdBluePurchase, AdBlueVendor, AuditEvent, Broker, CompanyCode, Expense, ExpenseImportBatch, ExpenseImportItem, ExpenseMonthLock, ExpenseSection, Customer, DieselEntry, Driver, FuelStation, IndustrialSupply, Invoice, NewEntity, TyreInvoice, TyreInvoiceItem, TyreMaster, TyreMasterKind, TyrePayment, TyreTaxType, Payment, PaymentMode, Settings, Tanker, TankerAdjustment, TankerDispense, TankerLoad, TankerTransfer, Trip, Vehicle, VehicleAssignment } from "@/lib/types"
import { ensureSeeded, exportBackup, loadDemoData, loadEmptyWorkspace, parseBackup, restoreBackup, type BackupFile } from "./bootstrap"
import { createLocalRepository, latency, newId, NotFoundError } from "./repository"
import { ConflictError, pendingVersions, runWithVersions } from "@/lib/versions"
import { NeedData, requestScope } from "@/lib/request-scope"
import { cleanWorkspace } from "@/lib/storage/seed"
import { BROKER_ENTRY_LABEL, EXPENSE_SECTIONS, brokerOutstanding, descriptionOptions, entriesOf, expenseProblems, firstOverpayment, hasValidity, isMonthLocked, monthOf, textKey, type ExpenseInput } from "@/domain/expenses"

export { NotFoundError, ConflictError }

/** A refusal because of the caller's role or customer scope (the server logs these: `[erp-denied]`). */
export class PermissionError extends Error {}

/** A payment to a fuel station (stored as a payment voucher — see api.fuelStationPayments). */
export interface FuelStationPayment {
  id: string
  stationId: string
  paymentDate: string
  /** "yyyy-MM" the payment was paid against; null = not recorded (paid before 31 Oct 2026). */
  forMonth: string | null
  /** Total settled (= paid + TDS) — what the ledger counts. */
  amount: number
  /** What reached the station (bank / cash). */
  paidAmount: number
  /** TDS deducted on it (0 when none). */
  tdsAmount: number
  /** "Deduct TDS?": the % applied; null when TDS wasn't deducted on this payment. */
  tdsRate: number | null
  /** UTR / transaction reference. */
  reference: string
  paymentMode: PaymentMode
  notes: string
  paymentNo: string
  companyCode: CompanyCode
  /** A TDS deduction (u/s 194Q) rather than money paid — `amount` is the TDS. */
  tds: boolean
  /** The voucher's version, for optimistic concurrency (src/lib/versions.ts). */
  updatedAt: string
}

const customers = createLocalRepository("customers", "cus") // /api/customers
const vehicles = createLocalRepository("vehicles", "veh") // /api/vehicles
const drivers = createLocalRepository("drivers", "drv") // /api/drivers
const trips = createLocalRepository("trips", "trp") // /api/trips
const diesel = createLocalRepository("diesel_entries", "dsl") // /api/diesel-entries
const adblue = createLocalRepository("adblue_entries", "adb") // /api/adblue-entries
const assignments = createLocalRepository("vehicle_assignments", "vas") // /api/vehicle-assignments
const monthLocks = createLocalRepository("month_locks", "mlk") // /api/month-locks
const fuelStations = createLocalRepository("fuel_stations", "dv") // /api/fuel-stations
const adbluePurchases = createLocalRepository("adblue_purchases", "adp") // /api/adblue-purchases
const adblueVendors = createLocalRepository("adblue_vendors", "adv") // /api/adblue-vendors
const adbluePayments = createLocalRepository("adblue_payments", "abp") // /api/adblue-payments
const tankerLoads = createLocalRepository("tanker_loads", "tkl") // /api/tanker-loads
const tankerDispenses = createLocalRepository("tanker_dispenses", "tkd") // /api/tanker-dispenses
const tankers = createLocalRepository("tankers", "tnk") // /api/tankers
const tankerTransfers = createLocalRepository("tanker_transfers", "tkt") // /api/tanker-transfers
const tankerAdjustments = createLocalRepository("tanker_adjustments", "tka") // /api/tanker-adjustments
const industrialSupplies = createLocalRepository("industrial_supplies", "ind") // /api/industrial-supplies
const tyreMasters = createLocalRepository("tyre_masters", "tym") // /api/tyre-masters
const tyreInvoices = createLocalRepository("tyre_invoices", "tyr") // /api/tyre-invoices
const tyrePayments = createLocalRepository("tyre_payments", "tpy") // /api/tyre-payments
const expenses = createLocalRepository("expenses", "exp") // Expense module (Phase 1: browser backend only)
const brokers = createLocalRepository("brokers", "brk") // Broker Charges → broker list (Phase 1: browser backend only)
const expenseMonthLocks = createLocalRepository("expense_month_locks", "eml") // Expense → locked section-months
const expenseImportBatches = createLocalRepository("expense_import_batches", "imp") // Expense → applied imports (shared database, Dev)
const invoices = createLocalRepository("invoices", "inv") // /api/invoices
const payments = createLocalRepository("payments", "pay") // /api/payments

function settingsOrThrow(): Settings {
  ensureSeeded()
  const s = readSettings()
  if (!s) throw new Error("Settings not initialised")
  return s
}

function companyPrefix(code: CompanyCode) {
  return settingsOrThrow().companies.find((c) => c.code === code)?.invoicePrefix ?? code
}

/** Next sequence for numbers shaped `<prefix><seq>` (prefix includes everything before the digits). */
function nextSeq(existing: string[], prefix: string) {
  let max = 0
  for (const no of existing) if (no.startsWith(prefix)) max = Math.max(max, Number(no.slice(prefix.length)) || 0)
  return max + 1
}

/**
 * A vehicle's AdBlue entry. STOCK (default): a draw from inventory — no vendor or ₹ (cost comes from the
 * inventory's average rate). DIRECT: bought from a vendor for this vehicle — vendor, rate (₹ = litres × rate).
 */
export type AdBlueInput = Omit<NewEntity<AdBlueEntry>, "vendorId" | "amount"> & {
  /**
   * Direct purchase on credit (paymentMode "CREDIT") only — the Payment Details (owner, 18 Nov 2026): a NEW payment for
   * what is still owed, saved with the entry in one transaction (the same rules as a bulk purchase's). Never stored.
   */
  payment?: AdBluePurchaseInput["payment"]
}
export type TankerLoadInput = Pick<TankerLoad, "date" | "stationId" | "invoiceNo" | "litres" | "rate" | "notes"> & { tankerId: string }
export type TankerDispenseInput = Pick<TankerDispense, "date" | "vehicleNo" | "litres" | "notes"> & { tankerId: string }
export type TankerInput = Pick<Tanker, "name" | "regNo" | "vehicleId" | "capacityLitres" | "notes">
export type TankerTransferInput = Pick<TankerTransfer, "date" | "fromTankerId" | "toTankerId" | "litres" | "notes">
export type TankerAdjustmentInput = Pick<TankerAdjustment, "date" | "tankerId" | "litres" | "reason">

const tankerName = (id: string) => readCollection("tankers").find((t) => t.id === id)?.name ?? "Unknown tanker"

/** A new tanker record must name an existing tanker that isn't archived (archived tankers keep their history). */
function assertTankerOpen(tankerId: string | undefined, what = "Choose the tanker") {
  const t = tankerId ? readCollection("tankers").find((x) => x.id === tankerId) : undefined
  // A stock pool (no registration) holds only history recorded before the tankers were split; nothing new goes into it.
  if (!t || isStockPool(t)) throw new Error(what)
  if (t.status === "ARCHIVED") throw new Error(`${t.name} is archived. Restore it to add new records.`)
  return t
}

/** A pump fill must name an existing fuel station — never the tanker source or an id with no station behind it. */
function assertPumpStation(vendorId: string) {
  const station = readCollection("fuel_stations").find((v) => v.id === vendorId)
  if (!station || station.isTanker) throw new Error("Choose the fuel station the diesel was bought from")
}

/**
 * A fill's odometer: a real reading (a number ≥ 0) that fits the vehicle's sequence of fills — never below the previous
 * dated fill, never above the next one (odometerConflict). `id` = the fill being edited (left out of the sequence).
 */
function assertFillOdometer(vehicleId: string, id: string | null, date: string, km: number) {
  if (!(Number.isFinite(km) && km >= 0)) throw new Error("Enter the odometer reading (km)")
  const others = readCollection("diesel_entries").filter((e) => e.vehicleId === vehicleId && e.id !== id)
  const c = odometerConflict(others, date, km)
  if (c?.side === "previous") throw new Error(`Odometer ${formatNumber(km)} km is below the previous fill (${formatNumber(c.km)} km on ${formatDate(c.date)}).`)
  if (c) throw new Error(`Odometer ${formatNumber(km)} km is above the next fill (${formatNumber(c.km)} km on ${formatDate(c.date)}), whose KM Run would go negative.`)
}

/**
 * The vehicle's "last known km" (`odometerKm`, a cache) after a fill's reading changed (`was` → `now`) or the fill was
 * deleted (`now` null): raised to a higher reading, and — when the old reading was what set it — lowered back to the
 * vehicle's highest remaining reading (its opening odometer at least), so a corrected typo no longer shows. A value
 * entered on the vehicle above every fill is left alone. Display only: no figure, KM Run or report reads it.
 */
async function syncVehicleOdometer(vehicleId: string, was: number | null, now: number | null) {
  const v = readCollection("vehicles").find((x) => x.id === vehicleId)
  if (!v) return
  let km = v.odometerKm
  if (now !== null && now > km) km = now
  else if (was !== null && was === v.odometerKm) {
    const highest = readCollection("diesel_entries").reduce((m, e) => (e.vehicleId === vehicleId && e.odometerKm !== null && e.odometerKm > m ? e.odometerKm : m), v.openingOdometerKm ?? 0)
    if (highest < km) km = highest
  }
  if (km !== v.odometerKm) await vehicles.update(vehicleId, { odometerKm: km })
}

function checkLoad(input: TankerLoadInput, existing?: TankerLoad) {
  if (!existing || existing.tankerId !== input.tankerId) assertTankerOpen(input.tankerId, "Choose the tanker the diesel was loaded into")
  const station = readCollection("fuel_stations").find((v) => v.id === input.stationId)
  if (!station || station.isTanker) throw new Error("Choose the fuel station / supplier the diesel was loaded from")
  if (!(input.litres > 0)) throw new Error("Litres loaded must be greater than 0")
  if (!(input.rate > 0)) throw new Error("Enter the rate per litre")
  if (input.date > todayISO()) throw new Error("A load can't be dated in the future.")
  return { ...input, invoiceNo: input.invoiceNo.trim(), notes: input.notes.trim(), amount: round2(input.litres * input.rate) }
}

function checkExternal(input: TankerDispenseInput, existing?: TankerDispense) {
  if (!existing || existing.tankerId !== input.tankerId) assertTankerOpen(input.tankerId, "Choose the tanker the diesel came out of")
  if (!input.vehicleNo.trim()) throw new Error("Enter the external vehicle number")
  if (!(input.litres > 0)) throw new Error("Litres dispensed must be greater than 0")
  if (input.date > todayISO()) throw new Error("A dispense can't be dated in the future.")
  return { ...input, vehicleNo: input.vehicleNo.trim().toUpperCase(), notes: input.notes.trim() }
}

/** The vendor: `adblueVendorId` (the picker), or — older callers — an existing vendor's name (a new name creates the vendor when the role may). */
export type AdBluePurchaseInput = Pick<AdBluePurchase, "date" | "product" | "buckets" | "litresPerBucket" | "pricePerBucket" | "invoiceNo" | "notes"> & {
  adblueVendorId?: string | null
  vendorName?: string
  /** GST % on the Total Cost (0 / absent = none). */
  gstRate?: number
  /**
   * Purchase Payment Details (the Owner, Dev and Employee): a NEW payment saved with the purchase in one transaction.
   * CREDIT / absent = nothing paid now (no payment). FULL = what the purchase still owes (its value when new; value − Σ
   * existing payments on an edit — more only with `acceptAdvance`); PARTIAL = less than that. Existing payments are
   * never changed by a purchase edit (Payments → Edit / Delete corrects them).
   */
  payment?: { type: PurchasePaymentType; amount?: number; mode?: string; utr?: string; date?: string; tdsPercent?: number | null; companyCode?: CompanyCode | null; notes?: string; acceptAdvance?: boolean }
}
/** A payment to an AdBlue vendor, allocated to its purchases; the rest (explicitly) advance credit. */
export interface AdBluePaymentInput {
  date: string
  vendorId: string
  /** The total settled (with "Deduct TDS?": before TDS; the vendor receives the rest). */
  amount: number
  /** "Deduct TDS?": the TDS %; absent / null = off. */
  tdsPercent?: number | null
  mode: string
  utr: string
  companyCode?: CompanyCode | null
  notes?: string
  allocations: { purchaseId: string; amount: number }[]
  acceptAdvance?: boolean
}

export interface AdBlueVendorInput {
  name: string
  defaultRate: number | null
  contactPerson?: string
  phone?: string
  notes?: string
}

/* ------------------------------------------------------------------ Vehicle assignments */

/** A vehicle's assignment periods; inferred from its entries the first time (see inferAssignments). */
function periodsOf(vehicleId: string): AssignmentPeriod[] {
  const stored = readCollection("vehicle_assignments").filter((a) => a.vehicleId === vehicleId)
  if (stored.length) return stored.sort((a, b) => a.startDate.localeCompare(b.startDate))
  const vehicle = readCollection("vehicles").find((v) => v.id === vehicleId)
  return vehicle ? inferAssignments(vehicle, [...readCollection("diesel_entries"), ...readCollection("adblue_entries")], todayISO()) : []
}

/** Saves a vehicle's periods. Append-only: existing records keep their id, only the open one gets its end date. */
function savePeriods(vehicleId: string, periods: AssignmentPeriod[]) {
  const all = readCollection("vehicle_assignments")
  const mine = all.filter((a) => a.vehicleId === vehicleId).sort((a, b) => a.startDate.localeCompare(b.startDate))
  const now = new Date().toISOString()
  const next = periods.map((p, i) => (mine[i] ? { ...mine[i], ...p, updatedAt: now } : { ...p, id: newId("vas"), createdAt: now, updatedAt: now }))
  writeCollection("vehicle_assignments", [...all.filter((a) => a.vehicleId !== vehicleId), ...next])
}

/**
 * New operational records only under the customer the vehicle is assigned to on that date.
 * Returns that customer (the caller's when no assignment covers the date).
 */
function assignedCustomer(vehicleId: string, date: string, customerId: string | null) {
  const a = assignmentOn(assignmentIndex(periodsOf(vehicleId)), vehicleId, date)
  if (!a) return customerId
  if (customerId && a.customerId !== customerId) {
    const name = (id: string | null) => (id ? (readCollection("customers").find((c) => c.id === id)?.shortName ?? "another customer") : "no customer")
    const reg = readCollection("vehicles").find((v) => v.id === vehicleId)?.regNo ?? "This vehicle"
    throw new Error(`${reg} is assigned to ${name(a.customerId)} on ${date}, not ${name(customerId)}. Add it under ${name(a.customerId)}.`)
  }
  return a.customerId
}

/**
 * A date change never moves a Diesel or AdBlue entry into another customer's assignment period (history never moves
 * silently; for Tata Adblue it would also leave its customer scope). Compares the customer the reports resolve on the old and the new
 * date. Names no customer: the caller may not be allowed to see the other one.
 */
function assertSameCustomerOnDate(vehicleId: string, customerId: string | null, from: string, to: string) {
  if (from === to) return
  const idx = assignmentIndex(periodsOf(vehicleId))
  const on = (date: string) => assignmentOn(idx, vehicleId, date)?.customerId ?? customerId
  if (on(to) !== on(from)) throw new Error(`${regNo(vehicleId)} worked for a different customer on ${formatDate(to)}. Changing the date can't move this entry to another customer — delete it and add it again under the right customer.`)
}

const resolved = <E extends { vehicleId: string; customerId: string | null; date: string }>(list: E[]) => resolveCustomers(list, readCollection("vehicle_assignments"))

const who = (id: string | null) => (id ? customerName(id) : "no customer")

/** The records a dated assignment change must not move (`movedRecords`): every diesel / AdBlue entry and trip. */
const attributedRecords = (): AttributedRecords => ({
  entries: [...readCollection("diesel_entries").map((e) => ({ ...e, kind: "diesel" as const })), ...readCollection("adblue_entries").map((e) => ({ ...e, kind: "AdBlue" as const }))],
  trips: readCollection("trips"),
})

/** A record a transfer or start-date correction would move, named exactly: vehicle, date, litres / trip number, customer. */
function movedMessage(p: MovedRecord, reg: string, what: "start date" | "effective date") {
  const an = what === "effective date" ? "an effective date" : "a start date"
  const more = p.more ? ` ${p.more} more record${p.more === 1 ? "" : "s"} would move too.` : ""
  if (p.kind === "MOVES_ENTRY")
    return `${reg} has a ${p.record} entry on ${formatDate(p.date)}${p.litres ? ` (${formatLitres(p.litres)})` : ""} reported under ${who(p.from)}. This ${what} would move it to ${who(p.to)}, and history never moves silently. Correct that entry first, or choose ${an} that leaves it where it is.${more}`
  return `${reg} has a trip${p.tripNo ? ` ${p.tripNo}` : ""} on ${formatDate(p.date)} billed to ${who(p.customerId)}. This ${what} would change where that trip is shown. Correct that trip first, or choose ${an} that leaves it where it is.${more}`
}

/** Why an assignment's start date can't be corrected, in the Owner's words (see `startDateProblem`). */
function startDateMessage(p: StartDateProblem, a: VehicleAssignment) {
  const reg = regNo(a.vehicleId)
  switch (p.kind) {
    case "INVALID_DATE":
      return "Enter the new start date."
    case "UNCHANGED":
      return `The assignment already starts on ${formatDate(a.startDate)}. Choose a different date.`
    case "FUTURE":
      return "The start date can't be in the future."
    case "AFTER_END":
      return `The start date can't be after the assignment's end date (${formatDate(p.endDate)}).`
    case "BEFORE_PREVIOUS":
      return `${reg} was assigned to ${who(p.other.customerId)} from ${formatDate(p.other.startDate)} until this assignment began. The start date must be after ${formatDate(p.other.startDate)}, so that assignment keeps at least one day.`
    case "OVERLAP":
      return `${reg} is assigned to ${who(p.other.customerId)} from ${formatDate(p.other.startDate)} to ${p.other.endDate ? formatDate(p.other.endDate) : "today"}. An assignment can't overlap another one of the same vehicle — choose a start date after that.`
    default:
      return movedMessage(p, reg, "start date")
  }
}

/** The Monthly Sheet Lock on every month from `from` to `to` (inclusive) — the days a dated assignment change re-files. */
function assertMonthsEditable(from: string, to: string) {
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = format(addMonths(parseISO(`${m}-01`), 1), "yyyy-MM")) assertMonthEditable(`${m}-01`)
}

/* ------------------------------------------------------------------ Permissions */

/** Creates, edits and deletes are checked here, not only hidden in the UI (src/lib/permissions.ts). */
function assertCan(resource: Resource, action: "create" | "edit" | "delete") {
  const what: Partial<Record<Resource, string>> = { diesel: "fuel", adblue: "AdBlue", payments: "payment", trips: "trip", vehicles: "tanker or vehicle", customers: "customer", invoices: "invoice", expenses: "expense" }
  if (!can(currentRole(), resource, action)) throw new PermissionError(`Your role can't ${action} ${what[resource] ?? resource} records.`)
}

/**
 * Tata Adblue works only with the customers Dev granted it (customerScope); every other role with every customer.
 * Checked after the entry's customer is stamped from the vehicle's assignment, so it can't be chosen around. RLS
 * (private.customer_in_scope) checks the same on the shared database.
 */
/**
 * The AdBlue profiles record AdBlue only for a vehicle assigned to a customer on the entry's date (owner, 11 Nov 2026):
 * never a spare vehicle, nor a date before its first or after its last assignment — otherwise the caller's customer
 * would be stamped on it (assignedCustomer), outside any real assignment. Owner, Dev and Employee are unchanged.
 * Names no customer. Checked on add and on every edit (against the new date).
 */
function assertProfileAssignment(vehicleId: string, date: string) {
  if (!isAdBlueProfile(currentRole())) return
  const v = readCollection("vehicles").find((x) => x.id === vehicleId)
  if (!v) throw new NotFoundError("Vehicle", vehicleId)
  if (assignmentOn(assignmentIndex(periodsOf(vehicleId)), vehicleId, date)?.customerId) return // an unassigned period has none
  const reg = v.regNo
  throw new PermissionError(`${reg} has no customer assignment on ${formatDate(date)}. Your account can add AdBlue only for a vehicle assigned to a customer on the entry date.`)
}

function assertCustomerScope(customerId: string | null) {
  const scope = customerScope()
  if (scope && !(customerId && scope.has(customerId))) throw new PermissionError("Your account can't add or change AdBlue entries for this customer. Ask Dev for access.")
}

/** Editing / deleting a bulk AdBlue purchase: the Owner, Dev and Employee (canChangeAdBluePurchases). */
function assertChangeAdBluePurchase(action: "edit" | "delete") {
  if (!canChangeAdBluePurchases(currentRole(), action)) throw new PermissionError(`Your role can't ${action} AdBlue purchases.`)
}

/** Drivers are added from Settings → Drivers (settings:edit) and inline from the vehicle forms (vehicles:edit). */
function assertDriverAccess() {
  if (!can(currentRole(), "settings", "edit") && !can(currentRole(), "vehicles", "edit")) throw new Error("Your role can't change drivers.")
}

/** Owner-level openings (go-live): the Owner, Dev and the Employee (hasOwnerAuthority). */
function assertWorkspaceAdmin(what: string) {
  if (!hasOwnerAuthority(currentRole())) throw new Error(`Only the Owner or Dev can ${what}.`)
}

/** Settings → Data (restore, reset, clear, tanker-master setup, backup): Owner-level authority and Settings — never the Employee. */
function assertDataAdmin(what: string) {
  if (!hasOwnerAuthority(currentRole()) || !can(currentRole(), "settings", "edit")) throw new Error(`Only the Owner or Dev can ${what}.`)
}

/**
 * Whole-workspace replace / wipe exists only for a browser's own data. The shared database is never reset, cleared or
 * restored from the application, for any role (D-9): recovery uses Supabase backups / point-in-time recovery.
 */
function assertNotShared(what: string) {
  if (requestScope()) throw new Error(`${what} isn't available on the shared database. Recovery uses the database's backups.`)
}

/** Every delete needs a real reason (trimmed; empty or whitespace-only refused) — checked here, not only in the dialog. */
function assertReason(reason: string | null | undefined) {
  const error = deletionReasonError(reason)
  if (error) throw new Error(error)
}

/* ------------------------------------------------------------------ Industrial Diesel Supply */

export interface IndustrialSupplyInput {
  customerId: string
  date: string
  litres: number
  rate: number
  purpose: string
  remarks: string
  /** The tankers it came out of, together exactly `litres` (owner, 12 Nov 2026). */
  allocations: TankerAllocation[]
}

/**
 * A supply as it is saved: validated (domain/industrial.ts), for an existing customer open on the date, amount
 * calculated, its tanker allocations adding up to the litres. `keep`: tankers of the record being edited — those may stay
 * on an archived tanker (its existing records stay editable); any other tanker must be an active company tanker.
 */
function checkIndustrial(input: IndustrialSupplyInput, keep: string[] = []): NewEntity<IndustrialSupply> {
  const problem = industrialProblem(input, todayISO()) ?? allocationProblem(input.litres, input.allocations)
  if (problem) throw new Error(problem)
  if (!readCollection("customers").some((c) => c.id === input.customerId)) throw new NotFoundError("Customer", input.customerId)
  assertCustomerScope(input.customerId)
  assertCustomerOpen(input.customerId, input.date)
  for (const a of input.allocations) {
    if (keep.includes(a.tankerId)) {
      const t = readCollection("tankers").find((x) => x.id === a.tankerId)
      if (!t || isStockPool(t)) throw new Error("Choose the tanker the diesel was supplied from")
    } else assertTankerOpen(a.tankerId, "Choose the tanker the diesel was supplied from")
  }
  return { customerId: input.customerId, date: input.date, litres: input.litres, rate: input.rate, amount: industrialAmount(input.litres, input.rate), purpose: input.purpose.trim(), remarks: (input.remarks ?? "").trim(), allocations: sortedAllocations(input.allocations) }
}

/**
 * Each tanker can give what it holds on the supply's date — the same rule as a vehicle fill (tankerAvailability: the
 * lowest stock from that moment on, so no later record goes below zero). `id`: the supply being edited — its own
 * allocations are left out first, so its original litres are back in the tankers before the new ones are taken.
 */
function assertIndustrialStock(supply: { id: string; date: string; createdAt: string; allocations: TankerAllocation[] }) {
  const records = tankerRecords()
  for (const a of supply.allocations) {
    const available = tankerAvailability(records, { id: supply.id, date: supply.date, createdAt: supply.createdAt, tankerId: a.tankerId, kind: "INDUSTRIAL" })
    if (!fitsTanker(available, a.litres)) throw new Error(availabilityMessage(available, tankerName(a.tankerId), supply.date))
  }
}

/** Who saves it: the signed-in profile on the shared database (which sets it again itself); none in the browser store. */
const actorProfileId = () => currentActor().userId

/* ------------------------------------------------------------------ Month lock */

/** Employees can't add or change data in a locked month; the Owner and Dev always can (src/domain/month-lock.ts). */
function assertMonthEditable(date: string) {
  const month = date.slice(0, 7)
  if (!canEditMonth(currentRole(), month, todayISO(), readCollection("month_locks")))
    throw new Error(`${format(parseISO(`${month}-01`), "MMMM yyyy")} is locked. Only the Owner or Dev can change it, or unlock it for you.`)
}

/**
 * Fuel station payments: recorded at any time — there is no grace period (owner, 31 Oct 2026) — but never dated in
 * the future. Back-dating into a locked month is the Monthly Sheet Lock's call (assertMonthEditable: Owner only).
 * "Paid against" (`forMonth`) is a "yyyy-MM" no later than the payment's own month; it never moves it in the ledger.
 */
/**
 * A station voucher's money fields from the total settled and "Deduct TDS?" (null / undefined = off: as before).
 * On: amount = paid to the station, tdsAmount = the TDS, tdsRate = the % — the ledger counts amount + tdsAmount.
 */
function stationTds(total: number, percent: number | null | undefined, mode: PaymentMode): Pick<Payment, "amount" | "tdsAmount" | "tdsRate"> {
  if (percent === null || percent === undefined) return { amount: round2(total), tdsAmount: 0, tdsRate: undefined }
  if (mode === "TDS") throw new Error("Choose how the payment was made (NEFT, UPI, cheque or cash)")
  const problem = tdsPaymentProblem(Number(total), Number(percent))
  if (problem) throw new Error(problem)
  const { tds, paid } = tdsSplit(Number(total), Number(percent))
  return { amount: paid, tdsAmount: tds, tdsRate: Number(percent) }
}

/**
 * Per-payment TDS on purchases whose month already has a monthly TDS entry = the same purchases taxed twice: refused
 * unless the user confirmed it is separate (`confirmSeparateTds`). A payment with no TDS (or 0%) is never affected.
 */
function assertNoDoubleTds(stationId: string, forMonth: string | undefined, tdsAmount: number, confirmed: boolean | undefined) {
  if (!(tdsAmount > 0) || !forMonth || confirmed) return
  const { monthly } = tdsTakenOn(readCollection("payments"), stationId, forMonth)
  if (monthly)
    throw new Error(`TDS for ${format(parseISO(`${forMonth}-01`), "MMMM yyyy")} purchases is already recorded as a monthly TDS entry (${monthly.paymentNo}, ${formatINR(monthly.tdsAmount)}). Deducting TDS on this payment too would tax the same purchases twice. Confirm it is separate TDS to save it, or switch off "Deduct TDS?".`)
}

function assertStationPaymentDate(p: { date: string; amount: number; vendorId: string | null; direction: "IN" | "OUT"; categoryCode: string | null; forMonth?: string }) {
  if (!p.vendorId || !isStationPayment(p, p.vendorId)) return
  if (p.date > todayISO()) throw new Error("A payment can't be dated in the future.")
  if (p.forMonth === undefined) return
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.forMonth)) throw new Error("Choose the month this payment is against")
  if (p.forMonth > p.date.slice(0, 7)) throw new Error("A payment can't be against a month after its payment date")
}

/** Archived customers / vehicles keep their history but accept no records dated while archived. */
function assertCustomerOpen(customerId: string | null | undefined, date: string) {
  if (!customerId) return
  const c = readCollection("customers").find((x) => x.id === customerId)
  if (c && statusOn(c, date) === "ARCHIVED") throw new Error(`${c.shortName || c.name} is archived on ${date}. Restore the customer to add new records.`)
}
/**
 * New Diesel, AdBlue and trip records (and restores) only for an existing vehicle and customer — never one created on
 * the way (owner, 11 Nov 2026). The shared database's foreign keys refuse it too; the browser store has none.
 */
function assertOpen(vehicleId: string, customerId: string | null, date: string) {
  const v = readCollection("vehicles").find((x) => x.id === vehicleId)
  if (!v) throw new NotFoundError("Vehicle", vehicleId)
  if (customerId && !readCollection("customers").some((c) => c.id === customerId)) throw new NotFoundError("Customer", customerId)
  if (statusOn(v, date) === "ARCHIVED") throw new Error(`${v.regNo} is archived on ${date}. Restore the vehicle to add new entries.`)
  assertCustomerOpen(customerId, date)
}

function checkAdBlue(input: AdBlueInput, id?: string): NewEntity<AdBlueEntry> {
  const { prev, next } = adBlueNeighbours(readCollection("adblue_entries"), input.vehicleId, input.date, id)
  if (prev && !(input.closingKm > prev.closingKm)) throw new Error("Closing odometer must be greater than the last recorded odometer.")
  if (next && !(input.closingKm < next.closingKm)) throw new Error("Closing odometer must be less than the next AdBlue entry's odometer.")
  if (!(input.quantityLitres > 0)) throw new Error("AdBlue quantity must be greater than 0")
  if (input.date > todayISO()) throw new Error("An AdBlue entry can't be dated in the future.")
  const view = { ...input }
  delete (view as AdBlueInput).payment // a payment is its own record (adbluePayments), never stored on the entry
  delete view.sourceVendor // read-only view fields, never stored
  delete view.costRate
  delete view.beforeVendorTracking // set by the API only: false on create, kept as stored on edit
  if (!isDirectAdBlue(input)) {
    // A stock draw takes its vendor's stock (FIFO); it has no rate or payment of its own.
    const draw = { ...view, source: "STOCK" as const, vendorId: "", amount: 0, adblueVendorId: input.adblueVendorId || null }
    delete draw.vendorName
    delete draw.rate
    delete draw.paymentMode
    return draw
  }
  // Direct vendor purchase: its own vendor and rate; never enters or leaves bulk stock.
  if (!input.vendorName?.trim()) throw new Error("Enter the vendor the AdBlue was bought from")
  if (!(Number(input.rate) > 0)) throw new Error("Enter the rate per litre")
  return { ...view, source: "DIRECT", vendorName: input.vendorName.trim(), rate: round2(Number(input.rate)), vendorId: "", amount: round2(input.quantityLitres * Number(input.rate)), adblueVendorId: input.adblueVendorId || null }
}

/* ------------------------------------------------------------------ AdBlue vendors (owner, 16 Nov 2026) */

const vendorKeyOf = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase()
const findVendorByName = (name: string) => readCollection("adblue_vendors").find((v) => vendorKeyOf(v.name) === vendorKeyOf(name))
const vendorName = (id: string | null | undefined) => (id ? (readCollection("adblue_vendors").find((v) => v.id === id)?.name ?? "Unknown vendor") : NO_VENDOR_LABEL)
const OLD_DRAW_LABEL = "No vendor (before vendor tracking)"

/** The vendor master: the Owner, Dev and Employee. The AdBlue profiles pick existing vendors only (no master data). */
function assertVendorAdmin(action: "create" | "edit") {
  assertCan("adblue", action)
  if (!hasOwnerAuthority(currentRole())) throw new PermissionError("Your role can't change the AdBlue vendor list. Ask the Owner to add the vendor.")
}

/** Name unique (spaces / case ignored, archived vendors included); default rate optional, > 0, 4 decimals. */
function checkVendor(input: AdBlueVendorInput, id?: string) {
  const name = input.name.trim().replace(/\s+/g, " ")
  if (!name) throw new Error("Enter the vendor name")
  const rate = input.defaultRate === null || input.defaultRate === undefined || (input.defaultRate as unknown) === "" ? null : Number(input.defaultRate)
  if (rate !== null && !(rate > 0)) throw new Error("The default rate per litre must be greater than 0")
  const dup = readCollection("adblue_vendors").find((v) => v.id !== id && vendorKeyOf(v.name) === vendorKeyOf(name))
  if (dup) throw new Error(`${dup.name} already exists${dup.status === "ARCHIVED" ? " (archived) — restore it instead" : ""}.`)
  return { name, defaultRate: rate === null ? null : Number(rate.toFixed(4)), contactPerson: input.contactPerson?.trim() ?? "", phone: input.phone?.trim() ?? "", notes: input.notes?.trim() ?? "" }
}

async function createVendor(input: AdBlueVendorInput) {
  assertVendorAdmin("create")
  const after = await adblueVendors.create({ ...checkVendor(input), status: "ACTIVE" })
  audit({ action: "CREATED", ...meta.adblueVendor(after), after })
  return after
}

/**
 * The vendor of a purchase or direct purchase: the picked id, or an existing vendor's name; an unknown name creates the
 * vendor when the role may (Owner, Dev, Employee). `required: false` (direct purchases by the AdBlue profiles): an
 * unknown name stays as text only, as before vendor tracking. An archived vendor takes no new purchase.
 */
async function resolveVendor(input: { adblueVendorId?: string | null; vendorName?: string }, keep: string | null | undefined, required = true): Promise<AdBlueVendor | null> {
  let v = input.adblueVendorId ? readCollection("adblue_vendors").find((x) => x.id === input.adblueVendorId) : input.vendorName?.trim() ? findVendorByName(input.vendorName) : undefined
  if (input.adblueVendorId && !v) throw new NotFoundError("AdBlue vendor", input.adblueVendorId)
  if (!v) {
    if (!input.vendorName?.trim()) throw new Error("Choose the vendor")
    if (!required && !hasOwnerAuthority(currentRole())) return null
    v = await createVendor({ name: input.vendorName, defaultRate: null })
  }
  if (v.status === "ARCHIVED" && v.id !== keep) throw new Error(`${v.name} is archived. Restore the vendor to buy from it.`)
  return v
}

/**
 * A stock draw names the vendor whose stock it takes; without one it takes unattributed stock only (opening stock, stock
 * whose vendor is unknown) — assertStock refuses it when that doesn't cover it. A draw recorded before vendor tracking
 * may keep no vendor as it was (`beforeVendorTracking`, never from the request).
 */
function assertDrawVendor(input: AdBlueInput) {
  if (!isDirectAdBlue(input) && input.adblueVendorId && !readCollection("adblue_vendors").some((v) => v.id === input.adblueVendorId)) throw new NotFoundError("AdBlue vendor", input.adblueVendorId)
}

/** A direct purchase's vendor from the master (by id or name); the name is saved as it was then. */
async function directVendor(input: AdBlueInput, before?: AdBlueEntry) {
  const v = await resolveVendor(input, before?.adblueVendorId, false)
  return v ? { adblueVendorId: v.id, vendorName: before?.adblueVendorId === v.id && before.vendorName ? before.vendorName : v.name } : { adblueVendorId: null }
}

/* ------------------------------------------------------------------ Tyre Data (owner, 17 Nov 2026) */

export interface TyreMasterInput {
  kind: TyreMasterKind
  name: string
}
export interface TyreItemInput {
  /** An existing line's id (edit); omitted for a new line. */
  id?: string
  repairTypeId: string
  brandId?: string | null
  sizeId?: string | null
  tyreNumber?: string
  openingKm?: number | null
  closingKm?: number | null
  quantity: number
  rate: number
  gstRate: number
  taxType: TyreTaxType
  removingNumber?: string
  remarks?: string
}
/**
 * The company is never sent: it is the vehicle's customer on the invoice date. `office`: "Office / No Customer", chosen
 * explicitly — allowed only for a vehicle with no customer on that date (never a default, never instead of a customer).
 */
export interface TyreInvoiceInput {
  date: string
  vehicleId: string
  office?: boolean
  supplierId: string
  billNo?: string
  purchaseMode?: string
  paymentMode?: string
  paymentDetails?: string
  remarks?: string
  items: TyreItemInput[]
  /**
   * Add Invoice only: what was paid with the bill. Payment Type (`paymentMode`) Credit or empty = nothing paid, no
   * payment. Any other type needs an amount and a UTR; the payment is saved with the invoice (one transaction) and
   * allocated to it — an amount above the invoice total only when the extra is explicitly advance credit.
   */
  payment?: TyreInitialPaymentInput
}
export interface TyreInitialPaymentInput {
  /** The total settled (with "Deduct TDS?": before TDS). */
  amount: number
  /** "Deduct TDS?": the TDS %; absent / null = off. */
  tdsPercent?: number | null
  utr: string
  date: string
  notes?: string
  acceptAdvance?: boolean
}
/** A payment to a tyre supplier, allocated to its invoices; the rest (explicitly) advance credit. */
export interface TyrePaymentInput {
  date: string
  supplierId: string
  /** The total settled (with "Deduct TDS?": before TDS; the vendor receives the rest). */
  amount: number
  /** "Deduct TDS?": the TDS %; absent / null = off. */
  tdsPercent?: number | null
  mode: string
  utr: string
  reference?: string
  companyCode?: CompanyCode | null
  notes?: string
  allocations: { invoiceId: string; amount: number }[]
  acceptAdvance?: boolean
}

const TYRE_KINDS: TyreMasterKind[] = ["SUPPLIER", "REPAIR_TYPE", "BRAND", "SIZE"]
const tyreMasterName = (id: string | null | undefined) => (id ? (readCollection("tyre_masters").find((m) => m.id === id)?.name ?? "Unknown") : "")

/** Name unique within its list (spaces / case ignored, archived values included). */
function checkTyreMaster(kind: TyreMasterKind, name: string, id?: string) {
  if (!TYRE_KINDS.includes(kind)) throw new Error("Unknown tyre list")
  const clean = cleanName(name ?? "")
  if (!clean) throw new Error(`Enter the ${TYRE_MASTER_LABEL[kind].one.toLowerCase()} name`)
  if (clean.length > 120) throw new Error("The name is too long (120 characters at most)")
  const dup = readCollection("tyre_masters").find((m) => m.kind === kind && m.id !== id && masterKey(m.name) === masterKey(clean))
  if (dup) throw new Error(`${dup.name} already exists${dup.status === "ARCHIVED" ? " (archived) — restore it instead" : ""}.`)
  return clean
}

/** A master value an invoice may use: of the right list, and active — unless the record already used it (`keep`). */
function tyreMasterOk(kind: TyreMasterKind, id: string | null | undefined, keep: (string | null)[], required: boolean) {
  if (!id) {
    if (required) throw new Error(`Choose the ${TYRE_MASTER_LABEL[kind].one.toLowerCase()}`)
    return null
  }
  const m = readCollection("tyre_masters").find((x) => x.id === id && x.kind === kind)
  if (!m) throw new NotFoundError(TYRE_MASTER_LABEL[kind].one, id)
  if (m.status === "ARCHIVED" && !keep.includes(id)) throw new Error(`${m.name} is archived. Restore it to use it again.`)
  return id
}

/**
 * The invoice's company: the vehicle's customer on the invoice date. Never guessed. A vehicle with no customer on that
 * date takes an invoice only when it is explicitly recorded as Office / No Customer; a vehicle with a customer never is.
 */
function tyreAttribution(vehicleId: string, date: string, office: boolean): { customerId: string | null; office: boolean } {
  const v = readCollection("vehicles").find((x) => x.id === vehicleId)
  if (!v) throw new NotFoundError("Vehicle", vehicleId)
  const customerId = assignmentOn(assignmentIndex(periodsOf(vehicleId)), vehicleId, date)?.customerId ?? null
  if (customerId && office) throw new Error(`${v.regNo} is assigned to ${customerName(customerId)} on ${formatDate(date)}, so the invoice belongs to ${customerName(customerId)} — it can't be recorded as ${OFFICE_LABEL}.`)
  if (!customerId && !office)
    throw new Error(`${v.regNo} has no customer assignment on ${formatDate(date)}, so its company can't be set. Assign the vehicle to its customer for that date (Diesel → customer → vehicle ⋮ → Transfer / Edit Assignment), check the invoice date, or record it explicitly as ${OFFICE_LABEL}.`)
  return { customerId, office: !customerId }
}

/** Validated invoice with calculated line amounts. `before`: the invoice being edited (its lines keep their ids). */
function checkTyreInvoice(input: TyreInvoiceInput, before?: TyreInvoice): NewEntity<TyreInvoice> {
  if (!isCalendarDate(input.date ?? "")) throw new Error("Enter the invoice date")
  if (input.date > todayISO()) throw new Error("An invoice can't be dated in the future.")
  const { customerId, office } = tyreAttribution(input.vehicleId, input.date, input.office === true)
  assertOpen(input.vehicleId, customerId, input.date)
  const keep = before ? [before.supplierId, ...before.items.flatMap((i) => [i.repairTypeId, i.brandId, i.sizeId])] : []
  const supplierId = tyreMasterOk("SUPPLIER", input.supplierId, keep, true)!
  if (!input.items?.length) throw new Error("Add at least one repair line")
  const ownIds = new Set(before?.items.map((i) => i.id) ?? [])
  const items = input.items.map((raw, n): TyreInvoiceItem => {
    const km = (x: number | null | undefined) => (x === null || x === undefined || (x as unknown) === "" ? null : Number(x))
    const item = { repairTypeId: raw.repairTypeId, quantity: Number(raw.quantity), rate: Number(raw.rate), gstRate: Number(raw.gstRate), openingKm: km(raw.openingKm), closingKm: km(raw.closingKm) }
    const problem = itemProblem(item)
    if (problem) throw new Error(`Line ${n + 1}: ${problem}`)
    if (raw.taxType !== "CGST_SGST" && raw.taxType !== "IGST") throw new Error(`Line ${n + 1}: choose CGST + SGST or IGST`)
    return {
      id: raw.id && ownIds.has(raw.id) ? raw.id : newId("tyi"),
      repairTypeId: tyreMasterOk("REPAIR_TYPE", raw.repairTypeId, keep, true)!,
      brandId: tyreMasterOk("BRAND", raw.brandId, keep, false),
      sizeId: tyreMasterOk("SIZE", raw.sizeId, keep, false),
      tyreNumber: (raw.tyreNumber ?? "").trim(),
      openingKm: item.openingKm,
      closingKm: item.closingKm,
      quantity: item.quantity,
      rate: item.rate,
      gstRate: item.gstRate,
      taxType: raw.taxType,
      ...lineAmounts(item.quantity, item.rate, item.gstRate, raw.taxType),
      removingNumber: (raw.removingNumber ?? "").trim(),
      remarks: (raw.remarks ?? "").trim(),
    }
  })
  const text = (x: string | undefined) => (x ?? "").trim()
  return { date: input.date, vehicleId: input.vehicleId, customerId, office, supplierId, billNo: text(input.billNo), purchaseMode: text(input.purchaseMode), paymentMode: text(input.paymentMode), paymentDetails: text(input.paymentDetails), remarks: text(input.remarks), items }
}

/* ------------------------------------------------------------------ Tyre vendor payments (owner, 17 Nov 2026) */

const tyreInvoiceLabel = (x: Pick<TyreInvoice, "billNo" | "date">) => `Bill ${x.billNo || "—"} (${formatDate(x.date)})`
/** What each invoice of the supplier still owes (an edited payment's own allocations left out), by id. */
function tyreOutstanding(supplierId: string, exceptPaymentId?: string): Map<string, { invoice: TyreInvoice; left: number }> {
  const paid = paidByInvoice(readCollection("tyre_payments").filter((p) => p.id !== exceptPaymentId))
  return new Map(readCollection("tyre_invoices").filter((x) => x.supplierId === supplierId).map((x) => [x.id, { invoice: x, left: Math.max(0, round2(tyreTotals(x.items).grandTotal - (paid.get(x.id) ?? 0))) }]))
}
/** A reference (UTR, cheque or receipt number) is on one payment only (spaces / case ignored; the database's unique index too). */
function assertUtrFree(utr: string, exceptPaymentId?: string) {
  const dup = readCollection("tyre_payments").find((p) => p.id !== exceptPaymentId && utrKey(p.utr) === utrKey(utr))
  if (dup) throw new Error(`Reference ${utr.trim()} is already recorded — ${tyreMasterName(dup.supplierId)}, ${dup.mode}, ${formatDate(dup.date)}, ${formatINR(settledOf(dup))}. If it was entered twice, keep that payment; otherwise check the number.`)
}
/** The money fields from the total settled and "Deduct TDS?" (null / undefined = off: amount = total, no TDS). */
function tyreTds(total: number, percent: number | null | undefined): Pick<TyrePayment, "amount" | "tdsAmount" | "tdsRate"> {
  if (percent === null || percent === undefined) return { amount: round2(total), tdsAmount: 0, tdsRate: null }
  const problem = tdsProblem(Number(total), Number(percent))
  if (problem) throw new Error(problem)
  const { tds, paid } = tyreTdsSplit(Number(total), Number(percent))
  return { amount: paid, tdsAmount: tds, tdsRate: Number(percent) }
}
const cleanAllocations = (list: { invoiceId: string; amount: number }[] | undefined) => (list ?? []).filter((a) => Number(a.amount) !== 0).map((a) => ({ invoiceId: a.invoiceId, amount: Number(a.amount) }))
/** Allocations per invoice (an applied advance may have added a second allocation to the same invoice). */
const perInvoice = (list: { invoiceId: string; amount: number }[]) => {
  const m = new Map<string, number>()
  for (const a of list) m.set(a.invoiceId, round2((m.get(a.invoiceId) ?? 0) + a.amount))
  return m
}
/**
 * Validated payment ready to store: amount = paid to the vendor, tdsAmount / tdsRate from "Deduct TDS?", allocations to
 * invoices of its supplier, each within what the invoice owes — for an edit (`before`), without its own allocations.
 */
function checkTyrePayment(input: TyrePaymentInput, before?: TyrePayment): NewEntity<TyrePayment> {
  const supplierId = before ? before.supplierId : tyreMasterOk("SUPPLIER", input.supplierId, [], true)!
  if (before && input.supplierId && input.supplierId !== before.supplierId) throw new Error("A payment's vendor can't be changed — delete it and record it again for the right vendor.")
  const owed = tyreOutstanding(supplierId, before?.id)
  const allocations = cleanAllocations(input.allocations)
  const draft = { date: input.date, amount: Number(input.amount), mode: input.mode, utr: input.utr ?? "", allocations, acceptAdvance: input.acceptAdvance === true }
  const problem = paymentProblem(draft, todayISO(), (id) => owed.get(id)?.left, (id) => (owed.has(id) ? tyreInvoiceLabel(owed.get(id)!.invoice) : `Invoice ${id}`))
  if (problem) throw new Error(problem)
  if (input.companyCode && !settingsOrThrow().companies.some((c) => c.code === input.companyCode)) throw new Error("Choose the company that paid")
  assertUtrFree(draft.utr, before?.id)
  return {
    date: draft.date, supplierId, ...tyreTds(draft.amount, input.tdsPercent), mode: draft.mode, utr: draft.utr.trim(), reference: (input.reference ?? "").trim(), companyCode: input.companyCode || null,
    notes: (input.notes ?? "").trim(), allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: round2(a.amount) })),
  }
}
/**
 * Add Invoice's Payment Details → the payment to save with it, or null (Credit / no type: nothing paid, no TDS). The
 * reference (UTR / cheque / receipt number) is required for every type but Credit; more than the invoice total only as
 * explicit advance credit. With "Deduct TDS?" the amount is the total settled and the vendor receives the rest.
 */
function initialTyrePayment(input: TyreInvoiceInput, data: NewEntity<TyreInvoice>): NewEntity<TyrePayment> | null {
  const type = data.paymentMode
  const p = input.payment
  const amount = p ? Number(p.amount) : 0
  if (amount < 0) throw new Error("Amount Paid can't be negative")
  if (!type || type === CREDIT) {
    if (amount > 0) throw new Error("Payment Type is Credit, so nothing is paid now. Choose how it was paid (Cash, UPI, NEFT, RTGS, IMPS or Cheque) to record an amount.")
    if (p && p.tdsPercent !== null && p.tdsPercent !== undefined) throw new Error("TDS is deducted only from a payment — Credit pays nothing now, so there is no TDS to deduct.")
    return null
  }
  if (!(TYRE_PAYMENT_MODES as readonly string[]).includes(type)) throw new Error(`Choose the Payment Type: ${[CREDIT, ...TYRE_PAYMENT_MODES].join(", ")}`)
  if (!p || !(amount > 0)) throw new Error(`Enter the Amount Paid by ${type} — or choose Credit if nothing was paid`)
  if (!(p.utr ?? "").trim()) throw new Error(`Enter the ${referenceNoun(type)} — it is required when the Payment Type is ${type}.`)
  const total = tyreTotals(data.items).grandTotal
  if (amount > total && !p.acceptAdvance) throw new Error(`Amount Paid (${formatINR(amount)}) is more than the invoice total (${formatINR(total)}). Record the extra ${formatINR(round2(amount - total))} as advance credit with the vendor, or correct the amount.`)
  const allocations = total > 0 ? [{ invoiceId: "new", amount: Math.min(round2(amount), total) }] : []
  const problem = paymentProblem({ date: p.date, amount, mode: type, utr: p.utr, allocations, acceptAdvance: p.acceptAdvance === true }, todayISO(), () => total, () => "This invoice")
  if (problem) throw new Error(problem)
  assertUtrFree(p.utr)
  assertMonthEditable(p.date)
  return { date: p.date, supplierId: data.supplierId, ...tyreTds(amount, p.tdsPercent), mode: type, utr: p.utr.trim(), reference: data.billNo, companyCode: null, notes: (p.notes ?? "").trim(), allocations }
}

/** Allocating changes what the invoice owes: its month must be open too (as the payment's). */
function assertAllocationMonths(allocations: { invoiceId: string }[]) {
  for (const a of allocations) assertMonthEditable(readCollection("tyre_invoices").find((x) => x.id === a.invoiceId)!.date)
}

async function setTyreMasterStatus(id: string, status: TyreMaster["status"]) {
  return tx(async () => {
    assertCan("tyres", "edit")
    const before = await tyreMasters.get(id)
    if (!before) throw new NotFoundError("Tyre list value", id)
    if (before.status === status) return before
    const after = await tyreMasters.update(id, { status })
    audit({ action: status === "ARCHIVED" ? "ARCHIVED" : "RESTORED", ...meta.tyreMaster(after), before, after })
    return after
  })
}

/* ------------------------------------------------------------------ Diesel tanker */

/** Every tanker's stock records as stored, with `patch` applied (the would-be state after a change). */
function tankerRecords(patch: Partial<TankerRecords> = {}): TankerRecords {
  return {
    loads: readCollection("tanker_loads"),
    fills: readCollection("diesel_entries"),
    external: readCollection("tanker_dispenses"),
    transfers: readCollection("tanker_transfers"),
    adjustments: readCollection("tanker_adjustments"),
    industrial: readCollection("industrial_supplies"),
    ...patch,
  }
}

/**
 * The tankers a change touches may never go below zero at any point in time (each tanker on its own). Only those
 * tankers are checked — as the database's stock trigger does — so a shortfall in another tanker's history never
 * blocks a valid record. A record without a tanker belongs to the default pool (`tankerOf`).
 */
function assertTankerStock(records: TankerRecords, tankerIds: (string | undefined)[]) {
  const { shortfalls } = valueTankers(records)
  for (const id of new Set(tankerIds.map((t) => tankerOf({ tankerId: t })))) {
    const s = shortfalls.get(id)
    if (s) throw new Error(shortfallMessage(s, tankerName(id)))
  }
}

/** A vehicle fill from a tanker: refused when it exceeds the stock available on its date (`tankerAvailability`, as the dialog shows). */
function assertTankerFill(fill: { id: string; date: string; createdAt: string; tankerId?: string; litres: number }) {
  const tankerId = tankerOf(fill)
  const a = tankerAvailability(tankerRecords(), { ...fill, tankerId })
  if (!fitsTanker(a, fill.litres)) throw new Error(availabilityMessage(a, tankerName(tankerId), fill.date))
}

/** A tanker's own fuel is an ordinary pump fill — never drawn from tanker cargo. */
function assertNotTankerItself(vehicleId: string) {
  const own = readCollection("tankers").find((t) => t.vehicleId === vehicleId)
  if (own) throw new Error(`${own.name}'s own fuel isn't taken from tanker cargo — record it from a fuel station like any other vehicle.`)
}

/** Diesel tankers carry diesel: a petrol or EV vehicle is never filled from one. */
function assertDieselVehicle(v: Vehicle) {
  if (v.fuelType !== "DIESEL") throw new Error(`${v.regNo} doesn't run on diesel, so it can't be filled from a diesel tanker.`)
}

/**
 * Tanker-sourced fills as reports see them (answer 23): amount = litres × the rate recorded on the fill.
 * Only fills saved without a rate (rate 0, older records) are costed at the tanker's weighted average.
 */
function tankerValued(list: DieselEntry[]): DieselEntry[] {
  if (!list.some((e) => isTankerFill(e) && !(e.rate > 0))) return list
  const { costOf } = valueTankers(tankerRecords())
  return list.map((e) => {
    if (!isTankerFill(e) || e.rate > 0) return e
    const amount = fillAmount(e, costOf)
    return { ...e, amount, rate: e.litres ? round2(amount / e.litres) : 0, averageCost: true }
  })
}

/** Name required; registration unique among tankers (spaces / case ignored); capacity sensible. */
function checkTanker(input: TankerInput, id?: string): TankerInput {
  const name = input.name.trim()
  const regNo = normReg(input.regNo)
  if (!name) throw new Error("Enter the tanker name")
  // A record without a registration is a stock pool (isStockPool), never a new tanker; a pool may keep its blank one.
  if (!regNo && (!id || readCollection("tankers").find((t) => t.id === id)?.regNo)) throw new Error("Enter the tanker's registration number")
  const others = readCollection("tankers").filter((t) => t.id !== id)
  if (regNo && others.some((t) => normReg(t.regNo) === regNo)) throw new Error(`A tanker with registration ${regNo} already exists`)
  if (others.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`A tanker named ${name} already exists`)
  if (input.capacityLitres !== null && !(input.capacityLitres > 0)) throw new Error("Capacity must be greater than 0 L (or left blank)")
  if (input.vehicleId && !readCollection("vehicles").some((v) => v.id === input.vehicleId)) throw new Error("Choose a vehicle from the vehicle list")
  if (input.vehicleId && others.some((t) => t.vehicleId === input.vehicleId)) throw new Error("That vehicle is already linked to another tanker")
  return { ...input, name, regNo, notes: input.notes.trim() }
}

async function setTankerStatus(id: string, status: "ACTIVE" | "ARCHIVED") {
  assertCan("vehicles", "edit")
  const before = await tankers.get(id)
  if (!before) throw new NotFoundError("Tanker", id)
  const after = await tankers.update(id, { status })
  audit({ action: statusAction(before, after), ...meta.tanker(after), before, after })
  return after
}

/** `existing` (an edit): a tanker the record already names may since have been archived; a newly chosen one must be open. */
function checkTransfer(input: TankerTransferInput, existing?: TankerTransfer) {
  if (input.fromTankerId === input.toTankerId) throw new Error("Choose two different tankers")
  if (existing?.fromTankerId !== input.fromTankerId) assertTankerOpen(input.fromTankerId, "Choose the tanker the diesel comes out of")
  if (existing?.toTankerId !== input.toTankerId) assertTankerOpen(input.toTankerId, "Choose the tanker the diesel goes into")
  if (!(input.litres > 0)) throw new Error("Litres transferred must be greater than 0")
  if (input.date > todayISO()) throw new Error("A transfer can't be dated in the future.")
  return { ...input, litres: round2(input.litres), notes: input.notes.trim() }
}

function checkAdjustment(input: TankerAdjustmentInput, existing?: TankerAdjustment) {
  const reasonError = deletionReasonError(input.reason, "adjusting stock")
  if (reasonError) throw new Error(reasonError)
  if (existing?.tankerId !== input.tankerId) assertTankerOpen(input.tankerId)
  if (!input.litres) throw new Error("Enter the litres to add (+) or remove (−)")
  if (input.date > todayISO()) throw new Error("An adjustment can't be dated in the future.")
  return { ...input, litres: round2(input.litres), reason: input.reason.trim() }
}

/* ------------------------------------------------------------------ AdBlue inventory */

/**
 * Stock may never go below zero at any point in time. `entries` / `purchases` are the would-be
 * state after a change; throws "Insufficient AdBlue inventory. Available stock: 5L".
 */
function assertStock(purchases: AdBluePurchase[], entries: Pick<AdBlueEntry, "id" | "date" | "createdAt" | "quantityLitres" | "source" | "adblueVendorId" | "beforeVendorTracking">[]) {
  const v = valueInventory(purchases, stockDraws(entries))
  if (v.shortfall) throw new Error(adBlueShortfallMessage(v.shortfall, vendorName))
}

/**
 * Vehicle AdBlue entries with `amount` = FIFO cost from their vendor's batches (direct purchases keep their own
 * litres × rate), and the view fields `sourceVendor` / `costRate` (never stored).
 */
function valued<E extends AdBlueEntry>(list: E[]): E[] {
  const { costOf } = valueInventory(readCollection("adblue_purchases"), stockDraws(readCollection("adblue_entries")))
  return list.map((e) => {
    if (isDirectAdBlue(e)) return { ...e, sourceVendor: e.vendorName ?? "", costRate: e.rate ?? null }
    const amount = costOf.get(e.id) ?? 0
    const source = e.adblueVendorId ? vendorName(e.adblueVendorId) : e.beforeVendorTracking ? OLD_DRAW_LABEL : NO_VENDOR_LABEL
    return { ...e, amount, sourceVendor: source, costRate: e.quantityLitres ? round2(amount / e.quantityLitres) : null }
  })
}

/** A purchase's totals; its vendor (resolved first) gives the batch its vendor and the name it is saved under. */
function purchaseTotals(input: AdBluePurchaseInput, vendor: AdBlueVendor, before?: AdBluePurchase) {
  if (!(input.buckets > 0)) throw new Error("Number of buckets must be greater than 0")
  if (!(input.litresPerBucket > 0)) throw new Error("Litres per bucket must be greater than 0")
  if (!(input.pricePerBucket >= 0)) throw new Error("Price per bucket can't be negative")
  if (input.date > todayISO()) throw new Error("A purchase can't be dated in the future.")
  const gstRate = Number(input.gstRate ?? 0)
  if (!(Number.isFinite(gstRate) && gstRate >= 0 && gstRate <= 100) || (String(gstRate).split(".")[1] ?? "").length > 2) throw new Error("GST %: between 0 and 100, up to 2 decimals")
  const { payment: _payment, ...rest } = input // the payment is its own record (adbluePayments), never stored on the purchase
  void _payment
  return {
    ...rest,
    adblueVendorId: vendor.id,
    vendorName: before?.adblueVendorId === vendor.id ? before.vendorName : vendor.name, // a renamed vendor never rewrites past purchases
    product: input.product.trim(),
    totalLitres: round2(input.buckets * input.litresPerBucket),
    totalCost: round2(input.buckets * input.pricePerBucket),
    gstRate,
  }
}

/* ------------------------------------------------------------------ AdBlue supplier payments (owner, 18 Nov 2026) */

/** The Owner, Dev and Employee manage AdBlue supplier money; the AdBlue profiles never (stock only). */
function assertAdBluePayments(action: "view" | "create" | "edit" | "delete") {
  if (!canManageAdBluePayments(currentRole(), action)) throw new PermissionError(action === "delete" ? "Only the Owner and Dev can delete records — your role can't delete AdBlue supplier payments." : `Your role can't ${action === "view" ? "see" : action === "create" ? "record" : "edit"} AdBlue supplier payments.`)
}
const abPurchaseLabel = (x: Pick<AdBluePurchase, "invoiceNo" | "date">) => `Bill ${x.invoiceNo || "—"} (${formatDate(x.date)})`
/** "Bulk · Bill 12 (02-11-2026)" / "Direct · Bill R-9 (05-11-2026)". */
const abPayableLabel = (x: Pick<Payable, "kind" | "billNo" | "date">) => payableLabel(x, formatDate)
/**
 * What each payable of the vendor still owes — bulk purchases and direct purchases on credit (owner, 18 Nov 2026) —
 * an edited payment's own allocations left out, by id.
 */
function adblueOutstanding(vendorId: string, exceptPaymentId?: string): Map<string, { payable: Payable; left: number }> {
  const paid = paidByPurchase(readCollection("adblue_payments").filter((p) => p.id !== exceptPaymentId))
  return new Map(
    payablesOf(readCollection("adblue_purchases"), readCollection("adblue_entries"))
      .filter((x) => x.vendorId === vendorId)
      .map((x) => [x.id, { payable: x, left: Math.max(0, round2(x.value - (paid.get(x.id) ?? 0))) }])
  )
}
/** An allocation to a direct purchase carries `direct` (stored in entry_id, not purchase_id); the API decides, never the caller. */
const tagAllocation = <A extends { purchaseId: string; amount: number }>(a: A) => {
  const { direct: _d, ...rest } = a as A & { direct?: boolean }
  void _d
  return readCollection("adblue_entries").some((e) => e.id === a.purchaseId) ? { ...rest, direct: true } : rest
}
/** A reference (UTR, cheque or receipt number) is on one AdBlue payment only (spaces / case ignored; the database's unique index too). */
function assertAdBlueRefFree(utr: string, exceptPaymentId?: string) {
  const dup = readCollection("adblue_payments").find((p) => p.id !== exceptPaymentId && refKey(p.utr) === refKey(utr))
  if (dup) throw new Error(`Reference ${utr.trim()} is already recorded — ${vendorName(dup.vendorId)}, ${dup.mode}, ${formatDate(dup.date)}, ${formatINR(abSettled(dup))}. If it was entered twice, keep that payment; otherwise check the number.`)
}
/** The money fields from the total settled and "Deduct TDS?" (null / undefined = off: amount = total, no TDS). */
function adblueTds(total: number, percent: number | null | undefined): Pick<AdBluePayment, "amount" | "tdsAmount" | "tdsRate"> {
  if (percent === null || percent === undefined) return { amount: round2(total), tdsAmount: 0, tdsRate: null }
  const problem = abTdsProblem(Number(total), Number(percent))
  if (problem) throw new Error(problem)
  const { tds, paid } = abTdsSplit(Number(total), Number(percent))
  return { amount: paid, tdsAmount: tds, tdsRate: Number(percent) }
}
const cleanAbAllocations = (list: { purchaseId: string; amount: number }[] | undefined) => (list ?? []).filter((a) => Number(a.amount) !== 0).map((a) => ({ purchaseId: a.purchaseId, amount: Number(a.amount) }))
const abPerPurchase = (list: { purchaseId: string; amount: number }[]) => {
  const m = new Map<string, number>()
  for (const a of list) m.set(a.purchaseId, round2((m.get(a.purchaseId) ?? 0) + a.amount))
  return m
}
/** Allocating changes what a purchase (bulk or direct) owes: its month must be open too (as the payment's). */
function assertAbAllocationMonths(allocations: { purchaseId: string }[]) {
  for (const a of allocations) {
    const x = readCollection("adblue_purchases").find((p) => p.id === a.purchaseId) ?? readCollection("adblue_entries").find((e) => e.id === a.purchaseId)
    if (x) assertMonthEditable(x.date)
  }
}
/**
 * Validated payment ready to store: amount = paid to the vendor, tdsAmount / tdsRate from "Deduct TDS?", allocations to
 * payable purchases of its vendor, each within what the purchase owes — for an edit (`before`), without its own allocations.
 */
function checkAdBluePayment(input: AdBluePaymentInput, before?: AdBluePayment): NewEntity<AdBluePayment> {
  const vendorId = before ? before.vendorId : input.vendorId
  if (!before) {
    const v = readCollection("adblue_vendors").find((x) => x.id === vendorId)
    if (!v) throw new Error("Choose the AdBlue vendor")
  }
  const owed = adblueOutstanding(vendorId, before?.id)
  const allocations = cleanAbAllocations(input.allocations)
  const draft = { date: input.date, amount: Number(input.amount), mode: input.mode, utr: input.utr ?? "", allocations, acceptAdvance: input.acceptAdvance === true }
  const problem = abPaymentProblem(draft, todayISO(), (id) => owed.get(id)?.left, (id) => (owed.has(id) ? abPayableLabel(owed.get(id)!.payable) : `Purchase ${id}`))
  if (problem) throw new Error(problem)
  if (input.companyCode && !settingsOrThrow().companies.some((c) => c.code === input.companyCode)) throw new Error("Choose the company that paid")
  assertAdBlueRefFree(draft.utr, before?.id)
  return {
    date: draft.date, vendorId, ...adblueTds(draft.amount, input.tdsPercent), mode: draft.mode, utr: draft.utr.trim(), companyCode: input.companyCode || null,
    notes: (input.notes ?? "").trim(), allocations: allocations.map((a) => tagAllocation({ purchaseId: a.purchaseId, amount: round2(a.amount) })),
  }
}
/**
 * Purchase Payment Details (Add Bulk Purchase, and Edit Purchase — owner, 18 Nov 2026): the NEW payment to save with the
 * purchase, or null (Credit: nothing paid now — no payment, no TDS). `outstanding` = what the purchase still owes before
 * it (its value on a new purchase; value − Σ existing payments on an edit — existing payments are never touched).
 * Fully Paid settles all of it (more only as explicitly accepted advance credit); Partially Paid settles less than it.
 * The reference is required by mode; TDS as on any payment (the amount entered is the total settled).
 */
function purchasePayment(input: Pick<AdBluePurchaseInput, "date" | "payment">, outstanding: number, vendorId: string, editing: boolean): NewEntity<AdBluePayment> | null {
  const p = input.payment
  const type = p?.type ?? "CREDIT"
  const amount = Number(p?.amount ?? 0)
  if (type === "CREDIT") {
    if (amount !== 0) throw new Error("Payment Type is Credit, so nothing is paid now. Choose Fully Paid or Partially Paid to record an amount.")
    if (p && p.tdsPercent !== null && p.tdsPercent !== undefined) throw new Error("TDS is deducted only from a payment — Credit pays nothing now, so there is no TDS to deduct.")
    return null
  }
  if (type !== "FULL" && type !== "PARTIAL") throw new Error("Choose the Payment Type: Credit, Fully Paid or Partially Paid")
  assertAdBluePayments("create")
  const what = editing ? `the outstanding amount (${formatINR(outstanding)})` : `the purchase value (${formatINR(outstanding)})`
  if (outstanding <= 0) throw new Error("This purchase is already fully paid — there is nothing left to settle. Record advance credit from the vendor's account (Add Payment), or correct a payment in Payments.")
  if (type === "FULL" && amount < outstanding) throw new Error(`Fully Paid settles ${editing ? what : `the whole purchase value (${formatINR(outstanding)})`} — enter that amount, or choose Partially Paid.`)
  if (type === "FULL" && amount > outstanding && !p!.acceptAdvance) throw new Error(`${formatINR(round2(amount - outstanding))} is more than this purchase owes (${formatINR(outstanding)}). Keep the extra as advance credit with the vendor, or correct the amount.`)
  if (type === "PARTIAL" && !(amount > 0 && amount < outstanding)) throw new Error(`Partially Paid: enter an amount more than ₹0 and less than ${what}.`)
  const mode = p!.mode ?? ""
  if (mode === AB_CREDIT || !(ADBLUE_PAYMENT_MODES as readonly string[]).includes(mode)) throw new Error("Choose the Payment Mode (Cash, UPI, NEFT, RTGS, IMPS or Cheque)")
  if (!(p!.utr ?? "").trim()) throw new Error(`Enter the ${abReferenceNoun(mode)} — it is required for a ${mode} payment.`)
  const date = p!.date || todayISO()
  const allocated = Math.min(round2(amount), outstanding)
  const problem = abPaymentProblem({ date, amount, mode, utr: p!.utr ?? "", allocations: [{ purchaseId: "new", amount: allocated }], acceptAdvance: amount > allocated }, todayISO(), () => outstanding, () => "This purchase")
  if (problem) throw new Error(problem)
  if (date < input.date) throw new Error("The payment can't be dated before the purchase it pays.")
  if (p!.companyCode && !settingsOrThrow().companies.some((c) => c.code === p!.companyCode)) throw new Error("Choose the company that paid")
  assertAdBlueRefFree(p!.utr!)
  assertMonthEditable(date)
  return { date, vendorId, ...adblueTds(amount, p!.tdsPercent), mode, utr: p!.utr!.trim(), companyCode: p!.companyCode || null, notes: (p!.notes ?? "").trim(), allocations: [{ purchaseId: "new", amount: allocated }] }
}
/**
 * A direct vendor purchase's Payment Details (owner, 18 Nov 2026): only for a direct purchase on the vendor's account
 * (paymentMode CREDIT, a vendor from the master) — the same rules as a bulk purchase's, for what it still owes
 * (`paid` = Σ existing allocations). Paid-at-purchase direct purchases (Cash / UPI / NEFT / Cheque) take none.
 */
function directPayment(input: AdBlueInput, entry: { source?: string; paymentMode?: string; adblueVendorId?: string | null; amount: number; date: string }, paid: number, editing: boolean) {
  if (entry.source === "DIRECT" && entry.paymentMode === ON_ACCOUNT && !entry.adblueVendorId) throw new Error("Choose the vendor from the AdBlue vendor list — a purchase on credit is owed to a vendor.")
  if (!input.payment || input.payment.type === "CREDIT") return purchasePayment({ date: entry.date, payment: input.payment }, 0, "", false) // validates "Credit = nothing paid"
  if (entry.source !== "DIRECT") throw new Error("Only a direct vendor purchase has payment details — an AdBlue stock draw is never paid for.")
  if (entry.paymentMode !== ON_ACCOUNT) throw new Error("This direct purchase was paid at purchase — it has nothing on the vendor's account to pay.")
  if (!entry.adblueVendorId) throw new Error("Choose the vendor from the AdBlue vendor list — a purchase on credit is owed to a vendor.")
  return purchasePayment({ date: entry.date, payment: input.payment }, Math.max(0, round2(entry.amount - paid)), entry.adblueVendorId, editing)
}

/** The purchase's own fields (what an edit may change in stock / value): a payment-only edit changes none of them. */
const PURCHASE_FIELDS = ["date", "adblueVendorId", "vendorName", "product", "buckets", "litresPerBucket", "pricePerBucket", "totalLitres", "totalCost", "gstRate", "invoiceNo", "notes"] as const

export type TripInput = Omit<
  NewEntity<Trip>,
  "tripNo" | "companyCode" | "distanceKm" | "pricingModel" | "baseAmount" | "extraKmAmount" | "bataAmount" | "revenue" | "invoiceId"
>

function priceTrip(input: TripInput) {
  const customer = readCollection("customers").find((c) => c.id === input.customerId)
  if (!customer) throw new NotFoundError("Customer", input.customerId)
  const distanceKm = Math.max(0, input.endKm - input.startKm)
  const completed = input.status === "COMPLETED"
  const price = calculateTripRevenue(customer.pricing, { distanceKm, route: input.route, tollParking: input.tollParking })
  return {
    companyCode: customer.companyCode,
    distanceKm,
    pricingModel: customer.pricing.model,
    baseAmount: completed ? price.baseAmount : 0,
    extraKmAmount: completed ? price.extraKmAmount : 0,
    bataAmount: completed ? price.bataAmount : 0,
    tollParking: completed ? price.tollParking : 0,
    revenue: completed ? price.revenue : 0,
  }
}

/* ------------------------------------------------------------------ Audit trail */

/**
 * One API write = one storage transaction, run one at a time. The change and its audit event
 * land together or not at all: if anything throws (validation, storage full, the audit write),
 * every key is restored, so there is never a change without its event or an event without its change.
 */
let txChain: Promise<unknown> = Promise.resolve()
function tx<T>(fn: () => Promise<T>): Promise<T> {
  const versions = pendingVersions() // the record versions the user's screen showed (optimistic concurrency)
  const run = txChain.then(() => runInTransaction(() => runWithVersions(versions, fn)))
  txChain = run.catch(() => undefined)
  return run
}

/** Appends an event for a change that just succeeded (always called after the write, inside `tx`). */
function audit(input: AuditInput) {
  const e = buildEvent(input, currentActor(), newId("aud"), new Date().toISOString())
  if (e.action === "UPDATED" && !e.changes.length) return // saved without changing anything
  appendAuditEvent(e)
}

const regNo = (vehicleId: string) => readCollection("vehicles").find((v) => v.id === vehicleId)?.regNo ?? "Unknown vehicle"
const stationName = (id: string) => readCollection("fuel_stations").find((v) => v.id === id)?.name ?? "Unknown station"
const customerName = (id: string | null) => (id ? (readCollection("customers").find((c) => c.id === id)?.shortName ?? "Unknown customer") : "No customer")
const L = formatLitres

/** Module, record type and description of each kind of record, as the Owner reads them. */
const meta = {
  diesel: (e: DieselEntry) => ({ module: "Diesel", recordType: isTankerFill(e) ? "Diesel entry (from tanker)" : "Diesel entry", recordId: e.id, label: `${regNo(e.vehicleId)} · ${formatDate(e.date)} · ${L(e.litres)}`, recordDate: e.date }),
  adblue: (e: AdBlueEntry) => ({ module: "AdBlue", recordType: "AdBlue entry", recordId: e.id, label: `${regNo(e.vehicleId)} · ${formatDate(e.date)} · ${L(e.quantityLitres)}${isDirectAdBlue(e) ? ` · direct from ${e.vendorName}` : e.adblueVendorId ? ` · from ${vendorName(e.adblueVendorId)} stock` : ""}`, recordDate: e.date }),
  adblueVendor: (v: AdBlueVendor) => ({ module: "AdBlue", recordType: "AdBlue vendor", recordId: v.id, label: v.name, recordDate: null }),
  adbluePurchase: (p: AdBluePurchase) => ({ module: "AdBlue", recordType: "AdBlue purchase", recordId: p.id, label: `${p.opening ? "Opening stock" : p.vendorName} · ${formatDate(p.date)} · ${L(p.totalLitres)}${p.opening ? "" : ` · ${formatINR(purchaseValue(p))}${p.invoiceNo ? ` · bill ${p.invoiceNo}` : ""}`}`, recordDate: p.date }),
  adbluePayment: (p: AdBluePayment) => ({ module: "AdBlue", recordType: "AdBlue payment", recordId: p.id, label: `${readCollection("adblue_vendors").find((v) => v.id === p.vendorId)?.name ?? "Unknown vendor"} · ${p.mode} · ref ${p.utr} · ${formatDate(p.date)} · ${formatINR(abSettled(p))}${p.tdsAmount ? ` (${formatINR(p.amount)} paid + ${formatINR(p.tdsAmount)} TDS)` : ""}`, recordDate: p.date }),
  load: (l: TankerLoad) => ({ module: "Diesel Tanker", recordType: "Tanker load", recordId: l.id, label: `${tankerName(tankerOf(l))} · ${l.opening ? "Opening stock" : stationName(l.stationId)} · ${formatDate(l.date)} · ${L(l.litres)} loaded`, recordDate: l.date }),
  dispense: (d: TankerDispense) => ({ module: "Diesel Tanker", recordType: "Tanker dispense (external vehicle)", recordId: d.id, label: `${tankerName(tankerOf(d))} · ${d.vehicleNo} · ${formatDate(d.date)} · ${L(d.litres)}`, recordDate: d.date }),
  tanker: (t: Tanker) => ({ module: "Diesel Tanker", recordType: "Tanker", recordId: t.id, label: t.regNo && !t.name.includes(t.regNo) ? `${t.name} (${t.regNo})` : t.name, recordDate: null }),
  transfer: (t: TankerTransfer) => ({ module: "Diesel Tanker", recordType: "Tanker transfer", recordId: t.id, label: `${tankerName(t.fromTankerId)} → ${tankerName(t.toTankerId)} · ${formatDate(t.date)} · ${L(t.litres)}`, recordDate: t.date }),
  tyrePayment: (p: TyrePayment) => ({ module: "Tyre", recordType: "Tyre payment", recordId: p.id, label: `${tyreMasterName(p.supplierId)} · ${p.mode} · ref ${p.utr} · ${formatDate(p.date)} · ${formatINR(settledOf(p))}${p.tdsAmount ? ` (${formatINR(p.amount)} paid + ${formatINR(p.tdsAmount)} TDS)` : ""}`, recordDate: p.date }),
  tyreInvoice: (x: TyreInvoice) => ({ module: "Tyre", recordType: "Tyre invoice", recordId: x.id, label: `${tyreMasterName(x.supplierId)} · bill ${x.billNo || "—"} · ${regNo(x.vehicleId)} · ${formatDate(x.date)} · ${formatINR(tyreTotals(x.items).grandTotal)}`, recordDate: x.date }),
  expense: (x: Expense) => ({ module: "Expense", recordType: expenseRecordType(x), recordId: x.id, label: [EXPENSE_SECTIONS[x.section].title, x.broker, x.vehicleIds.length ? x.vehicleIds.map(regNo).join(", ") : x.section === "BROKER" ? null : "No vehicle", x.description || x.taxType || x.provider, formatDate(x.date), formatINR(x.entryType === "PAYMENT" ? x.paidAmount : x.amount)].filter(Boolean).join(" · "), recordDate: x.date }),
  importBatch: (b: ExpenseImportBatch) => ({ module: "Expense", recordType: "Import batch", recordId: b.id, label: `Expense import · ${b.sourceLabel}`, recordDate: null }),
  expenseMonth: (l: ExpenseMonthLock) => ({ module: "Expense", recordType: "Expense month", recordId: l.id, label: `${l.section ? EXPENSE_SECTIONS[l.section].title : "Expense"} · ${format(parseISO(`${l.month}-01`), "MMMM yyyy")}`, recordDate: `${l.month}-01` }),
  broker: (b: Broker) => ({ module: "Expense", recordType: "Broker", recordId: b.id, label: b.name, recordDate: null }),
  tyreMaster: (m: TyreMaster) => ({ module: "Tyre", recordType: TYRE_MASTER_LABEL[m.kind].one, recordId: m.id, label: m.name, recordDate: null }),
  industrial: (x: IndustrialSupply) => ({ module: "Diesel", recordType: "Industrial supply", recordId: x.id, label: `${customerName(x.customerId)} · ${formatDate(x.date)} · ${L(x.litres)} @ ${formatINR(x.rate)} · ${x.purpose} · from ${(x.allocations ?? []).map((a) => `${tankerName(a.tankerId)} ${L(a.litres)}`).join(" + ")}`, recordDate: x.date }),
  adjustment: (a: TankerAdjustment) => ({ module: "Diesel Tanker", recordType: "Tanker stock adjustment", recordId: a.id, label: `${tankerName(a.tankerId)} · ${formatDate(a.date)} · ${a.litres > 0 ? "+" : "−"}${L(Math.abs(a.litres))}`, recordDate: a.date }),
  payment: (p: Payment) => {
    const station = !!p.vendorId && isStationPayment(p, p.vendorId)
    return { module: station ? "Fuel Stations" : "Payments", recordType: station ? "Fuel station payment" : p.direction === "IN" ? "Receipt" : "Payment voucher", recordId: p.id, label: `${p.paymentNo} · ${p.partyName} · ${formatINR(p.amount)}`, recordDate: p.date }
  },
  customer: (c: Customer) => ({ module: "Customers", recordType: "Customer", recordId: c.id, label: c.shortName || c.name, recordDate: null }),
  vehicle: (v: Vehicle) => ({ module: "Vehicles", recordType: "Vehicle", recordId: v.id, label: v.regNo, recordDate: null }),
  driver: (d: Driver) => ({ module: "Drivers", recordType: "Driver", recordId: d.id, label: d.name, recordDate: null }),
  station: (s: FuelStation) => ({ module: "Fuel Stations", recordType: "Fuel station", recordId: s.id, label: s.name, recordDate: null }),
  trip: (t: Trip) => ({ module: "Trips", recordType: "Trip", recordId: t.id, label: `${t.tripNo} · ${regNo(t.vehicleId)} · ${formatDate(t.date)}`, recordDate: t.date }),
  invoice: (i: Invoice) => ({ module: "Invoices", recordType: "Invoice", recordId: i.id, label: `${i.invoiceNo} · ${customerName(i.customerId)} · ${formatINR(i.total)}`, recordDate: i.date }),
}

/** Diesel entries as reports see them: tanker fills carry their weighted-average cost, not the stored ₹0. */
const dieselView = (e: DieselEntry | null) => (e ? tankerValued([e])[0] : null)
/** AdBlue entries with their cost from inventory. */
const adblueView = (e: AdBlueEntry | null) => (e ? valued([e])[0] : null)

/** Which collection holds each record type — to tell the audit log whether the record still exists. */
const RECORD_COLLECTION: Record<string, Parameters<typeof readCollection>[0]> = {
  "Diesel entry": "diesel_entries",
  "Diesel entry (from tanker)": "diesel_entries",
  "AdBlue entry": "adblue_entries",
  "AdBlue purchase": "adblue_purchases",
  "AdBlue vendor": "adblue_vendors",
  "AdBlue payment": "adblue_payments",
  "Tanker load": "tanker_loads",
  "Tanker dispense (external vehicle)": "tanker_dispenses",
  Tanker: "tankers",
  "Tanker transfer": "tanker_transfers",
  "Tanker stock adjustment": "tanker_adjustments",
  "Industrial supply": "industrial_supplies",
  "Tyre invoice": "tyre_invoices",
  "Tyre payment": "tyre_payments",
  "Road tax": "expenses",
  Insurance: "expenses",
  Fitness: "expenses",
  Fine: "expenses",
  "Broker charge": "expenses",
  "Broker payment": "expenses",
  "Broker opening balance": "expenses",
  Broker: "brokers",
  "Expense month": "expense_month_locks",
  "Import batch": "expense_import_batches",
  Supplier: "tyre_masters",
  "Repair type": "tyre_masters",
  "Tyre brand": "tyre_masters",
  "Tyre size": "tyre_masters",
  "Fuel station payment": "payments",
  Receipt: "payments",
  "Payment voucher": "payments",
  Customer: "customers",
  Vehicle: "vehicles",
  "Vehicle assignment": "vehicles",
  Driver: "drivers",
  "Fuel station": "fuel_stations",
  Trip: "trips",
  Invoice: "invoices",
}

/** The permission needed to see a module's record history (the central log itself is `audit`: Owner and Dev). */
const MODULE_RESOURCE: Record<string, Resource> = {
  Diesel: "diesel",
  AdBlue: "adblue",
  "Diesel Tanker": "diesel",
  "Fuel Stations": "diesel",
  Payments: "payments",
  Customers: "customers",
  Vehicles: "vehicles",
  Drivers: "settings",
  Trips: "trips",
  Invoices: "invoices",
  Settings: "settings",
  Tyre: "tyres",
  Expense: "expenses", // Dev only while unreleased (permissions.ts UNRELEASED)
}

export interface AuditLogRow extends AuditEvent {
  /** False when the record has since been deleted (its history stays readable here); null when not a stored record (settings, month lock, data reset). */
  recordExists: boolean | null
  /** Deletion events: when and by whom the Owner reviewed it (null = still to review). Other events: null. */
  review: { at: string; actor: AuditEvent["actor"] } | null
  /** Deletion events: the RESTORED event that brought the record back (null = still deleted). */
  restoredBy: AuditEvent | null
  /** Deletion events of a type the audit log can restore (eligibility is checked in full by checkRestore). */
  restorableType: boolean
}

/* ------------------------------------------------------------------ Writes with nested use */

async function updateCustomer(id: string, patch: Partial<NewEntity<Customer>>) {
  assertCan("customers", "edit")
  const current = await customers.get(id)
  if (current && patch.status && patch.status !== current.status) patch = { ...patch, statusHistory: withStatus(current, patch.status, todayISO()) }
  const after = await customers.update(id, patch)
  audit({ action: statusAction(current, after), ...meta.customer(after), before: current, after })
  return after
}

/**
 * POST /api/vehicles/:id/transfer — ends the current assignment the day before `effectiveDate` and starts one with
 * `customerId`, atomically (one `tx`, one audit event). The effective date is the day the vehicle really started working
 * for the new customer: today by default, or back-dated (a reason is then required) when the transfer is entered late.
 * A back-dated transfer is refused when any diesel / AdBlue entry or trip already recorded would move to another
 * customer (`movedRecords` — history never moves silently; the message names the record), and when any month from the
 * effective date to today is locked for the role. The first assignment of a vehicle ("Assigned since") follows the same
 * record check. Effective today, entries dated today follow the new customer (Vehicle Assignment History rule 6).
 */
async function transferVehicle(id: string, customerId: string | null, effectiveDate: string, reason?: string) {
  assertCan("vehicles", "edit")
  ensureSeeded()
  const today = todayISO()
  if (!isCalendarDate(effectiveDate ?? "")) throw new Error("Enter the effective date.")
  if (effectiveDate > today) throw new Error("Effective date can't be in the future.")
  const stored = readCollection("vehicle_assignments").filter((a) => a.vehicleId === id)
  const backdated = stored.length > 0 && effectiveDate < today
  if (backdated) {
    const reasonError = deletionReasonError(reason, "back-dating")
    if (reasonError) throw new Error(reasonError)
  }
  assertMonthsEditable(effectiveDate, today) // a back-dated transfer re-files every day from the effective date
  assertCustomerOpen(customerId, effectiveDate)
  const before = readCollection("vehicles").find((v) => v.id === id)
  const beforePeriods = periodsOf(id)
  const afterPeriods = transferPeriods(beforePeriods, id, customerId, effectiveDate)
  // A back-dated transfer (or a first assignment) never re-files a record already entered: it names the record instead.
  // Effective today keeps the transfer's documented effect — today's entries follow the new customer.
  // Reports resolve entries from the stored assignments only (none yet = the customer stamped on the entry).
  // (A first assignment checks entries only, as since 3 Nov 2026.)
  const records = attributedRecords()
  const moved = backdated ? movedRecords(id, stored, afterPeriods, records) : !stored.length && movedRecords(id, stored, afterPeriods, { ...records, trips: [] })
  if (moved) throw new Error(movedMessage(moved, regNo(id), "effective date"))
  const previous = beforePeriods.at(-1)
  savePeriods(id, afterPeriods)
  const saved = periodsOf(id)
  const after = await vehicles.update(id, { assignedCustomerId: customerId })
  audit({
    action: "TRANSFERRED",
    module: "Vehicles",
    recordType: "Vehicle assignment",
    recordId: id,
    label: `${after.regNo} · ${customerName(before?.assignedCustomerId ?? null)} → ${customerName(customerId)} · from ${formatDate(effectiveDate)}`,
    recordDate: effectiveDate,
    before: { assignedCustomerId: before?.assignedCustomerId ?? null, previousAssignment: previous ?? null, assignmentPeriods: beforePeriods },
    after: { assignedCustomerId: customerId, effectiveDate, previousAssignment: previous ? (saved.at(-2) ?? null) : null, newAssignment: saved.at(-1) ?? null, assignmentPeriods: saved },
    reason: reason?.trim() || undefined,
    note: backdated ? `Back-dated transfer: effective ${formatDate(effectiveDate)}, recorded ${formatDate(today)}.` : undefined,
  })
  return after
}

async function updateVehicle(id: string, input: Partial<NewEntity<Vehicle>>, companyEffective?: string) {
  assertCan("vehicles", "edit")
  // Resolved document alerts and the company history are history the API alone appends (below) — never taken from the caller.
  let patch: Partial<NewEntity<Vehicle>> = { ...input }
  delete patch.documentAlertHistory
  delete patch.companyPeriods
  let current = await vehicles.get(id)
  // A change of company (VT ↔ VTHPL) is dated (owner, 27 Nov 2026): effective today unless given; earlier dates keep
  // the company they had, so a driver's deployment history stays right (src/domain/drivers.ts).
  if (current && patch.companyCode && patch.companyCode !== current.companyCode) {
    if (!COMPANIES.some((c) => c.value === patch.companyCode)) throw new Error("Choose VT or VTHPL")
    patch = { ...patch, companyPeriods: withCompanyChange(current, patch.companyCode, companyEffective ?? todayISO(), todayISO(), () => newId("vcp")) }
    // The current company is the last period's (a change can't take effect before the last recorded one).
    patch.companyCode = patch.companyPeriods!.at(-1)!.companyCode
  }
  if (patch.assignedCustomerId && patch.assignedCustomerId !== current?.assignedCustomerId) assertCustomerOpen(patch.assignedCustomerId, todayISO())
  if (current && patch.status && patch.status !== current.status) patch = { ...patch, statusHistory: withStatus(current, patch.status, todayISO()) }
  // Changing the customer here is a transfer effective today — earlier months keep their customer.
  if (current && patch.assignedCustomerId !== undefined && patch.assignedCustomerId !== current.assignedCustomerId) {
    const { assignedCustomerId, ...rest } = patch
    await transferVehicle(id, assignedCustomerId, todayISO())
    current = await vehicles.get(id) // the transfer has its own event; this one covers the other fields
    patch = rest
  }
  // Changing an expiry date resolves that document's active alert; it is kept, with the old date (owner, 22 Nov 2026).
  const resolved = current ? resolvedByEdit(current, { ...current, ...patch }, todayISO(), new Date().toISOString(), () => newId("vda")) : []
  if (resolved.length) patch = { ...patch, documentAlertHistory: [...(current!.documentAlertHistory ?? []), ...resolved] }
  const after = await vehicles.update(id, patch)
  audit({ action: statusAction(current, after), ...meta.vehicle(after), before: current, after })
  return after
}

async function updateStation(id: string, patch: Partial<NewEntity<FuelStation>>) {
  assertCan("diesel", "edit")
  const before = await fuelStations.get(id)
  const after = await fuelStations.update(id, patch)
  audit({ action: statusAction(before, after), ...meta.station(after), before, after })
  return after
}

async function setVendorStatus(id: string, status: AdBlueVendor["status"]) {
  assertVendorAdmin("edit")
  const before = await adblueVendors.get(id)
  if (!before) throw new NotFoundError("AdBlue vendor", id)
  const after = await adblueVendors.update(id, { status })
  audit({ action: statusAction(before, after), ...meta.adblueVendor(after), before, after })
  return after
}

/* ------------------------------------------------------------------ Expense (Phase 1) */

/**
 * A section the role may not use at all (EMP 1: Insurance — owner, 28 Nov 2026): refused before anything is read or
 * written, whatever the record or the request. The database refuses it too (private.expense_section_ok in RLS).
 */
function assertExpenseSection(section: ExpenseSection) {
  if (!Object.hasOwn(EXPENSE_SECTIONS, section)) throw new Error("Choose the expense section")
  if (!expenseSectionAllowed(currentRole(), section)) throw new PermissionError(`Your role can't work with ${EXPENSE_SECTIONS[section].title} records.`)
}

/** An Expense audit event's section, by its record type; none = not one section's record (an Expense month, an import batch). */
const EXPENSE_EVENT_SECTION: Record<string, ExpenseSection> = {
  "Road tax": "ROAD_TAX", Insurance: "INSURANCE", Fitness: "FITNESS", Fine: "FINE",
  "Broker charge": "BROKER", "Broker payment": "BROKER", "Broker opening balance": "BROKER", Broker: "BROKER",
}

/** A section's month locked after review: that section's records in it are read-only for every role (owner, 25 Nov 2026). */
function assertExpenseMonthOpen(section: ExpenseSection, date: string) {
  const month = date.slice(0, 7)
  if (isMonthLocked(readCollection("expense_month_locks"), section, month))
    throw new Error(`${format(parseISO(`${month}-01`), "MMMM yyyy")} is locked in ${EXPENSE_SECTIONS[section].title} — its records are read-only. Nothing was saved.`)
}

/**
 * Idempotency of every Expense create (Phase 2B, docs/PHASE_2B_IMPLEMENTATION_PLAN.md §5.4): one key per form submission,
 * re-sent on retry. Content compared on everything the API stores from the form (never id / timestamps / customer stamp).
 */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sameExpenseContent = (a: NewEntity<Expense>, b: Expense) => {
  const pick = (x: Partial<Expense>) => JSON.stringify([x.section, x.date, x.vehicleIds, x.companyCode ?? null, x.description, x.amount, x.remarks, x.validFrom, x.validTill, x.taxType, x.provider, x.policyNo, x.paymentMode, x.paymentReference, x.paymentStatus, x.paymentDate, x.driverId ?? null, x.entryType, textKey(x.broker ?? ""), x.billNo ?? "", x.purpose, x.operatingCompany, x.vehicleCount, x.paidAmount])
  return pick(a) === pick(b)
}

/** A broker payment with the same broker (name key), date and amount as another payment — asks for confirmation (§5.4). */
function samePaymentAs(x: Pick<Expense, "section" | "entryType" | "broker" | "date" | "paidAmount">, id?: string) {
  if (x.section !== "BROKER" || x.entryType !== "PAYMENT") return undefined
  return readCollection("expenses").find((e) => e.id !== id && e.section === "BROKER" && e.entryType === "PAYMENT" && textKey(e.broker) === textKey(x.broker) && e.date === x.date && e.paidAmount === x.paidAmount)
}

const expenseRecordType = (x: Pick<Expense, "section" | "entryType">) =>
  x.section !== "BROKER" ? EXPENSE_SECTIONS[x.section].recordType : x.entryType === "PAYMENT" ? "Broker payment" : x.entryType === "BROUGHT_FORWARD" ? "Broker opening balance" : "Broker charge"

/**
 * An expense as stored: trimmed, the fields its section doesn't use cleared, validated (expenseProblems — the form shows
 * the same), every vehicle from the master and open on the date, the customer stamped from the vehicle's assignment.
 */
function checkExpense(input: ExpenseInput, id?: string, brokerList?: Broker[]): NewEntity<Expense> {
  const section = input.section
  if (!Object.hasOwn(EXPENSE_SECTIONS, section)) throw new Error("Choose the expense section")
  const t = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "")
  const broker = section === "BROKER"
  const entryType = broker ? (input.entryType ?? "CHARGE") : null
  if (entryType && !Object.hasOwn(BROKER_ENTRY_LABEL, entryType)) throw new Error("Choose the kind of broker entry")
  // A charge or a payment may name vehicles (a payment: the vehicle it was for, owner 25 Nov 2026); an opening balance none.
  const vehicleIds = Array.isArray(input.vehicleIds) && entryType !== "BROUGHT_FORWARD" ? input.vehicleIds.filter((v) => typeof v === "string" && v) : []
  const paidAmount = broker ? Number(input.paidAmount) : 0
  const paid = section === "FINE" ? input.paymentStatus === "PAID" : paidAmount > 0
  const x: ExpenseInput = {
    section,
    date: t(input.date),
    vehicleIds,
    companyCode: input.companyCode ?? null,
    // Fines and Broker Charges: free text kept as typed — inner spaces and punctuation untouched, only the ends trimmed (owner, 25 Nov 2026).
    description: section === "FINE" || broker ? (typeof input.description === "string" ? input.description.trim() : "") : t(input.description),
    amount: Number(input.amount),
    remarks: typeof input.remarks === "string" ? input.remarks.trim() : "",
    validFrom: hasValidity(section) ? t(input.validFrom) : "",
    validTill: hasValidity(section) ? t(input.validTill) : "",
    taxType: section === "ROAD_TAX" || section === "FINE" ? t(input.taxType) : "",
    provider: section === "INSURANCE" ? t(input.provider) : "",
    policyNo: section === "INSURANCE" ? t(input.policyNo) : "",
    paymentMode: section === "INSURANCE" || broker ? t(input.paymentMode) : "", // Broker: kept as recorded (older entries); the form no longer asks
    paymentReference: section === "INSURANCE" || (section === "FINE" && paid) ? t(input.paymentReference) : "",
    paymentStatus: section === "FINE" ? input.paymentStatus : null,
    paymentDate: (section === "FINE" || broker) && paid ? t(input.paymentDate) : "",
    // Fines: the driver from the driver master (owner, 27 Nov 2026). Broker: the credit entry a payment settles.
    driverId: section === "FINE" && typeof input.driverId === "string" && input.driverId ? input.driverId : null,
    billNo: entryType === "CHARGE" ? t(input.billNo) : "",
    requestId: typeof input.requestId === "string" && input.requestId ? input.requestId : null,
    importBatchId: null, // only the import sets it
    // Road Tax: every save requires the paying company now (expenseProblems), so the entry's company is confirmed.
    ...(section === "ROAD_TAX" ? { companyConfirmed: true } : {}),
    entryType,
    broker: broker ? t(input.broker) : "",
    purpose: entryType === "CHARGE" ? t(input.purpose) : "",
    operatingCompany: broker ? t(input.operatingCompany) : "",
    vehicleCount: broker ? (vehicleIds.length || Number(input.vehicleCount) || 0) : vehicleIds.length,
    paidAmount,
  }
  if (x.companyCode !== null && !settingsOrThrow().companies.some((c) => c.code === x.companyCode)) throw new Error("Choose the company that pays (account payable)")
  if ((x.billNo ?? "").length > 40) throw new Error("A bill number is at most 40 characters.")
  if (x.requestId && !REQUEST_ID.test(x.requestId)) throw new Error("This form's request id is not valid — reopen the form.")
  const problem = Object.values(expenseProblems(x, todayISO()))[0]
  if (problem) throw new Error(problem)
  const prior = id ? readCollection("expenses").find((e) => e.id === id) : undefined
  // Road Tax descriptions: one spelling each (owner, 27 Nov 2026) — a description already used or in the books is saved
  // in that spelling, whatever its case or spacing; a new one becomes available to later entries.
  if (section === "ROAD_TAX") x.description = descriptionOptions(readCollection("expenses"), "ROAD_TAX").find((d) => textKey(d) === textKey(x.description)) ?? x.description
  if (x.driverId) {
    const d = readCollection("drivers").find((r) => r.id === x.driverId)
    if (!d) throw new Error("Choose the driver from the driver list")
    if (d.status === "ARCHIVED" && prior?.driverId !== d.id) throw new Error(`${d.name} is archived — choose an active driver.`)
  }
  if (broker) {
    // The broker comes from the list, saved in the list's own spelling; an older entry may keep the name it already has.
    const listed = (brokerList ?? readCollection("brokers")).find((b) => textKey(b.name) === textKey(x.broker))
    const kept = id ? readCollection("expenses").find((e) => e.id === id)?.broker : undefined
    if (kept !== undefined && textKey(x.broker) === textKey(kept)) x.broker = kept // unchanged: kept exactly as recorded
    else if (listed) x.broker = listed.name
    else throw new Error(`${x.broker} isn't in the broker list — choose a broker, or add it with Add New Broker.`)
  }
  for (const v of vehicleIds) assertOpen(v, null, x.date) // from the vehicle master only — never created here
  if (broker) {
    // One opening balance per broker, dated before every other entry of that broker.
    const mine = readCollection("expenses").filter((e) => e.id !== id && e.section === "BROKER" && textKey(e.broker) === textKey(x.broker))
    const opening = mine.find((e) => e.entryType === "BROUGHT_FORWARD")
    if (entryType === "BROUGHT_FORWARD" && opening) throw new Error(`${x.broker} already has an opening balance (${formatDate(opening.date)}, ${formatINR(opening.amount)}). Edit that one instead.`)
    if (entryType === "BROUGHT_FORWARD" && mine.some((e) => e.date < x.date)) throw new Error(`${x.broker} has entries dated before ${formatDate(x.date)} — an opening balance must come before every other entry.`)
    if (entryType !== "BROUGHT_FORWARD" && opening && x.date < opening.date) throw new Error(`${x.broker}'s opening balance is dated ${formatDate(opening.date)}; an entry can't be dated before it.`)
    // Each bill stays identifiable: one bill number once per broker (case and spaces ignored).
    const same = x.billNo ? mine.find((e) => e.entryType === "CHARGE" && e.billNo && textKey(e.billNo) === textKey(x.billNo!)) : undefined
    if (same) throw new Error(`Bill ${same.billNo} of ${x.broker} is already recorded (${formatDate(same.date)}, ${formatINR(same.amount)}).`)
  }
  const customerId = !broker && vehicleIds[0] ? (assignmentOn(assignmentIndex(periodsOf(vehicleIds[0])), vehicleIds[0], x.date)?.customerId ?? null) : null
  return { ...x, customerId }
}

/**
 * Broker Charges (owner, 27 Nov 2026): a broker is never paid more than has been billed — at any date. Checked on the
 * broker's entries as they would be after the change (a new or back-dated payment, a bill made smaller or deleted).
 */
function assertBrokerLedger(next: Expense[], brokers: string[], changed: Expense["entryType"]) {
  for (const b of [...new Set(brokers.filter(Boolean))]) {
    const over = firstOverpayment(entriesOf(next, b))
    if (!over) continue
    if (changed === "PAYMENT")
      throw new Error(`${b} had ${formatINR(Math.max(0, round2(over.balance + over.entry.paidAmount)))} outstanding on ${formatDate(over.entry.date)} — a payment can't be more than that.`)
    throw new Error(`This would leave ${b} paid ${formatINR(-over.balance)} more than billed on ${formatDate(over.entry.date)}. Nothing was saved.`)
  }
}

/* ------------------------------------------------------------------ Expense import from a browser backup (Phase 2B, §7) */

type ImportCollection = "expenses" | "brokers" | "expense_month_locks"
interface ImportItemPlan { sourceCollection: ImportCollection; sourceId: string; outcome: ExpenseImportItem["outcome"]; targetId: string | null; reason: string }
export interface ExpenseImportPlan {
  fingerprint: string
  label: string
  exportedAt: string | null
  /** The file was applied before (batch id) — nothing can be imported from it again. */
  appliedAs: string | null
  items: ImportItemPlan[]
  /** Problems that stop the apply altogether (e.g. a broker would be overpaid). */
  blocking: string[]
  /** Customer Company recomputed from the central assignment history, where it differs from the browser's stamp. */
  customerDifferences: { id: string; browser: string | null; central: string | null }[]
  /** Central vs file master data (information only — never written). */
  drift: { driversChanged: string[]; driversMissing: string[]; vehiclesMissing: string[] }
  /** Per section × month: file / to import / skipped / rejected — records, Σ amount, Σ paid. */
  perMonth: { section: string; month: string; file: number; toImport: number; skipped: number; rejected: number; amount: number; paid: number }[]
  /** Broker outstanding after the import (central + imported), per broker. */
  brokerOutstanding: { broker: string; before: number; after: number }[]
  counts: Record<ImportCollection, Record<ImportItemPlan["outcome"], number>>
}

/** Canonical JSON (keys sorted, records sorted by id) — the same bytes in the browser and on the server. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  return JSON.stringify(v ?? null)
}
async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
const importSource = (file: BackupFile) => {
  const byId = <T extends { id: string }>(xs: T[] | undefined) => [...(xs ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))
  return { expenses: byId(file.collections.expenses), brokers: byId(file.collections.brokers), expense_month_locks: byId(file.collections.expense_month_locks) }
}

/**
 * The dry run (writes nothing): classifies every record of the file's three Expense collections against the shared
 * database — new / already present / conflict / rejected / skipped — and reports the result. Records are compared and
 * imported **as they are** (id, createdAt, updatedAt, date); only the customer stamp is recomputed (D-12) and the broker
 * link follows the broker name. Drivers, vehicles, customers and assignments in the file are never written.
 */
async function planExpenseImport(raw: unknown, label: string): Promise<ExpenseImportPlan & { _source: ReturnType<typeof importSource>; _brokers: Broker[] }> {
  if (currentRole() !== "DEV") throw new PermissionError("Only Dev can import Expense data.")
  if (!requestScope()) throw new Error("The import runs on the shared database only (sign in to the shared ERP as Dev).")
  if (typeof label !== "string" || !label.trim()) throw new Error("Name the source of the file (e.g. “Office Mac — Chrome”).")
  const file = parseBackup(raw)
  const src = importSource(file)
  const fingerprint = await sha256(canonical(src))
  const applied = readCollection("expense_import_batches").find((b) => b.sourceFingerprint === fingerprint)
  const central = readCollection("expenses")
  const centralBrokers = readCollection("brokers")
  const centralLocks = readCollection("expense_month_locks")
  const vehicleIds = new Set(readCollection("vehicles").map((v) => v.id))
  const drivers = new Map(readCollection("drivers").map((d) => [d.id, d]))
  const deletedIds = new Set(readAuditEvents().filter((e) => e.action === "DELETED" && e.module === "Expense").map((e) => e.recordId))
  const items: ImportItemPlan[] = []
  const add = (c: ImportCollection, id: string, outcome: ImportItemPlan["outcome"], reason = "", targetId: string | null = null) => items.push({ sourceCollection: c, sourceId: id, outcome, targetId: targetId ?? (outcome === "IMPORTED" ? id : null), reason })

  // Brokers: a central broker with the same name (spaces / case ignored) is the same broker; else new with its own id.
  const brokerList = [...centralBrokers]
  for (const b of src.brokers) {
    const byName = centralBrokers.find((c) => textKey(c.name) === textKey(b.name))
    const byId = centralBrokers.find((c) => c.id === b.id)
    if (byName) add("brokers", b.id, byName.id === b.id ? "ALREADY_PRESENT" : "SKIPPED", byName.id === b.id ? "" : `Same broker as “${byName.name}” already on the shared database`, byName.id)
    else if (byId) add("brokers", b.id, "CONFLICT", `Broker id already used for “${byId.name}”`)
    else {
      add("brokers", b.id, "IMPORTED")
      brokerList.push(b)
    }
  }

  // Entries.
  const customerDifferences: ExpenseImportPlan["customerDifferences"] = []
  const accepted: Expense[] = []
  const lockedCentrally = (x: Expense) => isMonthLocked(centralLocks, x.section, monthOf(x))
  for (const x of src.expenses) {
    const same = central.find((c) => c.id === x.id)
    if (same) {
      // Same id: identical content and the same creation instant (the database returns +00:00 text where the browser wrote Z).
      const identical = sameExpenseContent(x, same) && Date.parse(same.createdAt) === Date.parse(x.createdAt)
      add("expenses", x.id, identical ? "ALREADY_PRESENT" : "CONFLICT", identical ? "" : "Same id, different content on the shared database — not overwritten")
      continue
    }
    const reject = (reason: string) => add("expenses", x.id, "REJECTED", reason)
    if (deletedIds.has(x.id)) { reject("This record was deleted on the shared database"); continue }
    const missing = x.vehicleIds.filter((v) => !vehicleIds.has(v))
    if (missing.length) { reject(`Vehicle not on the shared database: ${missing.join(", ")}`); continue }
    if (x.driverId && !drivers.has(x.driverId)) { reject(`Driver not on the shared database: ${x.driverId}`); continue }
    if (lockedCentrally(x)) { reject(`${format(parseISO(`${monthOf(x)}-01`), "MMMM yyyy")} is locked in ${EXPENSE_SECTIONS[x.section].title} on the shared database`); continue }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(x.createdAt) || !/^\d{4}-\d{2}-\d{2}T/.test(x.updatedAt)) { reject("Missing or invalid createdAt / updatedAt"); continue }
    const money = [x.amount, x.paidAmount].every((n) => Number.isFinite(n) && round2(n) === n)
    if (!money) { reject("An amount has more than two decimals"); continue }
    let checked: NewEntity<Expense>
    try {
      checked = checkExpense({ ...x, requestId: null } as ExpenseInput, x.id, brokerList)
    } catch (e) {
      if (e instanceof NeedData) throw e // loading data on demand (shared backend), not a rejection
      reject(e instanceof Error ? e.message : String(e))
      continue
    }
    if (checked.customerId !== x.customerId) customerDifferences.push({ id: x.id, browser: x.customerId, central: checked.customerId })
    accepted.push({ ...x, customerId: checked.customerId, requestId: null, importBatchId: null })
    add("expenses", x.id, "IMPORTED")
  }
  // Rules across the file and the shared database together: bill numbers, one opening per broker, the ledger.
  const blocking: string[] = []
  const all = [...central, ...accepted]
  for (const x of accepted.filter((a) => a.section === "BROKER")) {
    const mine = all.filter((e) => e.id !== x.id && e.section === "BROKER" && textKey(e.broker) === textKey(x.broker))
    if (x.entryType === "CHARGE" && x.billNo && mine.some((e) => e.entryType === "CHARGE" && e.billNo && textKey(e.billNo) === textKey(x.billNo!))) blocking.push(`Bill ${x.billNo} of ${x.broker} would be recorded twice`)
    if (x.entryType === "BROUGHT_FORWARD" && mine.some((e) => e.entryType === "BROUGHT_FORWARD")) blocking.push(`${x.broker} would have two opening balances`)
  }
  const brokerNames = [...new Set(all.filter((e) => e.section === "BROKER").map((e) => textKey(e.broker)))]
  for (const k of brokerNames) {
    const over = firstOverpayment(all.filter((e) => e.section === "BROKER" && textKey(e.broker) === k))
    if (over) blocking.push(`${over.entry.broker || "A broker"} would be paid ${formatINR(-over.balance)} more than billed on ${formatDate(over.entry.date)}`)
  }

  // Locks: imported after their month's records; one already locked centrally is skipped.
  const today = todayISO().slice(0, 7)
  for (const l of src.expense_month_locks) {
    const section = l.section
    if (!section || !Object.hasOwn(EXPENSE_SECTIONS, section)) add("expense_month_locks", l.id, "REJECTED", "A lock without a section")
    else if (centralLocks.some((c) => c.section === section && c.month === l.month)) add("expense_month_locks", l.id, "SKIPPED", "Already locked on the shared database")
    else if (l.month > today) add("expense_month_locks", l.id, "REJECTED", "A month that hasn't started")
    else add("expense_month_locks", l.id, "IMPORTED")
  }

  // Report.
  const outcomeOf = new Map(items.filter((i) => i.sourceCollection === "expenses").map((i) => [i.sourceId, i.outcome]))
  const perMonthMap = new Map<string, ExpenseImportPlan["perMonth"][number]>()
  for (const x of src.expenses) {
    const key = `${x.section}|${monthOf(x)}`
    const r = perMonthMap.get(key) ?? { section: x.section, month: monthOf(x), file: 0, toImport: 0, skipped: 0, rejected: 0, amount: 0, paid: 0 }
    const o = outcomeOf.get(x.id)
    r.file++
    if (o === "IMPORTED") { r.toImport++; r.amount = round2(r.amount + x.amount); r.paid = round2(r.paid + x.paidAmount) }
    else if (o === "ALREADY_PRESENT" || o === "SKIPPED") r.skipped++
    else r.rejected++
    perMonthMap.set(key, r)
  }
  const outstandingRows = brokerNames.map((k) => {
    const name = all.find((e) => e.section === "BROKER" && textKey(e.broker) === k)!.broker || "No broker named"
    return { broker: name, before: brokerOutstanding(central, name), after: brokerOutstanding(all, name) }
  })
  const fileDrivers = file.collections.drivers ?? []
  const counts = Object.fromEntries((["expenses", "brokers", "expense_month_locks"] as ImportCollection[]).map((c) => [c, Object.fromEntries((["IMPORTED", "ALREADY_PRESENT", "CONFLICT", "REJECTED", "SKIPPED"] as const).map((o) => [o, items.filter((i) => i.sourceCollection === c && i.outcome === o).length]))])) as ExpenseImportPlan["counts"]
  return {
    fingerprint, label: label.trim(), exportedAt: file.exportedAt || null, appliedAs: applied?.id ?? null, items, blocking: [...new Set(blocking)], customerDifferences,
    drift: {
      driversChanged: fileDrivers.filter((d) => drivers.has(d.id) && (drivers.get(d.id)!.name !== d.name || (drivers.get(d.id)!.licenseNo ?? "") !== (d.licenseNo ?? ""))).map((d) => d.id),
      driversMissing: fileDrivers.filter((d) => !drivers.has(d.id)).map((d) => d.id),
      vehiclesMissing: (file.collections.vehicles ?? []).filter((v) => !vehicleIds.has(v.id)).map((v) => v.id),
    },
    perMonth: [...perMonthMap.values()].sort((a, b) => a.section.localeCompare(b.section) || a.month.localeCompare(b.month)),
    brokerOutstanding: outstandingRows, counts, _source: src, _brokers: brokerList,
  }
}
const publicPlan = (p: Awaited<ReturnType<typeof planExpenseImport>>): ExpenseImportPlan => {
  const { _source, _brokers, ...rest } = p
  void _source
  void _brokers
  return rest
}

export interface ExpenseRollbackReport {
  batchId: string
  label: string
  /** Imported by the batch (entries, brokers, locks). */
  total: { entries: number; brokers: number; locks: number }
  eligible: string[]
  retainedLocked: string[]
  retainedChanged: string[]
  retainedLedger: string[]
  alreadyGone: string[]
  /** Apply only. */
  deleted: string[]
  /** Imported entries still present after this run (incl. the retained ones). */
  remaining: number
  status: string
}

/** Classifies the entries a batch imported (§7.6); `apply` deletes the eligible ones. Never touches locked months. */
function planRollback(batchId: string): ExpenseRollbackReport & { _byId: Map<string, Expense> } {
  if (currentRole() !== "DEV") throw new PermissionError("Only Dev can roll back an import.")
  if (!requestScope()) throw new Error("Import rollback runs on the shared database only.")
  const batch = readCollection("expense_import_batches").find((b) => b.id === batchId)
  if (!batch) throw new NotFoundError("Import batch", batchId)
  const importedIds = batch.items.filter((i) => i.sourceCollection === "expenses" && i.outcome === "IMPORTED").map((i) => i.targetId ?? i.sourceId)
  const snapshot = new Map(((batch.sourceSnapshot.expenses ?? []) as Expense[]).map((x) => [x.id, x]))
  const current = readCollection("expenses")
  const byId = new Map(current.map((x) => [x.id, x]))
  const locks = readCollection("expense_month_locks")
  const eligible: string[] = [], retainedLocked: string[] = [], retainedChanged: string[] = [], retainedLedger: string[] = [], alreadyGone: string[] = []
  for (const id of importedIds) {
    const x = byId.get(id)
    if (!x) alreadyGone.push(id)
    else if (isMonthLocked(locks, x.section, monthOf(x))) retainedLocked.push(id)
    else if (snapshot.get(id) && Date.parse(snapshot.get(id)!.updatedAt) !== Date.parse(x.updatedAt)) retainedChanged.push(id)
    else eligible.push(id)
  }
  // Broker ledger: if removing a broker's eligible entries would leave it overpaid, its bills / openings stay (payments
  // can always go — removing a payment never overpays).
  const remove = new Set(eligible)
  for (const k of [...new Set(eligible.map((id) => byId.get(id)!).filter((x) => x.section === "BROKER").map((x) => textKey(x.broker)))]) {
    const left = current.filter((e) => e.section === "BROKER" && textKey(e.broker) === k && !remove.has(e.id))
    if (firstOverpayment(left))
      for (const x of current.filter((e) => remove.has(e.id) && e.section === "BROKER" && textKey(e.broker) === k && e.entryType !== "PAYMENT")) {
        remove.delete(x.id)
        retainedLedger.push(x.id)
      }
  }
  const finalEligible = eligible.filter((id) => remove.has(id))
  const brokersImported = batch.items.filter((i) => i.sourceCollection === "brokers" && i.outcome === "IMPORTED").length
  const locksImported = batch.items.filter((i) => i.sourceCollection === "expense_month_locks" && i.outcome === "IMPORTED").length
  const remainingAfter = importedIds.length - alreadyGone.length - finalEligible.length
  return {
    batchId, label: batch.sourceLabel, total: { entries: importedIds.length, brokers: brokersImported, locks: locksImported },
    eligible: finalEligible, retainedLocked, retainedChanged, retainedLedger, alreadyGone, deleted: [], remaining: remainingAfter,
    status: rollbackStatus(importedIds.length, remainingAfter, retainedLocked.length, retainedChanged.length, retainedLedger.length),
    _byId: byId,
  }
}
/** COMPLETE only when no imported entry remains; otherwise PARTIAL with the reasons — never overstated (§7.6). */
function rollbackStatus(total: number, remaining: number, locked: number, changed: number, ledger: number) {
  if (remaining === 0) return "COMPLETE — no imported entry remains (brokers and locks imported by the batch are kept)"
  return `PARTIAL — ${remaining} of ${total} imported entries remain (${locked} in locked section-months, ${changed} changed after import, ${ledger} kept for the broker ledger)`
}
const publicRollback = (r: ReturnType<typeof planRollback>): ExpenseRollbackReport => {
  const { _byId, ...rest } = r
  void _byId
  return rest
}

/** A DL number as stored (cleanLicenceNo); refused when another driver already has it — one licence, one person. */
function licenceOf(no: string, driverId: string | null) {
  const clean = cleanLicenceNo(no)
  if (clean.length > 30) throw new Error("A DL number is at most 30 characters.")
  const other = clean && readCollection("drivers").find((d) => d.id !== driverId && cleanLicenceNo(d.licenseNo ?? "") === clean)
  if (other) throw new Error(`DL number ${clean} is already recorded for ${other.name}.`)
  return clean
}

/**
 * A driver's details as stored (Operations → Drivers, owner 27 Nov 2026): name required; father's name, address and
 * phone trimmed; dates real calendar dates or "" (date of birth never in the future); DL number unique (licenceOf).
 * The company isn't entered: it follows from the vehicles driven (an older driver keeps what was recorded).
 */
function checkDriverFields<T extends Partial<NewEntity<Driver>>>(input: T, id: string | null): T {
  const out = { ...input }
  if (out.name !== undefined) {
    out.name = out.name.trim().replace(/\s+/g, " ")
    if (!out.name) throw new Error("Enter the driver's name")
    if (out.name.length > 120) throw new Error("A driver's name is at most 120 characters.")
  }
  for (const k of ["fatherName", "address", "phone"] as const) if (out[k] !== undefined) out[k] = (out[k] ?? "").trim()
  if (out.phone && !/^[0-9+\-\s()]{6,20}$/.test(out.phone)) throw new Error("Enter a valid phone number")
  const realDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d
  for (const [k, label] of [["dateOfBirth", "date of birth"], ["licenseValidTill", "DL expiry date"]] as const)
    if (out[k] !== undefined && out[k] !== "" && !realDate(out[k] as string)) throw new Error(`Enter a valid ${label}`)
  if (out.dateOfBirth && out.dateOfBirth > todayISO()) throw new Error("The date of birth can't be in the future.")
  if (out.licenseNo !== undefined) out.licenseNo = licenceOf(out.licenseNo, id)
  if (out.companyCode !== undefined && out.companyCode !== null && !COMPANIES.some((c) => c.value === out.companyCode)) throw new Error("Choose VT or VTHPL")
  return out
}

async function updateDriver(id: string, patch: Partial<NewEntity<Driver>>) {
  assertDriverAccess()
  patch = checkDriverFields(patch, id)
  const before = await drivers.get(id)
  if (!before) throw new NotFoundError("Driver", id)
  const after = await drivers.update(id, patch)
  audit({ action: statusAction(before, after), ...meta.driver(after), before, after })
  return after
}

/** POST /api/payments — validates allocations against outstanding. */
async function createPayment(input: Omit<NewEntity<Payment>, "paymentNo">) {
  assertCan("payments", "create")
  ensureSeeded()
  assertMonthEditable(input.date)
  assertStationPaymentDate(input)
  if (input.amount <= 0 && input.tdsAmount <= 0) throw new Error("Amount must be greater than zero")
  if (input.direction === "IN" && input.allocations.length) {
    const settled = settlementIndex(readCollection("payments"))
    const invs = readCollection("invoices")
    for (const a of input.allocations) {
      const inv = invs.find((i) => i.id === a.invoiceId)
      if (!inv || inv.status !== "ISSUED") throw new Error("Can only allocate to issued invoices")
      const open = round2(inv.total - (settled.get(inv.id) ?? 0))
      if (a.amount > open + 0.5) throw new Error(`Allocation exceeds outstanding on ${inv.invoiceNo}`)
    }
    const allocated = round2(input.allocations.reduce((s, a) => s + a.amount, 0))
    if (allocated > round2(input.amount + input.tdsAmount) + 0.5) throw new Error("Allocated more than amount received + TDS")
  }
  const kind = input.direction === "IN" ? "RCT" : "PAY"
  const prefix = `${companyPrefix(input.companyCode)}-${kind}-${fyLabel(input.date).replace("-", "")}-`
  const seq = nextSeq(readCollection("payments").map((p) => p.paymentNo), prefix)
  const after = await payments.create({ ...input, paymentNo: `${prefix}${String(seq).padStart(4, "0")}` })
  audit({ action: "PAYMENT_RECORDED", ...meta.payment(after), after })
  return after
}

async function removePayment(id: string, reason: string) {
  assertCan("payments", "delete")
  assertReason(reason)
  const p = await payments.get(id)
  if (!p) return
  assertMonthEditable(p.date)
  assertStationPaymentDate(p)
  await payments.remove(id)
  audit({ action: "DELETED", ...meta.payment(p), before: p, reason })
}

/* ------------------------------------------------------------------ Restore a deleted record */

/** Record types a DELETED event can be restored for (masters and invoices are never deleted — archive / cancel). */
const RESTORABLE: Record<string, "diesel_entries" | "adblue_entries" | "adblue_purchases" | "tanker_loads" | "tanker_dispenses" | "tanker_transfers" | "tanker_adjustments" | "industrial_supplies" | "tyre_invoices" | "payments" | "trips"> = {
  "Diesel entry": "diesel_entries",
  "Diesel entry (from tanker)": "diesel_entries",
  "AdBlue entry": "adblue_entries",
  "AdBlue purchase": "adblue_purchases",
  "Tanker load": "tanker_loads",
  "Tanker dispense (external vehicle)": "tanker_dispenses",
  "Tanker transfer": "tanker_transfers",
  "Tanker stock adjustment": "tanker_adjustments",
  "Fuel station payment": "payments",
  Receipt: "payments",
  "Payment voucher": "payments",
  Trip: "trips",
  "Industrial supply": "industrial_supplies",
  "Tyre invoice": "tyre_invoices",
}

/** Thrown when restoring might double-count: another record looks like the same transaction. */
export class PossibleDuplicateError extends Error {
  constructor(readonly duplicate: { id: string; label: string }) {
    super(`A similar record already exists (${duplicate.label}) — it may have been re-entered after the deletion. Delete it first, or confirm it's a different transaction.`)
  }
}

export interface RestorePlan {
  key: (typeof RESTORABLE)[string]
  record: Record<string, unknown>
  /** What restoring changes elsewhere (totals, ledgers, stock). */
  note: string
  duplicate: { id: string; label: string } | null
}

/**
 * The audit events this role may see (Phase 2B, C-8, §6.2): Expense events only for roles holding `expenses` (Dev) —
 * never their snapshots, amounts or labels for the Owner or Employee; every other module unchanged. Used by every audit
 * read below (list, search, detail, history, Edited badges, deletion badge and reviews, restore). On the shared
 * database the read policy has already removed them; this keeps the browser backend the same and is a second barrier.
 */
function visibleEvents() {
  const role = currentRole()
  const seesExpense = can(role, "expenses")
  // A role limited to some Expense sections (EMP 1, owner 28 Nov 2026) sees only those sections' events — never an
  // Insurance record, an Expense month lock or an import batch (its summary covers every section). = expense_event_ok.
  const sectionOf = (e: AuditEvent) => EXPENSE_EVENT_SECTION[e.recordType] as ExpenseSection | undefined
  const limited = hasHiddenExpenseSections(role)
  return readAuditEvents().filter((e) => e.module !== "Expense" || (seesExpense && (!limited || (!!sectionOf(e) && expenseSectionAllowed(role, sectionOf(e)!)))))
}

/**
 * Everything a restore must pass, without writing anything. Uses the DELETED event's snapshot, the
 * original id and createdAt, and the same rules as creating the record: month lock (and no future-dated station payment),
 * archived vehicle or customer on that date, stock never negative, odometer order, voucher / trip
 * numbers still free, receipt allocations still open. Throws the reason it can't be restored.
 */
function planRestore(eventId: string): RestorePlan {
  ensureSeeded()
  if (!hasOwnerAuthority(currentRole())) throw new Error("Only the Owner or Dev can restore deleted records.")
  const events = visibleEvents()
  const e = events.find((x) => x.id === eventId)
  if (!e) throw new NotFoundError("Audit event", eventId)
  if (e.action !== "DELETED") throw new Error("Only deletion events can be restored.")
  const lastReset = events.findLastIndex((x) => x.action === "DATA_RESET")
  if (events.indexOf(e) < lastReset) throw new Error(`Deleted before the data was reset on ${formatDate(events[lastReset].at.slice(0, 10))} — the record belongs to the old data and can't be restored into the current data.`)
  const done = restorations(events).get(e.id)
  if (done) throw new Error(`Already restored on ${formatDate(done.at.slice(0, 10))} — a deletion can be restored only once.`)
  const key = RESTORABLE[e.recordType]
  if (!key) throw new Error(`${e.recordType} records can't be restored from the audit log.`)
  if (!e.before || e.before.id !== e.recordId || typeof e.before.date !== "string") throw new Error("This deletion has no complete snapshot to restore from.")
  if (readCollection(key).some((r) => r.id === e.recordId)) throw new Error("A record with this ID already exists, so there is nothing to restore.")
  const r = { ...e.before } as Record<string, unknown> & { id: string; date: string }
  const vehicleOk = (id: unknown) => {
    if (!readCollection("vehicles").some((v) => v.id === id)) throw new Error("Its vehicle no longer exists, so it can't be restored.")
  }
  const similar = <T extends { id: string }>(list: T[], same: (x: T) => boolean, label: (x: T) => string) => {
    const hit = list.find((x) => x.id !== r.id && same(x))
    return hit ? { id: hit.id, label: label(hit) } : null
  }
  assertMonthEditable(r.date)
  switch (key) {
    case "diesel_entries": {
      const d = r as unknown as DieselEntry
      vehicleOk(d.vehicleId)
      if (!readCollection("fuel_stations").some((s) => s.id === d.vendorId)) throw new Error("Its fuel station no longer exists, so it can't be restored.")
      assertOpen(d.vehicleId, d.customerId, d.date)
      // Stored exactly as when it was created: amount = litres × the recorded rate; a tanker fill saved without a
      // rate (its snapshot shows the average cost, `averageCost`) goes back rate-less and is costed on read.
      if (d.averageCost) Object.assign(r, { rate: 0 })
      delete r.averageCost
      r.amount = round2(d.litres * (r.rate as number))
      if (isTankerFill(d)) {
        Object.assign(r, { paymentMode: "CREDIT", tankerId: tankerOf(d) })
        if (!readCollection("tankers").some((t) => t.id === tankerOf(d))) throw new Error("Its tanker no longer exists, so it can't be restored.")
        assertTankerStock(tankerRecords({ fills: [...readCollection("diesel_entries"), r as unknown as DieselEntry] }), [tankerOf(d)])
      }
      const amount = d.averageCost ? (e.before.amount as number) : (r.amount as number)
      return {
        key,
        record: r,
        note: isTankerFill(d)
          ? `Draws ${L(d.litres)} from ${tankerName(tankerOf(d))} again (${formatINR(amount)}) and adds it back to ${regNo(d.vehicleId)}'s diesel figures.`
          : `Adds ${formatINR(amount)} back to ${regNo(d.vehicleId)}'s diesel figures and ${stationName(d.vendorId)}'s purchases${d.paymentMode === "CASH" ? " (with its cash-at-pump payment)" : ""}.`,
        duplicate: similar(readCollection("diesel_entries"), (x) => x.vehicleId === d.vehicleId && x.date === d.date && (x.odometerKm === d.odometerKm || (!!d.billNo && x.billNo === d.billNo)), (x) => `${regNo(x.vehicleId)} · ${formatDate(x.date)} · ${L(x.litres)} · bill ${x.billNo || "—"}`),
      }
    }
    case "adblue_entries": {
      const a = r as unknown as AdBlueEntry
      vehicleOk(a.vehicleId)
      assertOpen(a.vehicleId, a.customerId, a.date)
      const direct = isDirectAdBlue(a)
      Object.assign(r, { amount: direct ? round2(a.quantityLitres * (a.rate ?? 0)) : 0, vendorId: "" })
      delete r.sourceVendor // view fields of the snapshot, never stored
      delete r.costRate
      if (r.beforeVendorTracking === undefined) r.beforeVendorTracking = true // a snapshot older than vendor tracking (every later one carries the flag)
      if (!direct) for (const k of ["vendorName", "rate", "paymentMode"]) delete r[k]
      if (a.adblueVendorId && !readCollection("adblue_vendors").some((v) => v.id === a.adblueVendorId)) throw new Error("Its AdBlue vendor no longer exists, so it can't be restored.")
      const { prev, next } = adBlueNeighbours(readCollection("adblue_entries"), a.vehicleId, a.date)
      if ((prev && !(a.closingKm > prev.closingKm)) || (next && !(a.closingKm < next.closingKm)))
        throw new Error(`Its odometer (${formatNumber(a.closingKm)} km) no longer fits between ${regNo(a.vehicleId)}'s other AdBlue entries, so it can't be restored.`)
      if (!direct) assertStock(readCollection("adblue_purchases"), [...readCollection("adblue_entries"), r as unknown as AdBlueEntry])
      return {
        key,
        record: r,
        note: direct
          ? `Adds ${L(a.quantityLitres)} (${formatINR(r.amount as number)}) bought directly from ${a.vendorName} back to ${regNo(a.vehicleId)}'s AdBlue figures; bulk stock is not affected.`
          : `Draws ${L(a.quantityLitres)} from AdBlue inventory again; stock, the monthly ledger and carry-forward are recalculated.`,
        duplicate: similar(readCollection("adblue_entries"), (x) => x.vehicleId === a.vehicleId && x.date === a.date && x.quantityLitres === a.quantityLitres, (x) => `${regNo(x.vehicleId)} · ${formatDate(x.date)} · ${L(x.quantityLitres)}`),
      }
    }
    case "adblue_purchases": {
      const p = r as unknown as AdBluePurchase
      if (p.opening && readCollection("adblue_purchases").some((x) => x.opening)) throw new Error("AdBlue opening stock is already recorded.")
      if (p.adblueVendorId && !readCollection("adblue_vendors").some((v) => v.id === p.adblueVendorId)) throw new Error("Its AdBlue vendor no longer exists, so it can't be restored.")
      return {
        key,
        record: r,
        note: `Adds ${L(p.totalLitres)} (${formatINR(p.totalCost)}) back to AdBlue stock; Inventory Value and later draws' cost are recalculated.`,
        duplicate: similar(readCollection("adblue_purchases"), (x) => x.vendorName === p.vendorName && x.date === p.date && x.totalLitres === p.totalLitres && x.totalCost === p.totalCost, (x) => `${x.vendorName} · ${formatDate(x.date)} · ${L(x.totalLitres)}`),
      }
    }
    case "tanker_loads": {
      const l = r as unknown as TankerLoad
      if (!readCollection("tankers").some((t) => t.id === tankerOf(l))) throw new Error("Its tanker no longer exists, so it can't be restored.")
      r.tankerId = tankerOf(l)
      if (l.opening) {
        // Opening stock (no supplier): one per tanker, never a purchase.
        if (readCollection("tanker_loads").some((x) => x.opening && tankerOf(x) === tankerOf(l))) throw new Error(`${tankerName(tankerOf(l))} already has opening stock recorded.`)
        return { key, record: r, note: `Adds ${L(l.litres)} of opening stock back to ${tankerName(tankerOf(l))}. It is not a purchase, so no station balance changes.`, duplicate: null }
      }
      const st = readCollection("fuel_stations").find((x) => x.id === l.stationId)
      if (!st || st.isTanker) throw new Error("Its supplier fuel station no longer exists, so it can't be restored.")
      return {
        key,
        record: r,
        note: `Adds ${L(l.litres)} back to ${tankerName(tankerOf(l))} and ${formatINR(l.amount)} to ${st.name}'s purchases and balance.`,
        duplicate: similar(readCollection("tanker_loads"), (x) => x.stationId === l.stationId && x.date === l.date && x.litres === l.litres && x.rate === l.rate, (x) => `${stationName(x.stationId)} · ${formatDate(x.date)} · ${L(x.litres)}`),
      }
    }
    case "tanker_dispenses": {
      const d = r as unknown as TankerDispense
      if (!readCollection("tankers").some((t) => t.id === tankerOf(d))) throw new Error("Its tanker no longer exists, so it can't be restored.")
      r.tankerId = tankerOf(d)
      assertTankerStock(tankerRecords({ external: [...readCollection("tanker_dispenses"), d] }), [tankerOf(d)])
      return {
        key,
        record: r,
        note: `Draws ${L(d.litres)} from ${tankerName(tankerOf(d))} again; the monthly tanker ledger and carry-forward are recalculated.`,
        duplicate: similar(readCollection("tanker_dispenses"), (x) => x.vehicleNo === d.vehicleNo && x.date === d.date && x.litres === d.litres, (x) => `${x.vehicleNo} · ${formatDate(x.date)} · ${L(x.litres)}`),
      }
    }
    case "tanker_transfers": {
      const t = r as unknown as TankerTransfer
      for (const id of [t.fromTankerId, t.toTankerId]) if (!readCollection("tankers").some((x) => x.id === id)) throw new Error("One of its tankers no longer exists, so it can't be restored.")
      assertTankerStock(tankerRecords({ transfers: [...readCollection("tanker_transfers"), t] }), [t.fromTankerId, t.toTankerId])
      return {
        key,
        record: r,
        note: `Moves ${L(t.litres)} from ${tankerName(t.fromTankerId)} to ${tankerName(t.toTankerId)} again; both tankers' ledgers are recalculated. Company stock and purchases don't change.`,
        duplicate: similar(readCollection("tanker_transfers"), (x) => x.fromTankerId === t.fromTankerId && x.toTankerId === t.toTankerId && x.date === t.date && x.litres === t.litres, (x) => meta.transfer(x).label),
      }
    }
    case "tanker_adjustments": {
      const a = r as unknown as TankerAdjustment
      if (!readCollection("tankers").some((x) => x.id === a.tankerId)) throw new Error("Its tanker no longer exists, so it can't be restored.")
      assertTankerStock(tankerRecords({ adjustments: [...readCollection("tanker_adjustments"), a] }), [a.tankerId])
      return {
        key,
        record: r,
        note: `${a.litres > 0 ? "Adds" : "Removes"} ${L(Math.abs(a.litres))} ${a.litres > 0 ? "to" : "from"} ${tankerName(a.tankerId)}'s stock again; its ledger and carry-forward are recalculated.`,
        duplicate: similar(readCollection("tanker_adjustments"), (x) => x.tankerId === a.tankerId && x.date === a.date && x.litres === a.litres, (x) => meta.adjustment(x).label),
      }
    }
    case "payments": {
      const p = r as unknown as Payment
      assertStationPaymentDate(p)
      if (readCollection("payments").some((x) => x.paymentNo === p.paymentNo)) throw new Error(`Voucher number ${p.paymentNo} has since been used by another payment, so this one can't be restored. Re-enter it as a new payment instead.`)
      if (p.vendorId && isStationPayment(p, p.vendorId) && !readCollection("fuel_stations").some((s) => s.id === p.vendorId)) throw new Error("Its fuel station no longer exists, so it can't be restored.")
      if (p.direction === "IN" && p.allocations.length) {
        const settled = settlementIndex(readCollection("payments"))
        for (const a of p.allocations) {
          const inv = readCollection("invoices").find((i) => i.id === a.invoiceId)
          if (!inv || inv.status !== "ISSUED") throw new Error(`The invoice this receipt settled is no longer issued, so it can't be restored.`)
          if (a.amount > round2(inv.total - (settled.get(inv.id) ?? 0)) + 0.5) throw new Error(`${inv.invoiceNo} has since been settled by other receipts — restoring would settle it twice.`)
        }
      }
      const station = !!p.vendorId && isStationPayment(p, p.vendorId)
      return {
        key,
        record: r,
        note: station
          ? `${stationName(p.vendorId!)}'s Payments Made rises by ${formatINR(p.amount)}; its closing balance and later openings fall by the same. The voucher returns to Payments.`
          : `${p.paymentNo} returns to Payments${p.allocations.length ? " and settles its invoices again" : ""}.`,
        duplicate: similar(readCollection("payments"), (x) => x.direction === p.direction && x.partyName === p.partyName && x.date === p.date && x.amount === p.amount, (x) => `${x.paymentNo} · ${x.partyName} · ${formatINR(x.amount)}`),
      }
    }
    case "industrial_supplies": {
      const x = r as unknown as IndustrialSupply
      if (!readCollection("customers").some((c) => c.id === x.customerId)) throw new Error("Its customer no longer exists, so it can't be restored.")
      assertCustomerOpen(x.customerId, x.date)
      const allocations = x.allocations ?? []
      if (!allocations.length || allocations.some((a) => !readCollection("tankers").some((t) => t.id === a.tankerId))) throw new Error("Its tankers are not on record, so it can't be restored.")
      assertTankerStock(tankerRecords({ industrial: [...readCollection("industrial_supplies"), x] }), allocations.map((a) => a.tankerId)) // its litres must still be in those tankers
      return {
        key,
        record: r,
        note: `Adds ${L(x.litres)} (${formatINR(x.amount)}) back to ${customerName(x.customerId)}'s industrial supply totals and takes them out of ${allocations.map((a) => `${tankerName(a.tankerId)} (${L(a.litres)})`).join(" and ")} again. Vehicle Diesel is not affected.`,
        duplicate: similar(readCollection("industrial_supplies"), (y) => y.customerId === x.customerId && y.date === x.date && y.litres === x.litres && y.rate === x.rate, (y) => `${customerName(y.customerId)} · ${formatDate(y.date)} · ${L(y.litres)}`),
      }
    }
    case "tyre_invoices": {
      const x = r as unknown as TyreInvoice
      vehicleOk(x.vehicleId)
      assertOpen(x.vehicleId, x.customerId, x.date)
      const exists = (id: string | null) => !id || readCollection("tyre_masters").some((m) => m.id === id)
      if (![x.supplierId, ...(x.items ?? []).flatMap((i) => [i.repairTypeId, i.brandId, i.sizeId])].every(exists) || !x.items?.length) throw new Error("Its supplier or repair lines are no longer on record, so it can't be restored.")
      r.items = x.items.map((i) => ({ ...i, ...lineAmounts(i.quantity, i.rate, i.gstRate, i.taxType) })) // stored exactly as calculated
      return {
        key,
        record: r,
        note: `Adds ${formatINR(tyreTotals(x.items).grandTotal)} of tyre work on ${regNo(x.vehicleId)} back to ${x.office ? `the ${OFFICE_LABEL}` : `${customerName(x.customerId)}'s`} tyre totals.`,
        duplicate: similar(readCollection("tyre_invoices"), (y) => y.supplierId === x.supplierId && y.date === x.date && y.vehicleId === x.vehicleId && (!!x.billNo ? y.billNo === x.billNo : tyreTotals(y.items).grandTotal === tyreTotals(x.items).grandTotal), (y) => `${tyreMasterName(y.supplierId)} · bill ${y.billNo || "—"} · ${regNo(y.vehicleId)} · ${formatDate(y.date)}`),
      }
    }
    case "trips": {
      const t = r as unknown as Trip
      vehicleOk(t.vehicleId)
      if (!readCollection("customers").some((c) => c.id === t.customerId)) throw new Error("Its customer no longer exists, so it can't be restored.")
      if (t.invoiceId) throw new Error("It was on an invoice, so it can't be restored.")
      assertOpen(t.vehicleId, t.customerId, t.date)
      if (readCollection("trips").some((x) => x.tripNo === t.tripNo)) throw new Error(`Trip number ${t.tripNo} has since been used by another trip, so this one can't be restored.`)
      return {
        key,
        record: r,
        note: `Adds ${formatINR(t.revenue)} revenue back to the customer, vehicle and profit totals; it can be billed again.`,
        duplicate: similar(readCollection("trips"), (x) => x.vehicleId === t.vehicleId && x.date === t.date && x.startKm === t.startKm && x.endKm === t.endKm, (x) => `${x.tripNo} · ${regNo(x.vehicleId)} · ${formatDate(x.date)}`),
      }
    }
  }
}

/** How a restored record reads in reports (tanker fills and AdBlue draws at cost), for the RESTORED event. */
function restoredView(key: RestorePlan["key"], record: Record<string, unknown>) {
  if (key === "diesel_entries") return dieselView(record as unknown as DieselEntry)
  if (key === "adblue_entries") return adblueView(record as unknown as AdBlueEntry)
  return record
}

export const api = {
  customers: {
    list: customers.list,
    get: customers.get,
    create: (input: NewEntity<Customer>) =>
      tx(async () => {
        assertCan("customers", "create")
        const after = await customers.create({ ...input, statusHistory: [{ status: input.status, startDate: todayISO(), endDate: null }] })
        audit({ action: "CREATED", ...meta.customer(after), after })
        return after
      }),
    /** A status change appends to statusHistory; past months keep the status they had. */
    update: (id: string, patch: Partial<NewEntity<Customer>>) => tx(() => updateCustomer(id, patch)),
    /** POST /api/customers/:id/archive — soft delete from today. History, vehicle assignments and reports stay as they are. */
    archive: (id: string) => tx(() => updateCustomer(id, { status: "ARCHIVED" })),
    restore: (id: string) => tx(() => updateCustomer(id, { status: "ACTIVE" })),
  },
  vehicles: {
    list: vehicles.list,
    get: vehicles.get,
    /**
     * POST /api/vehicles — `assignedSince` (owner, 3 Nov 2026): the day the vehicle started working for its customer
     * (default today; may be back-dated for go-live, never in the future; a locked month needs the Owner or Dev).
     * Its first assignment and status period start then, so entries dated from that day file under that customer.
     */
    create: (input: NewEntity<Vehicle> & { assignedSince?: string }) =>
      tx(async () => {
        assertCan("vehicles", "create")
        const { assignedSince: since, ...data } = input
        delete data.documentAlertHistory // a new vehicle has no alert history
        const start = since || todayISO()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("Enter the date the vehicle was assigned since")
        if (start > todayISO()) throw new Error("Assigned since can't be in the future.")
        if (data.assignedCustomerId && start < todayISO()) assertMonthEditable(start)
        assertCustomerOpen(data.assignedCustomerId, start)
        const v = await vehicles.create({ ...data, statusHistory: [{ status: data.status, startDate: start < todayISO() ? start : todayISO(), endDate: null }] })
        if (v.assignedCustomerId) savePeriods(v.id, [{ vehicleId: v.id, customerId: v.assignedCustomerId, startDate: start, endDate: null, status: "ACTIVE" }])
        audit({ action: "CREATED", ...meta.vehicle(v), after: v, note: v.assignedCustomerId ? `Assigned to ${customerName(v.assignedCustomerId)} since ${formatDate(start)}` : null })
        return v
      }),
    /** A status change appends to statusHistory; past months keep the status they had. */
    update: (id: string, patch: Partial<NewEntity<Vehicle>>) => tx(() => updateVehicle(id, patch)),
    transfer: (id: string, customerId: string | null, effectiveDate: string, reason?: string) => tx(() => transferVehicle(id, customerId, effectiveDate, reason)),
    /**
     * The vehicle moves to company `companyCode` (VT / VTHPL) from `effectiveDate` (owner, 27 Nov 2026): may be
     * back-dated, never in the future or before its last recorded change. Appends to companyPeriods (an audited vehicle
     * edit); earlier dates keep their company. Drivers' deployment history follows.
     */
    changeCompany: (id: string, companyCode: CompanyCode, effectiveDate: string) =>
      tx(async () => {
        assertCan("vehicles", "edit")
        const v = await vehicles.get(id)
        if (!v) throw new NotFoundError("Vehicle", id)
        if (companyCode === v.companyCode) throw new Error(`The vehicle is already with ${companyCode}.`)
        return updateVehicle(id, { companyCode }, effectiveDate)
      }),
    /**
     * POST /api/vehicles/:id/drivers (owner, 21 Nov 2026) — a driver starts driving this vehicle `since` (default today;
     * may be back-dated, never in the future). `vehicles:edit`. Dated, so who drove it in any period stays known
     * (withDriverAdded). An audited vehicle edit (UPDATED, before / after driverPeriods). The DL number stays on the driver.
     */
    addDriver: (id: string, driverId: string, since: string) =>
      tx(async () => {
        assertCan("vehicles", "edit")
        const v = await vehicles.get(id)
        if (!v) throw new NotFoundError("Vehicle", id)
        const d = readCollection("drivers").find((x) => x.id === driverId)
        if (!d) throw new NotFoundError("Driver", driverId)
        if (d.status === "ARCHIVED") throw new Error(`${d.name} is archived — restore the driver first.`)
        return updateVehicle(id, { driverPeriods: withDriverAdded(v.driverPeriods ?? [], driverId, since, todayISO(), () => newId("vdp")) })
      }),
    /**
     * DELETE /api/vehicles/:id/drivers/:driverId — the driver stops driving this vehicle; `lastDay` is their last day on
     * it (withDriverRemoved: the period closes, kept as history; one started today is removed). Removing the default
     * driver also clears the default (trip pre-fill). The driver record is untouched.
     */
    removeDriver: (id: string, driverId: string, lastDay: string) =>
      tx(async () => {
        assertCan("vehicles", "edit")
        const v = await vehicles.get(id)
        if (!v) throw new NotFoundError("Vehicle", id)
        const current = currentDriverIds(v).includes(driverId)
        if (!current && v.defaultDriverId !== driverId) throw new Error("This driver isn't on this vehicle now.")
        return updateVehicle(id, {
          ...(current ? { driverPeriods: withDriverRemoved(v.driverPeriods ?? [], driverId, lastDay, todayISO()) } : {}),
          ...(v.defaultDriverId === driverId ? { defaultDriverId: null } : {}),
        })
      }),
    /** Soft delete from today: kept in every report; no new diesel / AdBlue entries dated from today on. */
    archive: (id: string) => tx(() => updateVehicle(id, { status: "ARCHIVED" })),
    restore: (id: string) => tx(() => updateVehicle(id, { status: "ACTIVE" })),
    /**
     * PUT /api/vehicles/:id/opening-odometer — go-live opening (owner, 3 Nov 2026), Owner / Dev: the odometer at the
     * vehicle's last diesel fill before records begin, and that fill's date. The first fill on or after it measures its
     * KM Run from this reading. Refused when the vehicle already has a fill dated before it (it would be ignored).
     * `km: null` removes it. Never a fill: no litres, spend or entry.
     */
    setOpeningOdometer: (id: string, input: { km: number | null; date: string }) =>
      tx(async () => {
        assertWorkspaceAdmin("record opening odometers")
        const before = await vehicles.get(id)
        if (!before) throw new NotFoundError("Vehicle", id)
        if (input.km !== null) {
          if (!(Number.isFinite(input.km) && input.km >= 0)) throw new Error("Enter the opening odometer reading (km)")
          if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter the date of that reading")
          if (input.date > todayISO()) throw new Error("An opening odometer can't be dated in the future.")
          assertMonthEditable(input.date)
          const earlier = readCollection("diesel_entries").find((e) => e.vehicleId === id && e.date < input.date)
          if (earlier) throw new Error(`${before.regNo} already has a fill on ${formatDate(earlier.date)}, before ${formatDate(input.date)}, so this opening reading would be ignored.`)
        }
        if (before.openingOdometerDate) assertMonthEditable(before.openingOdometerDate)
        const km = input.km === null ? null : Math.round(input.km * 10) / 10
        const after = await vehicles.update(id, km === null ? { openingOdometerKm: null, openingOdometerDate: null } : { openingOdometerKm: km, openingOdometerDate: input.date, odometerKm: Math.max(before.odometerKm, km) })
        audit({ action: "UPDATED", ...meta.vehicle(after), before, after, note: km === null ? "Opening odometer removed" : `Opening odometer ${formatNumber(km)} km as of ${formatDate(input.date)}` })
        return after
      }),
  },
  /** Fuel stations (petrol pumps) — the one master list; never deleted, archived instead. */
  fuelStations: {
    list: fuelStations.list,
    get: fuelStations.get,
    /** POST /api/fuel-stations — a name that already exists returns that station (no duplicates). */
    create: (input: { name: string; location?: string; creditDays?: number }) =>
      tx(async () => {
        assertCan("diesel", "create")
        ensureSeeded()
        const name = input.name.trim()
        if (!name) throw new Error("Enter the fuel station name")
        const existing = readCollection("fuel_stations").find((v) => v.name.trim().toLowerCase() === name.toLowerCase())
        if (existing) return existing
        const after = await fuelStations.create({ name, location: input.location?.trim() ?? "", creditDays: input.creditDays ?? 30, isInterCompany: false, status: "ACTIVE" })
        audit({ action: "CREATED", ...meta.station(after), after })
        return after
      }),
    update: (id: string, patch: { name: string; location: string; creditDays: number }) =>
      tx(async () => {
        assertCan("diesel", "edit") // the permission first, before any validation (it names other stations)
        const name = patch.name.trim()
        if (!name) throw new Error("Enter the fuel station name")
        if (readCollection("fuel_stations").some((v) => v.id !== id && v.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`${name} already exists`)
        return updateStation(id, { ...patch, name, location: patch.location.trim() })
      }),
    /** Soft delete: past entries and reports keep the station; it leaves the pickers. */
    archive: (id: string) => tx(() => updateStation(id, { status: "ARCHIVED" })),
    restore: (id: string) => tx(() => updateStation(id, { status: "ACTIVE" })),
    /**
     * PUT /api/fuel-stations/:id/opening-balance — what was owed to (+) or by (−) the station on `date` (the fresh
     * start's 31 Oct 2026 baseline). Owner / Dev; month lock on the date. The ledger starts from it, so it is refused
     * when the station already has purchases or payments in an earlier month (the opening would be silently ignored).
     * amount 0 removes it. Never a purchase or payment.
     */
    setOpeningBalance: (id: string, input: { amount: number; date: string }) =>
      tx(async () => {
        assertWorkspaceAdmin("record opening balances")
        const before = await fuelStations.get(id)
        if (!before || before.isTanker) throw new NotFoundError("Fuel station", id)
        if (!Number.isFinite(input.amount)) throw new Error("Enter the opening balance")
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter the date the opening balance applies on")
        if (input.date > todayISO()) throw new Error("An opening balance can't be dated in the future.")
        if (before.openingBalanceDate && before.openingBalance) assertMonthEditable(before.openingBalanceDate)
        assertMonthEditable(input.date)
        const month = input.date.slice(0, 7)
        const earlier =
          readCollection("diesel_entries").find((e) => e.vendorId === id && e.date.slice(0, 7) < month) ??
          readCollection("tanker_loads").find((l) => !l.opening && l.stationId === id && l.date.slice(0, 7) < month) ??
          readCollection("payments").find((p) => isStationPayment(p, id) && p.date.slice(0, 7) < month)
        if (earlier && input.amount) throw new Error(`${before.name} already has records before ${format(parseISO(`${month}-01`), "MMMM yyyy")} (${formatDate(earlier.date)}), so an opening balance there would be ignored. Record it after the fresh start clears the old records.`)
        const amount = round2(input.amount)
        const after = await fuelStations.update(id, amount ? { openingBalance: amount, openingBalanceDate: input.date } : { openingBalance: undefined, openingBalanceDate: undefined })
        audit({ action: "UPDATED", ...meta.station(after), before, after, note: amount ? `Opening balance ${formatINR(amount)} (${amount > 0 ? "we owe" : "credit"}) as of ${formatDate(input.date)}` : "Opening balance removed" })
        return after
      }),
  },
  /**
   * Fuel station payments — a view over `payments[]` ("Diesel vendor payment" vouchers to a station),
   * so they also show in Payments. GET/POST /api/fuel-stations/:id/payments.
   */
  fuelStationPayments: {
    async list(): Promise<FuelStationPayment[]> {
      return (await payments.list())
        .filter((p) => p.direction === "OUT" && p.vendorId && p.categoryCode === STATION_PAYMENT_CATEGORY)
        .map((p) => ({ id: p.id, stationId: p.vendorId!, paymentDate: p.date, forMonth: p.forMonth ?? null, amount: round2(p.amount + p.tdsAmount), paidAmount: p.amount, tdsAmount: p.tdsAmount, tdsRate: p.tdsRate ?? null, reference: p.reference, paymentMode: p.mode, notes: p.notes, paymentNo: p.paymentNo, companyCode: p.companyCode, tds: !p.amount && p.tdsAmount > 0, updatedAt: p.updatedAt }))
    },
    /**
     * `amount` = the total settled. `tdsPercent` ("Deduct TDS?", off = absent / null): TDS = amount × % / 100 is
     * withheld — the voucher stores the net paid to the station, the TDS and the % (tdsSplit); the ledger reduces the
     * balance by the full total. Without it: exactly as before.
     */
    create: (input: { stationId: string; paymentDate: string; amount: number; paymentMode: PaymentMode; notes: string; companyCode: CompanyCode; reference?: string; forMonth?: string; tdsPercent?: number | null; confirmSeparateTds?: boolean }) =>
      tx(async () => {
        assertCan("payments", "create")
        const station = readCollection("fuel_stations").find((v) => v.id === input.stationId)
        if (!station) throw new NotFoundError("Fuel station", input.stationId)
        if (!(input.amount > 0)) throw new Error("Amount must be greater than zero")
        const split = stationTds(input.amount, input.tdsPercent, input.paymentMode)
        assertMonthEditable(input.paymentDate) // the lock answers first (createPayment checks it again)
        assertNoDoubleTds(station.id, input.forMonth, split.tdsAmount, input.confirmSeparateTds)
        return createPayment({
          companyCode: input.companyCode,
          direction: "OUT",
          date: input.paymentDate,
          partyType: "VENDOR",
          customerId: null,
          vendorId: station.id,
          vehicleId: null,
          partyName: station.name,
          categoryCode: STATION_PAYMENT_CATEGORY,
          ...split,
          mode: input.paymentMode,
          reference: (input.reference ?? "").trim(),
          allocations: [],
          notes: input.notes,
          ...(input.forMonth ? { forMonth: input.forMonth } : {}),
        })
      }),
    /** PATCH — date, amount, mode, notes, paid-against month. Both the old and the new date follow the Monthly Sheet Lock. */
    /** `tdsPercent`: a number = deduct TDS at that %; null = no TDS; undefined = keep the payment's own setting. */
    update: (id: string, patch: { paymentDate: string; amount: number; paymentMode: PaymentMode; notes: string; forMonth?: string; reference?: string; tdsPercent?: number | null; confirmSeparateTds?: boolean }, reason?: string) =>
      tx(async () => {
        const existing = await payments.get(id)
        assertCan("payments", "edit")
        if (!existing || !existing.vendorId || !isStationPayment(existing, existing.vendorId)) throw new NotFoundError("Fuel station payment", id)
        if (!(patch.amount > 0)) throw new Error("Amount must be greater than zero")
        assertMonthEditable(existing.date)
        assertMonthEditable(patch.paymentDate)
        assertStationPaymentDate(existing)
        assertStationPaymentDate({ ...existing, date: patch.paymentDate, forMonth: patch.forMonth ?? existing.forMonth })
        // A TDS entry stays a TDS entry on its month's last day: only its amount and notes change.
        const isTds = !existing.amount && existing.tdsAmount > 0
        if (isTds && patch.paymentDate !== existing.date) throw new Error("A TDS entry is always dated the last day of its month.")
        if (isTds && patch.tdsPercent != null) throw new Error("A TDS entry is TDS already — no TDS is deducted from it.")
        const split = isTds ? null : stationTds(patch.amount, patch.tdsPercent === undefined ? (existing.tdsRate ?? null) : patch.tdsPercent, patch.paymentMode)
        if (split) assertNoDoubleTds(existing.vendorId, patch.forMonth ?? existing.forMonth, split.tdsAmount, patch.confirmSeparateTds)
        const after = await payments.update(
          id,
          isTds
            ? { tdsAmount: round2(patch.amount), notes: patch.notes }
            : { date: patch.paymentDate, ...split!, mode: patch.paymentMode, notes: patch.notes, ...(patch.reference !== undefined ? { reference: patch.reference.trim() } : {}), ...(patch.forMonth ? { forMonth: patch.forMonth } : {}) }
        )
        audit({ action: "UPDATED", ...meta.payment(after), before: existing, after, reason })
        return after
      }),
    /** DELETE — only while the payment's month is open. */
    remove: (id: string, reason: string) => tx(() => removePayment(id, reason)),
    /**
     * POST /api/fuel-stations/:id/tds — TDS on the station's fuel bills for a month (uncle's answer 14): dated the
     * month's last day; suggested amount 0.1% of that month's Fuel Purchased (tdsDue). One per station per month.
     * Settles that much of what we owe the station; never touches the bank. Same payment lock as any station payment.
     */
    recordTds: (input: { stationId: string; month: string; amount: number; companyCode: CompanyCode; notes: string; confirmSeparateTds?: boolean }) =>
      tx(async () => {
        assertCan("payments", "create")
        const station = readCollection("fuel_stations").find((v) => v.id === input.stationId)
        if (!station || station.isTanker) throw new NotFoundError("Fuel station", input.stationId)
        if (!(input.amount > 0)) throw new Error("TDS amount must be greater than zero")
        const date = tdsDate(input.month)
        const label = format(parseISO(`${input.month}-01`), "MMMM yyyy")
        if (date > todayISO()) throw new Error(`TDS for ${label} is dated ${formatDate(date)} — record it on or after that day.`)
        // The month's TDS entry (mode TDS) — TDS deducted on a payment ("Deduct TDS?") is not one.
        const dup = readCollection("payments").find((p) => isStationPayment(p, station.id) && p.mode === "TDS" && p.date.startsWith(input.month))
        if (dup) throw new Error(`TDS for ${label} is already recorded for ${station.name} (${dup.paymentNo}). Edit that entry instead.`)
        // Per-payment TDS is the normal method (17 Nov 2026): a monthly entry for purchases already taxed on payments
        // needs an explicit confirmation that it is separate TDS.
        const taken = tdsTakenOn(readCollection("payments"), station.id, input.month)
        if (taken.onPayments > 0 && !input.confirmSeparateTds)
          throw new Error(`${formatINR(taken.onPayments)} of TDS was already deducted on ${taken.deducted.length} payment${taken.deducted.length === 1 ? "" : "s"} against ${label} purchases (${taken.deducted.map((p) => p.paymentNo).join(", ")}). A monthly TDS entry too would tax the same purchases twice. Confirm it is separate TDS to record it.`)
        return createPayment({
          companyCode: input.companyCode,
          direction: "OUT",
          date,
          partyType: "VENDOR",
          customerId: null,
          vendorId: station.id,
          vehicleId: null,
          partyName: station.name,
          categoryCode: STATION_PAYMENT_CATEGORY,
          amount: 0,
          tdsAmount: round2(input.amount),
          mode: "TDS",
          reference: `TDS ${input.month}`,
          allocations: [],
          notes: input.notes.trim(),
          forMonth: input.month,
        })
      }),
  },
  monthLocks: {
    list: monthLocks.list,
    /** PUT /api/month-locks/:month — Owner and Dev only (canSetMonthLock): lock a month early or unlock a closed one. */
    set: (month: string, state: "OPEN" | "LOCKED") =>
      tx(async () => {
        if (!canSetMonthLock(currentRole())) throw new Error("Only the Owner or Dev can lock or unlock a month.")
        const existing = readCollection("month_locks").find((l) => l.month === month)
        const changedBy = currentRole() // recorded as who actually did it — a Dev lock is never labelled Owner
        const after = existing ? await monthLocks.update(existing.id, { state, changedBy }) : await monthLocks.create({ month, state, changedBy })
        audit({
          action: state === "LOCKED" ? "MONTH_LOCKED" : "MONTH_UNLOCKED",
          module: "Month Lock",
          recordType: "Month lock",
          recordId: month,
          label: format(parseISO(`${month}-01`), "MMMM yyyy"),
          before: { month, state: existing?.state ?? "Automatic" },
          after: { month, state },
        })
        return after
      }),
  },
  /** GET /api/vehicle-assignments; changed through vehicles.transfer, or a start date corrected (correctStartDate). */
  assignments: {
    list: assignments.list,
    /**
     * PUT /api/vehicle-assignments/:id/start-date — corrects a start date entered wrongly (e.g. 07-11-2026 typed for
     * 01-11-2026, or a transfer saved on the day it was entered instead of the day the vehicle started). Not a new
     * transfer: the same assignment (id, customer, end date, status) gets the new start date, and when a transfer began
     * it, the previous assignment's end date moves with it (the day before) — both in one transaction, so the timeline
     * never overlaps or gains a gap. `vehicles:edit`; mandatory reason; every month whose days change must be open for
     * the role. Refused when the date is invalid / in the future / after the end date, leaves the previous assignment no
     * day, overlaps another assignment, or would move a diesel / AdBlue entry or trip (`startDateProblem`). No entry,
     * trip, invoice or payment is changed. Audited as UPDATED on the vehicle, one event per assignment changed (the
     * database's assignment trigger requires it).
     */
    correctStartDate: (id: string, input: { startDate: string; reason: string }) =>
      tx(async () => {
        assertCan("vehicles", "edit")
        const before = await assignments.get(id)
        if (!before) throw new NotFoundError("Vehicle assignment", id)
        const reasonError = deletionReasonError(input.reason, "correcting")
        if (reasonError) throw new Error(reasonError)
        const startDate = input.startDate?.trim() ?? ""
        const periods = readCollection("vehicle_assignments").filter((a) => a.vehicleId === before.vehicleId)
        const invalid = startDateProblem(periods, id, startDate, { entries: [], trips: [] }, todayISO())
        if (invalid) throw new Error(startDateMessage(invalid, before))
        // The Monthly Sheet Lock: every month whose days move in or out of the assignment.
        const [from, to] = [startDate, before.startDate].sort()
        assertMonthsEditable(from, dayBefore(to))
        if (startDate < before.startDate) assertCustomerOpen(before.customerId, startDate)
        const problem = startDateProblem(periods, id, startDate, attributedRecords(), todayISO())
        if (problem) throw new Error(startDateMessage(problem, before))
        const handedOver = handedOverBy(periods, before)
        const after = await assignments.update(id, { startDate })
        const reason = input.reason.trim()
        const label = (a: VehicleAssignment) => `${regNo(a.vehicleId)} · ${customerName(a.customerId)}`
        audit({
          action: "UPDATED",
          module: "Vehicles",
          recordType: "Vehicle assignment",
          recordId: before.vehicleId,
          label: `${label(before)} · assignment start ${formatDate(before.startDate)} → ${formatDate(startDate)}`,
          recordDate: from,
          before,
          after,
          reason,
          note: `Start date corrected — same assignment (${before.id})${handedOver ? `; the previous assignment (${handedOver.id}, ${customerName(handedOver.customerId)}) now ends ${formatDate(dayBefore(startDate))}` : ""}; no entry, trip, invoice or payment changed.`,
        })
        if (handedOver) {
          const endDate = correctedPeriods(periods, id, startDate).find((p) => p.id === handedOver.id)!.endDate
          const prevAfter = await assignments.update(handedOver.id, { endDate })
          audit({
            action: "UPDATED",
            module: "Vehicles",
            recordType: "Vehicle assignment",
            recordId: before.vehicleId,
            label: `${label(handedOver)} · assignment end ${formatDate(handedOver.endDate!)} → ${formatDate(endDate!)}`,
            recordDate: from,
            before: handedOver,
            after: prevAfter,
            reason,
            note: `Transfer date corrected — ${customerName(before.customerId)}'s assignment (${before.id}) now starts ${formatDate(startDate)}; the same two assignments, no entry, trip, invoice or payment changed.`,
          })
          // The database checks the no-overlap rule per statement: the assignment that gives up days is written first.
          const order = startDate < before.startDate ? [prevAfter, after] : [after, prevAfter]
          writeCollection("vehicle_assignments", [...readCollection("vehicle_assignments").filter((a) => a.id !== id && a.id !== handedOver.id), ...order])
        }
        return after
      }),
  },
  drivers: {
    list: drivers.list,
    get: drivers.get,
    create: (input: NewEntity<Driver>) =>
      tx(async () => {
        assertDriverAccess()
        const after = await drivers.create(checkDriverFields({ fatherName: "", dateOfBirth: "", address: "", ...input, companyCode: input.companyCode ?? null }, null))
        audit({ action: "CREATED", ...meta.driver(after), after })
        return after
      }),
    update: (id: string, patch: Partial<NewEntity<Driver>>) => tx(() => updateDriver(id, patch)),
    archive: (id: string) => tx(() => updateDriver(id, { status: "ARCHIVED" })),
    restore: (id: string) => tx(() => updateDriver(id, { status: "ACTIVE" })),
  },

  trips: {
    list: trips.list,
    get: trips.get,
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("trips", "delete")
        assertReason(reason)
        const t = await trips.get(id)
        if (!t) return
        if (t.invoiceId) throw new Error("Trip is billed on an invoice. Cancel the invoice first.")
        assertMonthEditable(t.date)
        await trips.remove(id)
        audit({ action: "DELETED", ...meta.trip(t), before: t, reason })
      }),
    /** POST /api/trips — server assigns number and prices the trip. */
    create: (input: TripInput) =>
      tx(async () => {
        assertCan("trips", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        assertOpen(input.vehicleId, input.customerId, input.date)
        assignedCustomer(input.vehicleId, input.date, input.customerId) // trips keep their billed customer, but only the assigned one may add new ones
        const ym = input.date.slice(2, 4) + input.date.slice(5, 7)
        const prefix = `TRP-${ym}-`
        const seq = nextSeq(readCollection("trips").map((t) => t.tripNo), prefix)
        const after = await trips.create({
          ...input,
          ...priceTrip(input),
          tripNo: `${prefix}${String(seq).padStart(4, "0")}`,
          invoiceId: null,
        })
        audit({ action: "CREATED", ...meta.trip(after), after })
        return after
      }),
    /** PATCH /api/trips/:id — re-prices unless already invoiced. */
    update: (id: string, input: TripInput, reason?: string) =>
      tx(async () => {
        assertCan("trips", "edit")
        const existing = await trips.get(id)
        if (!existing) throw new NotFoundError("Trip", id)
        if (existing.invoiceId) throw new Error("Invoiced trips are locked.")
        assertMonthEditable(existing.date)
        assertMonthEditable(input.date)
        if (input.vehicleId !== existing.vehicleId || input.customerId !== existing.customerId || input.date !== existing.date) {
          // The same rules as a new trip for the new vehicle / customer / date (archived, assigned customer).
          assertOpen(input.vehicleId, input.customerId, input.date)
          assignedCustomer(input.vehicleId, input.date, input.customerId)
        }
        const after = await trips.update(id, { ...input, ...priceTrip(input) })
        audit({ action: "UPDATED", ...meta.trip(after), before: existing, after, reason })
        return after
      }),
  },

  diesel: {
    /** GET /api/diesel-entries — customerId = customer assigned to the vehicle on the entry date. */
    list: async () => tankerValued(resolved(await diesel.list())),
    get: diesel.get,
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const e = await diesel.get(id)
        if (!e) return // already deleted (e.g. a repeated click) — nothing to do, nothing recorded
        assertMonthEditable(e.date)
        const before = dieselView(e)
        await diesel.remove(id)
        await syncVehicleOdometer(e.vehicleId, e.odometerKm, null)
        audit({ action: "DELETED", ...meta.diesel(e), before, reason })
      }),
    create: (input: Omit<NewEntity<DieselEntry>, "amount" | "companyCode">) =>
      tx(async () => {
        assertCan("diesel", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        const vehicle = readCollection("vehicles").find((v) => v.id === input.vehicleId)
        if (!vehicle) throw new NotFoundError("Vehicle", input.vehicleId)
        input = { ...input, customerId: assignedCustomer(vehicle.id, input.date, input.customerId) }
        assertOpen(vehicle.id, input.customerId, input.date)
        if (isTankerFill(input)) {
          // From a tanker's cargo (an internal stock movement, never a purchase): that tanker's stock must cover it.
          // Amount = litres × the source rate entered on the fill (answer 23) — never a weighted average for a new fill.
          assertNotTankerItself(vehicle.id)
          assertTankerOpen(input.tankerId, "Choose the tanker the diesel came out of")
          assertDieselVehicle(vehicle)
          if (!(input.rate > 0)) throw new Error("Enter the source rate per litre for this tanker fill")
          input = { ...input, paymentMode: "CREDIT" }
          assertTankerFill({ ...input, id: "new", createdAt: new Date().toISOString() })
        } else {
          assertPumpStation(input.vendorId)
          delete input.tankerId
        }
        assertFillOdometer(vehicle.id, null, input.date, input.odometerKm ?? NaN) // a new fill always has a reading
        const entry = await diesel.create({ ...input, companyCode: vehicle.companyCode, amount: round2(input.litres * input.rate) })
        await syncVehicleOdometer(vehicle.id, null, entry.odometerKm)
        audit({ action: "CREATED", ...meta.diesel(entry), after: dieselView(entry) })
        return entry
      }),
    /** PATCH /api/diesel-entries/:id — amount is always recomputed from litres × rate. */
    update: (id: string, raw: Pick<DieselEntry, "date" | "vendorId" | "litres" | "rate" | "odometerKm" | "billNo" | "paymentMode" | "tankerId">, reason?: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        // Only the editable fields: an edit never moves a fill to another vehicle, customer or company (server-enforced).
        let input: Pick<DieselEntry, "date" | "vendorId" | "litres" | "rate" | "odometerKm" | "billNo" | "paymentMode" | "tankerId"> = { date: raw.date, vendorId: raw.vendorId, litres: raw.litres, rate: raw.rate, odometerKm: raw.odometerKm, billNo: raw.billNo, paymentMode: raw.paymentMode, tankerId: raw.tankerId }
        const before = await diesel.get(id)
        if (!before) throw new NotFoundError("Diesel entry", id)
        assertMonthEditable(before.date) // can't move an entry out of a locked month either
        assertMonthEditable(input.date)
        assertSameCustomerOnDate(before.vehicleId, before.customerId, before.date, input.date)
        if (isTankerFill(input)) {
          // Only a fill newly switched to tanker cargo; one already recorded that way (source history) stays editable.
          if (!isTankerFill(before)) {
            assertNotTankerItself(before.vehicleId)
            const vehicle = readCollection("vehicles").find((v) => v.id === before.vehicleId)
            if (vehicle) assertDieselVehicle(vehicle)
          }
          input = { ...input, tankerId: input.tankerId ?? before.tankerId, paymentMode: "CREDIT" }
          if (input.tankerId !== before.tankerId) assertTankerOpen(input.tankerId, "Choose the tanker the diesel came out of")
          // Only an older fill saved without a rate (costed at the average on read) may keep rate 0; nothing new gets it.
          const legacyNoRate = isTankerFill(before) && !(before.rate > 0) && !(input.rate > 0)
          if (!(input.rate > 0) && !legacyNoRate) throw new Error("Enter the source rate per litre for this tanker fill")
        } else {
          if (input.vendorId !== before.vendorId) assertPumpStation(input.vendorId) // an existing fill keeps its station
          input = { ...input, tankerId: undefined }
        }
        if (isTankerFill(input)) assertTankerFill({ ...before, ...input })
        if (isTankerFill(input) || isTankerFill(before))
          assertTankerStock(tankerRecords({ fills: readCollection("diesel_entries").map((e) => (e.id === id ? { ...e, ...input } : e)) }), [isTankerFill(before) ? tankerOf(before) : undefined, isTankerFill(input) ? tankerOf(input) : undefined].filter(Boolean))
        // The reading: an imported fill recorded without one may stay without one; any other fill keeps a valid reading,
        // checked against its neighbours when the reading or the date changes (unchanged history isn't re-judged).
        if (input.odometerKm === null) {
          if (before.odometerKm !== null) throw new Error("Enter the odometer reading (km)")
        } else if (input.odometerKm !== before.odometerKm || input.date !== before.date) assertFillOdometer(before.vehicleId, id, input.date, input.odometerKm)
        const beforeView = dieselView(before)
        const after = await diesel.update(id, { ...input, amount: round2(input.litres * input.rate) })
        await syncVehicleOdometer(before.vehicleId, before.odometerKm, after.odometerKm)
        audit({ action: "UPDATED", ...meta.diesel(after), before: beforeView, after: dieselView(after), reason })
        return after
      }),
  },

  adblue: {
    /** GET /api/adblue-entries — customerId = customer assigned to the vehicle on the entry date. */
    list: async () => valued(resolved(await adblue.list())),
    /** POST /api/adblue-entries — draws from inventory; closing km must sit between the vehicle's previous and next entries. */
    create: (input: AdBlueInput) =>
      tx(async () => {
        assertCan("adblue", "create")
        assertMonthEditable(input.date)
        assertProfileAssignment(input.vehicleId, input.date)
        input = { ...input, customerId: assignedCustomer(input.vehicleId, input.date, input.customerId) }
        assertCustomerScope(input.customerId)
        assertOpen(input.vehicleId, input.customerId, input.date)
        assertDrawVendor(input)
        if (isDirectAdBlue(input)) input = { ...input, ...(await directVendor(input)) }
        const entry = { ...checkAdBlue(input), beforeVendorTracking: false }
        // A direct purchase on credit is owed to its vendor; Fully / Partially Paid add a payment (checked before saving).
        const pay = directPayment(input, entry, 0, false)
        const would = [...readCollection("adblue_entries"), { ...entry, id: "new", createdAt: new Date().toISOString() }]
        assertStock(readCollection("adblue_purchases"), would) // direct purchases are left out of the stock check
        const after = await adblue.create(entry)
        audit({ action: "CREATED", ...meta.adblue(after), after: adblueView(after) })
        if (pay) {
          const p = await adbluePayments.create({ ...pay, allocations: [{ purchaseId: after.id, amount: pay.allocations[0].amount, direct: true }] })
          audit({ action: "PAYMENT_RECORDED", ...meta.adbluePayment(p), after: p, note: `Paid with ${abPayableLabel(directPayable(after)!)}` })
        }
        return after
      }),
    update: (id: string, input: AdBlueInput, reason?: string) =>
      tx(async () => {
        assertCan("adblue", "edit")
        const before = await adblue.get(id)
        if (!before) throw new NotFoundError("AdBlue entry", id)
        assertCustomerScope(before.customerId)
        input = { ...input, vehicleId: before.vehicleId, customerId: before.customerId } // an edit never moves the entry to another vehicle or customer
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        assertSameCustomerOnDate(before.vehicleId, before.customerId, before.date, input.date)
        assertProfileAssignment(before.vehicleId, input.date)
        if (input.adblueVendorId === undefined) input = { ...input, adblueVendorId: before.adblueVendorId ?? null } // not named: the vendor stays
        assertDrawVendor(input)
        if (isDirectAdBlue(input)) input = { ...input, ...(await directVendor(input, before)) }
        const entry = checkAdBlue(input, id) // beforeVendorTracking stays as stored
        // Payments already allocated stay as they were: a direct purchase on credit keeps its vendor, stays a direct purchase
        // on credit, and its value never goes below what was paid (owner, 18 Nov 2026).
        const paid = paidByPurchase(readCollection("adblue_payments")).get(id) ?? 0
        if (paid > 0) {
          if (!isPayableDirect(entry as AdBlueEntry) || entry.adblueVendorId !== before.adblueVendorId) throw new Error(`Payments are allocated to this direct purchase, so it must stay a direct purchase on credit from ${before.vendorName || "its vendor"}. Delete or re-allocate those payments first (AdBlue → Payments).`)
          if (entry.amount < paid) throw new Error(`${formatINR(paid)} has already been paid against this purchase, so its amount can't go below that (new amount ${formatINR(entry.amount)}). Correct or delete the payment first.`)
        }
        const pay = directPayment(input, entry, paid, true)
        if (pay) assertAbAllocationMonths([{ purchaseId: id }])
        const would = readCollection("adblue_entries").map((e) => (e.id === id ? { ...e, ...entry } : e))
        assertStock(readCollection("adblue_purchases"), would)
        // The entry is rewritten only when its own fields change — never for a payment alone.
        const changed = Object.keys(entry).some((k) => JSON.stringify((entry as Record<string, unknown>)[k] ?? null) !== JSON.stringify((before as unknown as Record<string, unknown>)[k] ?? null))
        let after = before
        if (changed) {
          const beforeView = adblueView(before)
          after = await adblue.update(id, entry)
          audit({ action: "UPDATED", ...meta.adblue(after), before: beforeView, after: adblueView(after), reason })
        }
        if (pay) {
          const p = await adbluePayments.create({ ...pay, allocations: [{ purchaseId: id, amount: pay.allocations[0].amount, direct: true }] })
          audit({ action: "PAYMENT_RECORDED", ...meta.adbluePayment(p), after: p, note: `Paid from Edit Direct Purchase · ${abPayableLabel(directPayable(after)!)}${p.allocations[0].amount < abSettled(p) ? ` · ${formatINR(round2(abSettled(p) - p.allocations[0].amount))} advance credit` : ""}` })
        }
        return after
      }),
    /** DELETE — the litres go back into stock. Removing a draw can never make stock negative. */
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("adblue", "delete")
        assertReason(reason)
        const e = await adblue.get(id)
        if (!e) return
        assertCustomerScope(e.customerId)
        assertMonthEditable(e.date)
        const pays = readCollection("adblue_payments").filter((p) => p.allocations.some((a) => a.purchaseId === id))
        if (pays.length) throw new Error(`Payments are allocated to this direct purchase (${pays.map((p) => `${formatDate(p.date)} ${formatINR(abSettled(p))}`).join("; ")}), so it can't be deleted. Delete or re-allocate those payments first (AdBlue → Payments).`)
        const before = adblueView(e)
        await adblue.remove(id)
        audit({ action: "DELETED", ...meta.adblue(e), before, reason })
      }),
  },

  /**
   * GET /api/adblue-stock — every bulk-stock draw as the shared stock sees it: date, litres and order only (no vehicle,
   * customer or amount), so stock, carry-forward and the dialog's stock check are company-wide for every role, also
   * for Tata Adblue, whose entry lists are limited to its customers.
   */
  adblueStock: {
    list: async () => stockDraws(await adblue.list()).map((e) => ({ id: e.id, date: e.date, createdAt: e.createdAt, quantityLitres: e.quantityLitres, source: "STOCK" as const, adblueVendorId: e.adblueVendorId ?? null, beforeVendorTracking: !!e.beforeVendorTracking })),
  },

  /**
   * GET /api/adblue-totals — the AdBlue page's company-wide figures, totals by month only (adBlueTotals): stock, value,
   * the monthly ledger, consumption at cost and direct vendor purchases. No single entry of any customer is in it, so
   * Tata Adblue gets the whole company's AdBlue without any other customer's records (owner, 11 Nov 2026).
   */
  adblueTotals: {
    get: async () => adBlueTotals(await adbluePurchases.list(), valued(await adblue.list()), todayISO().slice(0, 7)),
  },

  /**
   * GET /api/adblue-vehicles — the registration of every vehicle that has an AdBlue entry (id and number only), so the
   * AdBlue page names each record's vehicle for every role — also for Tata Adblue, whose vehicle list (Diesel) holds only
   * its granted customers' vehicles (owner, 12 Nov 2026: AdBlue is company-wide to view).
   */
  /**
   * /api/industrial-supplies — Industrial Diesel Supply (owner, 12 Nov 2026): diesel supplied to a customer for
   * industrial use, never a vehicle. The `diesel` permission (as every Diesel record), the month lock on the old and
   * new date, an existing customer not archived on the date, amount = litres × rate (stored; the database computes it
   * too), a reason on every edit and delete, audited. Never touches vehicle Diesel, stock, stations or payments.
   */
  industrialSupplies: {
    list: industrialSupplies.list,
    create: (input: IndustrialSupplyInput) =>
      tx(async () => {
        assertCan("diesel", "create")
        const data = checkIndustrial(input)
        assertMonthEditable(data.date)
        assertIndustrialStock({ ...data, id: "new", createdAt: new Date().toISOString() })
        const after = await industrialSupplies.create({ ...data, createdBy: actorProfileId(), updatedBy: actorProfileId() })
        audit({ action: "CREATED", ...meta.industrial(after), after })
        return after
      }),
    update: (id: string, input: IndustrialSupplyInput, reason: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        const why = deletionReasonError(reason, "correcting")
        if (why) throw new Error(why)
        const before = await industrialSupplies.get(id)
        if (!before) throw new NotFoundError("Industrial supply", id)
        const data = checkIndustrial({ ...input, customerId: before.customerId }, before.allocations.map((a) => a.tankerId)) // an edit never moves it to another customer
        assertMonthEditable(before.date)
        assertMonthEditable(data.date)
        assertIndustrialStock({ ...data, id, createdAt: before.createdAt }) // its original litres back in their tankers first
        const after = await industrialSupplies.update(id, { ...data, updatedBy: actorProfileId() })
        audit({ action: "UPDATED", ...meta.industrial(after), before, after, reason: reason.trim() })
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const before = await industrialSupplies.get(id)
        if (!before) return
        assertCustomerScope(before.customerId)
        assertMonthEditable(before.date)
        await industrialSupplies.remove(id)
        audit({ action: "DELETED", ...meta.industrial(before), before, reason: reason.trim() })
      }),
  },

  /** Tyre Data → Tyre masters: suppliers, repair types, tyre brands and sizes. Never deleted — archived and restored. */
  tyreMasters: {
    list: tyreMasters.list,
    create: (input: TyreMasterInput) =>
      tx(async () => {
        assertCan("tyres", "create")
        const name = checkTyreMaster(input.kind, input.name)
        const after = await tyreMasters.create({ kind: input.kind, name, status: "ACTIVE" })
        audit({ action: "CREATED", ...meta.tyreMaster(after), after })
        return after
      }),
    /** Rename. Past invoices show the new name (they point at the value, not at its text). */
    update: (id: string, input: { name: string }) =>
      tx(async () => {
        assertCan("tyres", "edit")
        const before = await tyreMasters.get(id)
        if (!before) throw new NotFoundError("Tyre list value", id)
        const after = await tyreMasters.update(id, { name: checkTyreMaster(before.kind, input.name, id) })
        audit({ action: "UPDATED", ...meta.tyreMaster(after), before, after })
        return after
      }),
    archive: (id: string) => setTyreMasterStatus(id, "ARCHIVED"),
    restore: (id: string) => setTyreMasterStatus(id, "ACTIVE"),
  },

  /**
   * Expense → Road Tax, Insurance, Fitness, Fines, Broker Charges (owner, 25 Nov 2026). Both backends (Phase 2B: the
   * shared database's expense schema, 20261128000000). Permission `expenses`: Dev only while
   * the module is unreleased (owner, 25 Nov 2026; UNRELEASED in permissions.ts) — reads refused too. Month lock on the
   * old and new date; delete with a reason. Audited.
   */
  expenses: {
    list: async () => {
      const role = currentRole()
      if (!can(role, "expenses")) throw new PermissionError("Your role can't view expense records.")
      // Only the sections the role may use (EMP 1: no Insurance). On the shared database RLS already left them out.
      return (await expenses.list()).filter((x) => expenseSectionAllowed(role, x.section))
    },
    /**
     * Phase 2B (§5.4): 1. a `requestId` already used → the saved record (same content) or a refusal (changed content) —
     * never a second record, even with `confirmSameDay`; 2. the Phase 1 rules; 3. broker bulk payments only — another
     * payment with the same broker, date and amount needs `confirmSameDay` (PossibleDuplicateError otherwise).
     */
    create: (input: ExpenseInput, opts: { confirmSameDay?: boolean } = {}) =>
      tx(async () => {
        assertCan("expenses", "create")
        assertExpenseSection(input.section)
        const rid = typeof input.requestId === "string" && input.requestId ? input.requestId : null
        const used = rid ? readCollection("expenses").find((e) => e.requestId === rid) : undefined
        if (used) {
          let same = false
          try {
            same = sameExpenseContent(checkExpense(input, used.id), used)
          } catch (e) {
            if (e instanceof NeedData) throw e // the shared backend loading data on demand — never a validation result
            same = false
          }
          if (same) return used // a retry of a save that already happened: nothing new is written
          throw new Error("This request was already saved with different values — reopen the form. Nothing was saved.")
        }
        // Broker Charges (owner, 27 Nov 2026): a bill (owed — never money paid) or a bulk payment to the broker. Opening
        // balances are never added here; the ones recorded stay and can be edited.
        if (input.section === "BROKER" && input.entryType !== "PAYMENT" && input.entryType !== "CHARGE") throw new Error("Record a bill or a payment to the broker.")
        if (input.section === "BROKER" && input.entryType === "CHARGE" && Number(input.paidAmount)) throw new Error("A bill records what's owed — record money paid to the broker with Add Payment.")
        const data = checkExpense(input)
        assertExpenseMonthOpen(data.section, data.date)
        assertMonthEditable(data.date)
        if (data.section === "BROKER") assertBrokerLedger([...readCollection("expenses"), { ...data, id: "new", createdAt: "9999", updatedAt: "9999" }], [data.broker], data.entryType)
        const twin = samePaymentAs(data)
        if (twin && !opts.confirmSameDay) throw new PossibleDuplicateError({ id: twin.id, label: `a payment of ${formatINR(twin.paidAmount)} to ${twin.broker} on ${formatDate(twin.date)}` })
        const after = await expenses.create(data)
        audit({ action: "CREATED", ...meta.expense(after), after })
        return after
      }),
    update: (id: string, input: ExpenseInput, reason?: string, opts: { confirmSameDay?: boolean } = {}) =>
      tx(async () => {
        assertCan("expenses", "edit")
        const before = await expenses.get(id)
        if (!before) throw new NotFoundError("Expense", id)
        assertExpenseSection(before.section) // EMP 1 never changes an Insurance record, whatever the request says
        assertExpenseSection(input.section)
        assertExpenseMonthOpen(before.section, before.date)
        assertMonthEditable(before.date)
        if (input.section !== before.section) throw new Error(`This is a ${EXPENSE_SECTIONS[before.section].one}; it can't be moved to ${EXPENSE_SECTIONS[input.section]?.title ?? "another section"}.`)
        // A bill stays a bill, a payment a payment, an opening balance an opening balance (owner, 27 Nov 2026).
        if (before.section === "BROKER" && (input.entryType ?? "CHARGE") !== before.entryType) throw new Error(`This is ${before.entryType === "PAYMENT" ? "a payment" : before.entryType === "BROUGHT_FORWARD" ? "an opening balance" : "a bill"} — it stays one. Record the other kind as a new entry.`)
        const data = checkExpense(input, id)
        assertExpenseMonthOpen(data.section, data.date)
        assertMonthEditable(data.date)
        if (data.section === "BROKER") assertBrokerLedger(readCollection("expenses").map((e) => (e.id === id ? { ...e, ...data } : e)), [before.broker, data.broker], data.entryType)
        const twin = samePaymentAs(data, id)
        if (twin && !opts.confirmSameDay) throw new PossibleDuplicateError({ id: twin.id, label: `a payment of ${formatINR(twin.paidAmount)} to ${twin.broker} on ${formatDate(twin.date)}` })
        // An edit keeps the record's own request id and import batch (they describe how it was created).
        data.requestId = before.requestId ?? null
        data.importBatchId = before.importBatchId ?? null
        const after = await expenses.update(id, data)
        audit({ action: "UPDATED", ...meta.expense(after), before, after, reason: reason?.trim() || undefined })
        return after
      }),
    /** The Owner and Dev only (delete), with a reason. Not restorable from the Audit Log in Phase 1 (its DELETED event keeps the full record). */
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("expenses", "delete")
        assertReason(reason)
        const before = await expenses.get(id)
        if (!before) return
        assertExpenseSection(before.section)
        assertExpenseMonthOpen(before.section, before.date)
        assertMonthEditable(before.date)
        if (before.section === "BROKER") assertBrokerLedger(readCollection("expenses").filter((e) => e.id !== id), [before.broker], before.entryType)
        await expenses.remove(id)
        audit({ action: "DELETED", ...meta.expense(before), before, reason: reason.trim() })
      }),
  },

  /**
   * Import of a browser backup's Expense data into the shared database (Phase 2B, §7; Dev only, shared database only).
   * `importPlan` and `rollbackPlan` are dry runs (read methods — never written); `importApply` writes the batch, the new
   * brokers, entries and locks **as they are** (id, createdAt, updatedAt, date) in one transaction, with one CREATED
   * event each (its time = the import; its note = the original dates). Nothing is ever overwritten or deleted by it.
   */
  expenseImport: {
    list: async () => {
      if (currentRole() !== "DEV") throw new PermissionError("Only Dev can see Expense imports.")
      return expenseImportBatches.list()
    },
    importPlan: async (file: unknown, label: string) => publicPlan(await planExpenseImport(file, label)),
    importApply: (file: unknown, label: string) =>
      tx(async () => {
        const plan = await planExpenseImport(file, label)
        if (plan.appliedAs) throw new Error(`This file was already imported (batch ${plan.appliedAs}). Nothing was saved.`)
        if (plan.blocking.length) throw new Error(`The import can't be applied: ${plan.blocking.join("; ")}. Nothing was saved.`)
        const imported = (c: ImportCollection) => new Set(plan.items.filter((i) => i.sourceCollection === c && i.outcome === "IMPORTED").map((i) => i.sourceId))
        const [eIds, bIds, lIds] = [imported("expenses"), imported("brokers"), imported("expense_month_locks")]
        if (!eIds.size && !bIds.size && !lIds.size) throw new Error("Nothing new to import from this file. Nothing was saved.")
        const at = new Date().toISOString()
        const batch = await expenseImportBatches.create({
          sourceLabel: plan.label, sourceFingerprint: plan.fingerprint, exportedAt: plan.exportedAt,
          summary: { ...publicPlan(plan), items: undefined, importedAt: at } as Record<string, unknown>,
          sourceSnapshot: plan._source as unknown as Record<string, unknown>,
          // In the database's order (collection, then source id) so the batch reads back exactly as written.
          items: plan.items
            .map((i) => ({ sourceCollection: i.sourceCollection, sourceId: i.sourceId, outcome: i.outcome, targetId: i.targetId, reason: i.reason }))
            .sort((a, b) => (a.sourceCollection < b.sourceCollection ? -1 : a.sourceCollection > b.sourceCollection ? 1 : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
        })
        audit({ action: "CREATED", ...meta.importBatch(batch), after: { ...batch, sourceSnapshot: undefined } as never, note: `${eIds.size} entries, ${bIds.size} brokers, ${lIds.size} locks imported` })
        const note = (x: { createdAt: string; updatedAt: string }) => `Imported from browser backup '${plan.label}' (batch ${batch.id}) — originally entered ${x.createdAt}, last changed ${x.updatedAt}`
        // Exact records (never repository.create): id, createdAt, updatedAt and the business date are kept.
        const newBrokers = plan._source.brokers.filter((b) => bIds.has(b.id))
        if (newBrokers.length) writeCollection("brokers", [...readCollection("brokers"), ...newBrokers])
        for (const b of newBrokers) audit({ action: "CREATED", ...meta.broker(b), after: b, note: note(b) })
        const accepted = plan._source.expenses
          .filter((x) => eIds.has(x.id))
          .map((x) => {
            const stamp = assignmentOn(assignmentIndex(periodsOf(x.vehicleIds[0] ?? "")), x.vehicleIds[0] ?? "", x.date)?.customerId ?? null
            return { ...x, customerId: x.section === "BROKER" ? x.customerId ?? null : stamp, requestId: null, importBatchId: batch.id } as Expense
          })
        if (accepted.length) writeCollection("expenses", [...readCollection("expenses"), ...accepted])
        for (const x of accepted) audit({ action: "CREATED", ...meta.expense(x), after: x, note: note(x) })
        const locks = plan._source.expense_month_locks.filter((l) => lIds.has(l.id))
        if (locks.length) writeCollection("expense_month_locks", [...readCollection("expense_month_locks"), ...locks])
        for (const l of locks) audit({ action: "MONTH_LOCKED", ...meta.expenseMonth(l), after: l, note: note(l) })
        return { batch: { ...batch, sourceSnapshot: {} }, plan: publicPlan(plan) }
      }),
    rollbackPlan: async (batchId: string) => publicRollback(planRollback(batchId)),
    /** Deletes the batch's eligible entries (open section-months, unchanged since import, ledger safe) — never more (§7.6). */
    rollbackApply: (batchId: string, reason: string) =>
      tx(async () => {
        if (currentRole() !== "DEV") throw new PermissionError("Only Dev can roll back an import.")
        assertReason(reason)
        const plan = planRollback(batchId)
        const batch = readCollection("expense_import_batches").find((b) => b.id === batchId)!
        for (const id of plan.eligible) {
          const before = plan._byId.get(id)!
          await expenses.remove(id)
          audit({ action: "DELETED", ...meta.expense(before), before, reason: `Import rollback of batch ${batchId}: ${reason.trim()}` })
        }
        const report: ExpenseRollbackReport = { ...publicRollback(plan), deleted: [...plan.eligible] }
        // The batch row itself never changes; its summary event records the rollback (before / after = the rollback status).
        const previous = visibleEvents().filter((e) => e.recordId === batchId && e.action === "UPDATED").at(-1)
        audit({ action: "UPDATED", ...meta.importBatch(batch), before: { rollback: (previous?.after as { rollback?: unknown } | null)?.rollback ?? "none" } as never, after: { rollback: report } as never, note: `Rollback ${report.status}` })
        return report
      }),
  },

  /**
   * Expense months (owner, 25 Nov 2026): each section's month is OPEN until it is locked explicitly, after review — never
   * by the calendar. Locking one section's month leaves the other sections open. A locked section-month's records are
   * read-only for every role (add, edit, delete refused above). No unlock yet.
   * Both backends (shared database: expense.month_locks, append-only). Audited (MONTH_LOCKED).
   */
  expenseMonths: {
    list: async () => {
      const role = currentRole()
      if (!can(role, "expenses")) throw new PermissionError("Your role can't view expense months.")
      return (await expenseMonthLocks.list()).filter((l) => !l.section || expenseSectionAllowed(role, l.section))
    },
    lock: (section: ExpenseSection, month: string) =>
      tx(async () => {
        assertCan("expenses", "edit")
        // …and the Owner / Dev month-lock authority (Dev today) — never EMP 1, although it edits (owner, 28 Nov 2026).
        if (!canLockExpenseMonths(currentRole())) throw new PermissionError("Your role can't lock Expense months.")
        if (!Object.hasOwn(EXPENSE_SECTIONS, section)) throw new Error("Choose the Expense section")
        if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose the month to lock")
        if (month > todayISO().slice(0, 7)) throw new Error("A month that hasn't started yet can't be locked.")
        if (isMonthLocked(readCollection("expense_month_locks"), section, month)) throw new Error(`${format(parseISO(`${month}-01`), "MMMM yyyy")} is already locked in ${EXPENSE_SECTIONS[section].title}.`)
        const after = await expenseMonthLocks.create({ month, section })
        audit({ action: "MONTH_LOCKED", ...meta.expenseMonth(after), after })
        return after
      }),
  },

  /**
   * The broker list (Broker Charges, owner 25 Nov 2026): picked in the entry form, added there (Add New Broker). Names
   * unique — spaces and case ignored. Same permission and Phase 1 rule as the entries (browser backend only). Audited.
   */
  brokers: {
    list: async () => {
      if (!can(currentRole(), "expenses")) throw new PermissionError("Your role can't view brokers.")
      return brokers.list()
    },
    create: (name: string) =>
      tx(async () => {
        assertCan("expenses", "create")
        const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : ""
        if (!clean) throw new Error("Enter the broker's name")
        if (clean.length > 80) throw new Error("A broker name is at most 80 characters.")
        const same = readCollection("brokers").find((b) => textKey(b.name) === textKey(clean))
        if (same) throw new Error(`${same.name} is already in the broker list.`)
        const after = await brokers.create({ name: clean })
        audit({ action: "CREATED", ...meta.broker(after), after })
        return after
      }),
  },

  /** Tyre invoices: one supplier bill for one vehicle, with its repair lines — saved together or not at all. */
  tyreInvoices: {
    list: tyreInvoices.list,
    create: (input: TyreInvoiceInput) =>
      tx(async () => {
        assertCan("tyres", "create")
        const data = checkTyreInvoice(input)
        assertMonthEditable(data.date)
        const pay = initialTyrePayment(input, data)
        const after = await tyreInvoices.create(data)
        audit({ action: "CREATED", ...meta.tyreInvoice(after), after })
        if (pay) {
          // Saved with the invoice (same transaction): allocated to it up to its total, the rest explicitly advance.
          const p = await tyrePayments.create({ ...pay, allocations: pay.allocations.map((a) => ({ ...a, invoiceId: after.id })) })
          audit({ action: "PAYMENT_RECORDED", ...meta.tyrePayment(p), after: p, note: `Paid with ${tyreInvoiceLabel(after)}` })
        }
        return after
      }),
    update: (id: string, input: TyreInvoiceInput, reason?: string) =>
      tx(async () => {
        assertCan("tyres", "edit")
        const before = await tyreInvoices.get(id)
        if (!before) throw new NotFoundError("Tyre invoice", id)
        assertMonthEditable(before.date)
        const data = checkTyreInvoice(input, before)
        assertMonthEditable(data.date)
        // A financial change (date, vehicle, attribution, supplier, bill number, repair lines) needs a reason (17 Nov 2026).
        const changed = financialChanges(before, data)
        if (changed.length && deletionReasonError(reason, "correcting")) throw new Error(`Enter the reason for changing the ${changed.join(", ")} (at least 3 characters).`)
        if (input.payment) throw new Error("Payments are recorded on the vendor's page (Tyre → Vendor Purchases), not by editing the invoice.")
        // Payments already allocated stay as they were (never re-allocated by an edit): the invoice keeps its supplier and
        // its total never goes below what was paid against it.
        const pays = readCollection("tyre_payments").filter((p) => p.allocations.some((a) => a.invoiceId === id))
        if (pays.length && data.supplierId !== before.supplierId) throw new Error(`Payments to ${tyreMasterName(before.supplierId)} are recorded against this invoice, so its supplier can't be changed. Record the bill again under the right supplier instead.`)
        const paid = paidByInvoice(pays).get(id) ?? 0
        if (tyreTotals(data.items).grandTotal < paid) throw new Error(`${formatINR(paid)} has already been paid against this invoice, so its total can't go below that (new total ${formatINR(tyreTotals(data.items).grandTotal)}). Correct or delete the payment (Tyre → Payments) first if it was wrong.`)
        const after = await tyreInvoices.update(id, data)
        audit({ action: "UPDATED", ...meta.tyreInvoice(after), before, after, reason: reason?.trim() || undefined })
        return after
      }),
    /** The Owner and Dev only (delete), with a reason; the lines go with it. Restorable from the Audit Log. */
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("tyres", "delete")
        assertReason(reason)
        const before = await tyreInvoices.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        // An invoice that payments point at stays: delete (or correct) those payments first.
        const pays = readCollection("tyre_payments").filter((p) => p.allocations.some((a) => a.invoiceId === id))
        if (pays.length) throw new Error(`Payments are recorded against this invoice (${pays.map((p) => `${formatDate(p.date)} ${formatINR(settledOf(p))}`).join("; ")}), so it can't be deleted. Correct it with Edit, or delete those payments first (Tyre → Payments).`)
        await tyreInvoices.remove(id)
        audit({ action: "DELETED", ...meta.tyreInvoice(before), before, reason: reason.trim() })
      }),
  },

  /**
   * Payments to tyre suppliers: allocated to the supplier's invoices, the rest explicitly advance credit; advance is
   * applied later with `allocate`. Edited with `update`; deleted permanently with `remove` (Owner / Dev, with a reason).
   */
  tyrePayments: {
    list: tyrePayments.list,
    create: (input: TyrePaymentInput) =>
      tx(async () => {
        assertCan("tyres", "create")
        const data = checkTyrePayment(input)
        assertMonthEditable(data.date)
        assertAllocationMonths(data.allocations)
        const after = await tyrePayments.create(data)
        audit({ action: "PAYMENT_RECORDED", ...meta.tyrePayment(after), after })
        return after
      }),
    /**
     * Edit (tyres:edit; owner, 17 Nov 2026): date, total settled, mode, "Deduct TDS?" / %, reference, paid by, notes and
     * — only when sent — the allocations (explicit: never re-allocated by the API; unchanged when the same per invoice).
     * TDS and the amount paid are recalculated; the vendor, invoices and advance follow from the records. A financial
     * change (date, amount, mode, TDS, allocations) needs a reason. Month lock: the old and new date, and every invoice
     * whose allocation changes.
     */
    update: (id: string, input: Omit<TyrePaymentInput, "supplierId" | "allocations"> & { supplierId?: string; allocations?: { invoiceId: string; amount: number }[] }, reason?: string) =>
      tx(async () => {
        assertCan("tyres", "edit")
        const before = await tyrePayments.get(id)
        if (!before) throw new NotFoundError("Tyre payment", id)
        if (input.supplierId && input.supplierId !== before.supplierId) throw new Error("A payment's vendor can't be changed — delete it and record it again for the right vendor.")
        assertMonthEditable(before.date)
        const sent = input.allocations !== undefined
        const old = perInvoice(before.allocations)
        const next = sent ? perInvoice(cleanAllocations(input.allocations)) : old
        const same = next.size === old.size && [...next].every(([k, v]) => old.get(k) === v)
        const data = checkTyrePayment({ ...input, supplierId: before.supplierId, allocations: [...next].map(([invoiceId, amount]) => ({ invoiceId, amount })) }, before)
        if (same) data.allocations = before.allocations // unchanged: kept exactly as recorded
        assertMonthEditable(data.date)
        const touched = [...new Set([...old.keys(), ...next.keys()])].filter((k) => old.get(k) !== next.get(k))
        assertAllocationMonths(touched.map((invoiceId) => ({ invoiceId })))
        const changed = [
          data.date !== before.date && "date",
          settledOf(data) !== settledOf(before) && "amount",
          data.mode !== before.mode && "payment mode",
          (data.tdsRate ?? null) !== (before.tdsRate ?? null) && "TDS",
          !same && "allocations",
        ].filter(Boolean) as string[]
        if (changed.length && deletionReasonError(reason, "correcting")) throw new Error(`Enter the reason for changing the ${changed.join(", ")} (at least 3 characters).`)
        const after = await tyrePayments.update(id, data)
        audit({ action: "UPDATED", ...meta.tyrePayment(after), before, after, reason: reason?.trim() || undefined, note: changed.length ? `Payment corrected: ${changed.join(", ")}` : undefined })
        return after
      }),
    /** Apply a payment's advance credit to invoices of its supplier. Adds allocations; never changes existing ones. */
    allocate: (id: string, allocations: { invoiceId: string; amount: number }[]) =>
      tx(async () => {
        assertCan("tyres", "edit")
        const before = await tyrePayments.get(id)
        if (!before) throw new NotFoundError("Tyre payment", id)
        const add = (allocations ?? []).filter((a) => Number(a.amount) !== 0).map((a) => ({ invoiceId: a.invoiceId, amount: round2(Number(a.amount)) }))
        if (!add.length) throw new Error("Enter the amount to apply to at least one invoice")
        const owed = tyreOutstanding(before.supplierId)
        const left = unallocated(before)
        // Checked as a payment of the advance left (its own rules: amounts, invoices of this vendor, each within what it owes).
        const problem = paymentProblem({ date: before.date, amount: left, mode: before.mode, utr: before.utr, allocations: add, acceptAdvance: true }, todayISO(), (x) => owed.get(x)?.left, (x) => (owed.has(x) ? tyreInvoiceLabel(owed.get(x)!.invoice) : `Invoice ${x}`))
        if (problem) throw new Error(left <= 0 ? "This payment has no advance credit left to allocate." : problem.replace("are more than the payment", "are more than the advance left"))
        assertMonthEditable(before.date)
        assertAllocationMonths(add)
        const after = await tyrePayments.update(id, { allocations: [...before.allocations, ...add] })
        audit({ action: "UPDATED", ...meta.tyrePayment(after), before, after, note: `Advance applied: ${add.map((a) => `${formatINR(a.amount)} to ${tyreInvoiceLabel(owed.get(a.invoiceId)!.invoice)}`).join("; ")}` })
        return after
      }),
    /**
     * Delete permanently (owner, 17 Nov 2026 — replaces voiding): the Owner / Dev only, with a reason; month lock on the
     * payment's date and every bill it paid. The payment and its allocations go in one transaction with its DELETED
     * event (the full payment: allocations, TDS, reference) — the bills are owed again, its advance and TDS count
     * nowhere; every figure is calculated, so nothing else changes. A repeated delete finds nothing and records nothing.
     */
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("tyres", "delete")
        assertReason(reason)
        const before = await tyrePayments.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        assertAllocationMonths(before.allocations)
        await tyrePayments.remove(id)
        const bills = [...new Set(before.allocations.map((a) => a.invoiceId))].map((x) => readCollection("tyre_invoices").find((v) => v.id === x)).filter((v) => !!v).map((v) => tyreInvoiceLabel(v!))
        audit({ action: "DELETED", ...meta.tyrePayment(before), before, reason: reason.trim(), note: bills.length ? `Allocations removed: ${bills.join(", ")} owed again` : "No bill allocated: its advance credit is removed" })
      }),
  },

  adblueVehicles: {
    list: async () => {
      const ids = new Set((await adblue.list()).map((e) => e.vehicleId))
      return (await vehicles.list()).filter((v) => ids.has(v.id)).map((v) => ({ id: v.id, regNo: v.regNo }))
    },
  },

  /** Diesel loaded into the tanker's cargo. Amount = litres × rate; month lock; stock never below zero. */
  tankerLoads: {
    list: tankerLoads.list,
    create: (input: TankerLoadInput) =>
      tx(async () => {
        assertCan("diesel", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        const after = await tankerLoads.create(checkLoad(input))
        audit({ action: "CREATED", ...meta.load(after), after })
        return after
      }),
    update: (id: string, input: TankerLoadInput, reason?: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        const before = await tankerLoads.get(id)
        if (!before) throw new NotFoundError("Tanker load", id)
        if (before.opening) throw new Error("Opening stock can't be edited — correct it with a stock adjustment.")
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        const next = checkLoad(input, before)
        assertTankerStock(tankerRecords({ loads: readCollection("tanker_loads").map((l) => (l.id === id ? { ...l, ...next } : l)) }), [before.tankerId, next.tankerId])
        const after = await tankerLoads.update(id, next)
        audit({ action: "UPDATED", ...meta.load(after), before, after, reason })
        return after
      }),
    /**
     * POST /api/tankers/:id/opening-stock — litres already in one tanker on `date` (the fresh start's 31 Oct 2026
     * baseline). Owner / Dev; one per tanker; only a company tanker (never a stock pool); no records of that tanker
     * dated before it. Adds stock and its value, never a purchase (no station, not in Fuel Purchase Cost).
     * `value` (₹) is optional — 0 when unknown.
     */
    createOpening: (input: { tankerId: string; date: string; litres: number; value: number; notes: string }) =>
      tx(async () => {
        assertWorkspaceAdmin("record opening stock")
        ensureSeeded()
        assertTankerOpen(input.tankerId, "Choose the tanker")
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter the date of the opening stock")
        if (input.date > todayISO()) throw new Error("Opening stock can't be dated in the future.")
        if (!(input.litres > 0)) throw new Error("Opening stock must be greater than 0 L")
        if (!(input.value >= 0)) throw new Error("The stock value can't be negative")
        assertMonthEditable(input.date)
        const name = tankerName(input.tankerId)
        const r = tankerRecords()
        if (r.loads.some((l) => l.opening && tankerOf(l) === input.tankerId)) throw new Error(`${name} already has opening stock recorded. Delete it (with a reason) to record it again.`)
        const earlier = [
          ...r.loads.filter((l) => tankerOf(l) === input.tankerId),
          ...r.fills.filter((e) => isTankerFill(e) && tankerOf(e) === input.tankerId),
          ...r.external.filter((x) => tankerOf(x) === input.tankerId),
          ...(r.transfers ?? []).filter((t) => t.fromTankerId === input.tankerId || t.toTankerId === input.tankerId),
          ...(r.adjustments ?? []).filter((a) => a.tankerId === input.tankerId),
        ].find((x) => x.date < input.date)
        if (earlier) throw new Error(`${name} already has records before ${formatDate(input.date)} (${formatDate(earlier.date)}). Opening stock must come first — record it after the fresh start clears the old records.`)
        const litres = round2(input.litres)
        const amount = round2(input.value)
        const after = await tankerLoads.create({ tankerId: input.tankerId, date: input.date, stationId: "", opening: true, invoiceNo: "", litres, rate: litres ? round2(amount / litres) : 0, amount, notes: input.notes.trim() })
        audit({ action: "CREATED", ...meta.load(after), after })
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const before = await tankerLoads.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        assertTankerStock(tankerRecords({ loads: readCollection("tanker_loads").filter((l) => l.id !== id) }), [before.tankerId])
        await tankerLoads.remove(id)
        audit({ action: "DELETED", ...meta.load(before), before, reason })
      }),
  },

  /** Diesel dispensed from a tanker to external (non-ERP) vehicles. Registered vehicles use diesel.create with the tanker source. */
  tankerDispenses: {
    list: tankerDispenses.list,
    create: (input: TankerDispenseInput) =>
      tx(async () => {
        assertCan("diesel", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        const d = checkExternal(input)
        assertTankerStock(tankerRecords({ external: [...readCollection("tanker_dispenses"), { ...d, id: "new", createdAt: new Date().toISOString() }] }), [d.tankerId])
        const after = await tankerDispenses.create(d)
        audit({ action: "CREATED", ...meta.dispense(after), after })
        return after
      }),
    update: (id: string, input: TankerDispenseInput, reason?: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        const before = await tankerDispenses.get(id)
        if (!before) throw new NotFoundError("Tanker dispense", id)
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        const d = checkExternal(input, before)
        assertTankerStock(tankerRecords({ external: readCollection("tanker_dispenses").map((x) => (x.id === id ? { ...x, ...d } : x)) }), [before.tankerId, d.tankerId])
        const after = await tankerDispenses.update(id, d)
        audit({ action: "UPDATED", ...meta.dispense(after), before, after, reason })
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const before = await tankerDispenses.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        await tankerDispenses.remove(id)
        audit({ action: "DELETED", ...meta.dispense(before), before, reason })
      }),
  },

  /**
   * The company tankers (answer 24) — a master list like vehicles: added, edited, archived and restored,
   * never deleted (their history stays in every report). Registrations are unique. Needs `vehicles:edit`.
   */
  tankers: {
    list: tankers.list,
    get: tankers.get,
    create: (input: TankerInput) =>
      tx(async () => {
        ensureSeeded()
        assertCan("vehicles", "edit")
        const after = await tankers.create({ ...checkTanker(input), status: "ACTIVE" })
        audit({ action: "CREATED", ...meta.tanker(after), after })
        return after
      }),
    update: (id: string, input: TankerInput) =>
      tx(async () => {
        assertCan("vehicles", "edit")
        const before = await tankers.get(id)
        if (!before) throw new NotFoundError("Tanker", id)
        const after = await tankers.update(id, checkTanker(input, id))
        audit({ action: "UPDATED", ...meta.tanker(after), before, after })
        return after
      }),
    /** Soft delete: its loads, dispenses and ledgers stay in every report; it leaves the pickers. */
    archive: (id: string) => tx(() => setTankerStatus(id, "ARCHIVED")),
    restore: (id: string) => tx(() => setTankerStatus(id, "ACTIVE")),
  },

  /** Diesel moved between tankers — never a purchase. Month lock; neither tanker's stock may go below zero. */
  tankerTransfers: {
    list: tankerTransfers.list,
    create: (input: TankerTransferInput) =>
      tx(async () => {
        assertCan("diesel", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        const t = checkTransfer(input)
        assertTankerStock(tankerRecords({ transfers: [...readCollection("tanker_transfers"), { ...t, id: "new", createdAt: new Date().toISOString() }] }), [t.fromTankerId, t.toTankerId])
        const after = await tankerTransfers.create(t)
        audit({ action: "CREATED", ...meta.transfer(after), after })
        return after
      }),
    /** Correct a transfer (owner, 18 Nov 2026: every role that may add one may correct it; deleting stays Owner / Dev). */
    update: (id: string, input: TankerTransferInput, reason?: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        const before = await tankerTransfers.get(id)
        if (!before) throw new NotFoundError("Tanker transfer", id)
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        const next = checkTransfer(input, before)
        assertTankerStock(tankerRecords({ transfers: readCollection("tanker_transfers").map((t) => (t.id === id ? { ...t, ...next } : t)) }), [before.fromTankerId, before.toTankerId, next.fromTankerId, next.toTankerId])
        const after = await tankerTransfers.update(id, next)
        audit({ action: "UPDATED", ...meta.transfer(after), before, after, reason })
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const before = await tankerTransfers.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        assertTankerStock(tankerRecords({ transfers: readCollection("tanker_transfers").filter((t) => t.id !== id) }), [before.fromTankerId, before.toTankerId])
        await tankerTransfers.remove(id)
        audit({ action: "DELETED", ...meta.transfer(before), before, reason })
      }),
  },

  /**
   * Corrections of one tanker's stock (dip readings, leaks) — + adds, − removes litres, with a mandatory
   * reason. Needs `diesel:edit`; month lock; stock never below zero. Never a purchase.
   */
  tankerAdjustments: {
    list: tankerAdjustments.list,
    create: (input: TankerAdjustmentInput) =>
      tx(async () => {
        ensureSeeded()
        assertCan("diesel", "edit")
        assertMonthEditable(input.date)
        const a = checkAdjustment(input)
        assertTankerStock(tankerRecords({ adjustments: [...readCollection("tanker_adjustments"), { ...a, id: "new", createdAt: new Date().toISOString() }] }), [a.tankerId])
        const after = await tankerAdjustments.create(a)
        audit({ action: "CREATED", ...meta.adjustment(after), after, reason: a.reason })
        return after
      }),
    /** Correct an adjustment — tanker, date, ± litres, its reason (owner, 18 Nov 2026; deleting stays Owner / Dev). */
    update: (id: string, input: TankerAdjustmentInput, changeReason?: string) =>
      tx(async () => {
        assertCan("diesel", "edit")
        const before = await tankerAdjustments.get(id)
        if (!before) throw new NotFoundError("Tanker stock adjustment", id)
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        const next = checkAdjustment(input, before)
        assertTankerStock(tankerRecords({ adjustments: readCollection("tanker_adjustments").map((a) => (a.id === id ? { ...a, ...next } : a)) }), [before.tankerId, next.tankerId])
        const after = await tankerAdjustments.update(id, next)
        audit({ action: "UPDATED", ...meta.adjustment(after), before, after, reason: changeReason })
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("diesel", "delete")
        assertReason(reason)
        const before = await tankerAdjustments.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        assertTankerStock(tankerRecords({ adjustments: readCollection("tanker_adjustments").filter((a) => a.id !== id) }), [before.tankerId])
        await tankerAdjustments.remove(id)
        audit({ action: "DELETED", ...meta.adjustment(before), before, reason })
      }),
  },

  /**
   * /api/adblue-vendors — the AdBlue vendor master (owner, 16 Nov 2026), for bulk and direct purchases. Never deleted:
   * archived and restored (an archived vendor takes no new purchase; its stock can still be drawn). Names are unique
   * (spaces / case ignored). The default rate per litre only pre-fills a purchase. Owner, Dev and Employee; the AdBlue
   * profiles read the list and pick existing vendors.
   */
  adblueVendors: {
    list: adblueVendors.list,
    create: (input: AdBlueVendorInput) =>
      tx(async () => {
        ensureSeeded()
        return createVendor(input)
      }),
    update: (id: string, input: AdBlueVendorInput) =>
      tx(async () => {
        assertVendorAdmin("edit")
        const before = await adblueVendors.get(id)
        if (!before) throw new NotFoundError("AdBlue vendor", id)
        const after = await adblueVendors.update(id, checkVendor(input, id))
        audit({ action: "UPDATED", ...meta.adblueVendor(after), before, after })
        return after
      }),
    archive: (id: string) => tx(() => setVendorStatus(id, "ARCHIVED")),
    restore: (id: string) => tx(() => setVendorStatus(id, "ACTIVE")),
  },

  /** AdBlue bulk purchases into inventory. Month lock as for diesel; stock never below zero. */
  adbluePurchases: {
    list: adbluePurchases.list,
    /**
     * POST /api/adblue/opening-stock — go-live opening (owner, 3 Nov 2026; reverses the 31 Oct removal), Owner / Dev:
     * AdBlue already on hand when records begin, with its value. One in the workspace; refused when any AdBlue purchase
     * or stock draw is dated before it. It is stock and value (weighted average), never "AdBlue Purchased" (domain:
     * purchasedIn, vendorAnalytics, inventoryLedger.openingStock). Not editable: delete with a reason and record again.
     */
    createOpening: (input: { date: string; litres: number; value: number; notes: string }) =>
      tx(async () => {
        assertWorkspaceAdmin("record AdBlue opening stock")
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter the date of the opening stock")
        if (input.date > todayISO()) throw new Error("Opening stock can't be dated in the future.")
        if (!(input.litres > 0)) throw new Error("Opening stock must be greater than 0 L")
        if (!(input.value > 0)) throw new Error("Enter the value of the stock on hand — every later draw is costed from it")
        assertMonthEditable(input.date)
        const purchases = readCollection("adblue_purchases")
        if (purchases.some((p) => p.opening)) throw new Error("AdBlue opening stock is already recorded. Delete it (with a reason) to record it again.")
        const earlier = [...purchases, ...stockDraws(readCollection("adblue_entries"))].find((x) => x.date < input.date)
        if (earlier) throw new Error(`AdBlue already has records before ${formatDate(input.date)} (${formatDate(earlier.date)}). Opening stock must come first.`)
        const litres = round2(input.litres)
        const value = round2(input.value)
        const after = await adbluePurchases.create({ date: input.date, vendorName: "", product: "Opening stock", buckets: 1, litresPerBucket: litres, totalLitres: litres, pricePerBucket: value, totalCost: value, invoiceNo: "", notes: input.notes.trim(), opening: true })
        audit({ action: "CREATED", ...meta.adbluePurchase(after), after })
        return after
      }),
    create: (input: AdBluePurchaseInput) =>
      tx(async () => {
        assertCan("adblue", "create")
        ensureSeeded()
        assertMonthEditable(input.date)
        const vendor = (await resolveVendor(input, null))!
        const data = purchaseTotals(input, vendor)
        const pay = purchasePayment({ ...input, payment: input.payment && { ...input.payment, date: input.payment.date || input.date } }, purchaseValue(data), vendor.id, false) // checked before anything is saved
        const after = await adbluePurchases.create(data)
        audit({ action: "CREATED", ...meta.adbluePurchase(after), after })
        if (pay) {
          // Saved with the purchase (same transaction): allocated to it — Fully or Partially Paid.
          const p = await adbluePayments.create({ ...pay, allocations: pay.allocations.map((a) => ({ ...a, purchaseId: after.id })) })
          audit({ action: "PAYMENT_RECORDED", ...meta.adbluePayment(p), after: p, note: `Paid with ${abPurchaseLabel(after)}` })
        }
        return after
      }),
    update: (id: string, input: AdBluePurchaseInput, reason?: string) =>
      tx(async () => {
        assertCan("adblue", "edit")
        assertChangeAdBluePurchase("edit")
        const before = await adbluePurchases.get(id)
        if (!before) throw new NotFoundError("AdBlue purchase", id)
        if (before.opening) throw new Error("Opening stock can't be edited.")
        assertMonthEditable(before.date)
        assertMonthEditable(input.date)
        const next = purchaseTotals(input, (await resolveVendor(input, before.adblueVendorId))!, before)
        // Payments already allocated stay as they were: the purchase keeps its vendor and its value never goes below what was paid.
        const paid = paidByPurchase(readCollection("adblue_payments")).get(id) ?? 0
        if (paid > 0 && next.adblueVendorId !== before.adblueVendorId) throw new Error(`Payments to ${before.vendorName} are allocated to this purchase, so its vendor can't be changed. Delete or re-allocate those payments first.`)
        if (purchaseValue(next) < paid) throw new Error(`${formatINR(paid)} has already been paid against this purchase, so its value can't go below that (new value ${formatINR(purchaseValue(next))}). Correct or delete the payment first.`)
        assertStock(readCollection("adblue_purchases").map((p) => (p.id === id ? { ...p, ...next } : p)), readCollection("adblue_entries"))
        // A new payment for what is still owed (checked before anything is saved). Existing payments stay as they are.
        const pay = purchasePayment(input, Math.max(0, round2(purchaseValue(next) - paid)), next.adblueVendorId, true)
        if (pay) assertAbAllocationMonths([{ purchaseId: id }])
        // The purchase (the stock batch) is rewritten only when its own fields change — never for a payment alone.
        const changed = PURCHASE_FIELDS.some((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify((before as unknown as Record<string, unknown>)[k] ?? (k === "gstRate" ? 0 : null)))
        let after = before
        if (changed) {
          after = await adbluePurchases.update(id, next)
          audit({ action: "UPDATED", ...meta.adbluePurchase(after), before, after, reason })
        }
        if (pay) {
          const p = await adbluePayments.create({ ...pay, allocations: pay.allocations.map((a) => ({ ...a, purchaseId: id })) })
          audit({ action: "PAYMENT_RECORDED", ...meta.adbluePayment(p), after: p, note: `Paid from Edit Purchase · ${abPurchaseLabel(after)}${p.allocations[0].amount < abSettled(p) ? ` · ${formatINR(round2(abSettled(p) - p.allocations[0].amount))} advance credit` : ""}` })
        }
        if (!changed && !pay) return before
        return after
      }),
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertCan("adblue", "delete")
        assertChangeAdBluePurchase("delete")
        assertReason(reason)
        const before = await adbluePurchases.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        const pays = readCollection("adblue_payments").filter((p) => p.allocations.some((a) => a.purchaseId === id))
        if (pays.length) throw new Error(`Payments are allocated to this purchase (${pays.map((p) => `${formatDate(p.date)} ${formatINR(abSettled(p))}`).join("; ")}), so it can't be deleted. Delete or re-allocate those payments first.`)
        assertStock(readCollection("adblue_purchases").filter((p) => p.id !== id), readCollection("adblue_entries"))
        await adbluePurchases.remove(id)
        audit({ action: "DELETED", ...meta.adbluePurchase(before), before, reason })
      }),
  },

  /**
   * Payments to AdBlue vendors (owner, 18 Nov 2026): allocated to the vendor's bulk purchases, the rest explicitly advance
   * credit (applied later with `allocate`). The Owner, Dev and Employee; delete (permanent) the Owner / Dev. Never touches
   * stock. Calculations: domain/adblue-payments.ts.
   */
  adbluePayments: {
    list: async () => {
      assertAdBluePayments("view")
      return adbluePayments.list()
    },
    create: (input: AdBluePaymentInput) =>
      tx(async () => {
        assertAdBluePayments("create")
        const data = checkAdBluePayment(input)
        assertMonthEditable(data.date)
        assertAbAllocationMonths(data.allocations)
        const after = await adbluePayments.create(data)
        audit({ action: "PAYMENT_RECORDED", ...meta.adbluePayment(after), after })
        return after
      }),
    /**
     * Edit: date, total settled, mode, "Deduct TDS?" / %, reference, paid by, notes and — only when sent — the
     * allocations (never re-allocated by the API; unchanged per purchase = kept as recorded). A financial change (date,
     * amount, mode, TDS, allocations) needs a reason. Month lock: old and new date, and every purchase whose allocation
     * changes. The vendor never changes.
     */
    update: (id: string, input: Omit<AdBluePaymentInput, "vendorId" | "allocations"> & { vendorId?: string; allocations?: { purchaseId: string; amount: number }[] }, reason?: string) =>
      tx(async () => {
        assertAdBluePayments("edit")
        const before = await adbluePayments.get(id)
        if (!before) throw new NotFoundError("AdBlue payment", id)
        if (input.vendorId && input.vendorId !== before.vendorId) throw new Error("A payment's vendor can't be changed — delete it and record it again for the right vendor.")
        assertMonthEditable(before.date)
        const old = abPerPurchase(before.allocations)
        const next = input.allocations !== undefined ? abPerPurchase(cleanAbAllocations(input.allocations)) : old
        const same = next.size === old.size && [...next].every(([k, v]) => old.get(k) === v)
        const data = checkAdBluePayment({ ...input, vendorId: before.vendorId, allocations: [...next].map(([purchaseId, amount]) => ({ purchaseId, amount })) }, before)
        if (same) data.allocations = before.allocations // unchanged: kept exactly as recorded
        assertMonthEditable(data.date)
        assertAbAllocationMonths([...new Set([...old.keys(), ...next.keys()])].filter((k) => old.get(k) !== next.get(k)).map((purchaseId) => ({ purchaseId })))
        const changed = [
          data.date !== before.date && "date",
          abSettled(data) !== abSettled(before) && "amount",
          data.mode !== before.mode && "payment mode",
          (data.tdsRate ?? null) !== (before.tdsRate ?? null) && "TDS",
          !same && "allocations",
        ].filter(Boolean) as string[]
        if (changed.length && deletionReasonError(reason, "correcting")) throw new Error(`Enter the reason for changing the ${changed.join(", ")} (at least 3 characters).`)
        const after = await adbluePayments.update(id, data)
        audit({ action: "UPDATED", ...meta.adbluePayment(after), before, after, reason: reason?.trim() || undefined, note: changed.length ? `Payment corrected: ${changed.join(", ")}` : undefined })
        return after
      }),
    /** Apply a payment's advance credit to purchases of its vendor. Adds allocations; never changes existing ones. */
    allocate: (id: string, allocations: { purchaseId: string; amount: number }[]) =>
      tx(async () => {
        assertAdBluePayments("edit")
        const before = await adbluePayments.get(id)
        if (!before) throw new NotFoundError("AdBlue payment", id)
        const add = cleanAbAllocations(allocations).map((a) => tagAllocation({ purchaseId: a.purchaseId, amount: round2(a.amount) }))
        if (!add.length) throw new Error("Enter the amount to apply to at least one purchase")
        const owed = adblueOutstanding(before.vendorId)
        const left = abUnallocated(before)
        const problem = abPaymentProblem({ date: before.date, amount: left, mode: before.mode, utr: before.utr, allocations: add, acceptAdvance: true }, todayISO(), (x) => owed.get(x)?.left, (x) => (owed.has(x) ? abPayableLabel(owed.get(x)!.payable) : `Purchase ${x}`))
        if (problem) throw new Error(left <= 0 ? "This payment has no advance credit left to apply." : problem.replace("are more than the payment", "are more than the advance left"))
        assertMonthEditable(before.date)
        assertAbAllocationMonths(add)
        const after = await adbluePayments.update(id, { allocations: [...before.allocations, ...add] })
        audit({ action: "UPDATED", ...meta.adbluePayment(after), before, after, note: `Advance applied: ${add.map((a) => `${formatINR(a.amount)} to ${abPayableLabel(owed.get(a.purchaseId)!.payable)}`).join("; ")}` })
        return after
      }),
    /**
     * Apply a vendor's advance credit (its payments' unallocated parts) to its outstanding purchases — the vendor page's
     * Apply Advance. No payment is created: each requested amount is taken from the vendor's payments that hold advance,
     * oldest first (payments in a month the role can't change are skipped), and appended to those payments as
     * allocations — one transaction, one UPDATED audit event per payment used.
     */
    applyAdvance: (vendorId: string, allocations: { purchaseId: string; amount: number }[]) =>
      tx(async () => {
        assertAdBluePayments("edit")
        const add = cleanAbAllocations(allocations).map((a) => ({ purchaseId: a.purchaseId, amount: round2(a.amount) }))
        if (!add.length) throw new Error("Enter the amount to apply to at least one purchase")
        // Never a try / catch around assertMonthEditable: on the server, reading month_locks may first ask for the data (NeedData).
        const locks = readCollection("month_locks")
        const open = (date: string) => canEditMonth(currentRole(), date.slice(0, 7), todayISO(), locks)
        const sources = readCollection("adblue_payments")
          .filter((p) => p.vendorId === vendorId && abUnallocated(p) > 0)
          .sort((x, y) => x.date.localeCompare(y.date) || x.createdAt.localeCompare(y.createdAt))
        const usable = sources.filter((p) => open(p.date))
        const available = round2(usable.reduce((t, p) => t + abUnallocated(p), 0))
        const owed = adblueOutstanding(vendorId)
        const problem = abPaymentProblem({ date: todayISO(), amount: available, mode: "NEFT", utr: "advance", allocations: add, acceptAdvance: true }, todayISO(), (x) => owed.get(x)?.left, (x) => (owed.has(x) ? abPayableLabel(owed.get(x)!.payable) : `Purchase ${x}`))
        if (problem) throw new Error(available <= 0 ? (sources.length ? "The advance credit with this vendor is on payments in a locked month." : "This vendor has no advance credit to apply.") : problem.replace(/are more than the payment \(₹[\d.]+\)/, `are more than the advance credit available (₹${available.toFixed(2)})`))
        assertAbAllocationMonths(add)
        // Take each purchase's amount from the oldest payments holding advance.
        const left = new Map(usable.map((p) => [p.id, abUnallocated(p)]))
        const extra = new Map<string, { purchaseId: string; amount: number }[]>()
        for (const a of add) {
          let need = a.amount
          for (const p of usable) {
            if (need <= 0) break
            const take = round2(Math.min(need, left.get(p.id)!))
            if (take <= 0) continue
            left.set(p.id, round2(left.get(p.id)! - take))
            extra.set(p.id, [...(extra.get(p.id) ?? []), tagAllocation({ purchaseId: a.purchaseId, amount: take })])
            need = round2(need - take)
          }
        }
        const updated: AdBluePayment[] = []
        for (const p of usable.filter((x) => extra.has(x.id))) {
          const more = extra.get(p.id)!
          const after = await adbluePayments.update(p.id, { allocations: [...p.allocations, ...more] })
          audit({ action: "UPDATED", ...meta.adbluePayment(after), before: p, after, note: `Advance applied: ${more.map((m) => `${formatINR(m.amount)} to ${abPayableLabel(owed.get(m.purchaseId)!.payable)}`).join("; ")}` })
          updated.push(after)
        }
        return updated
      }),
    /**
     * Delete permanently: the Owner / Dev only, with a reason; month lock on the payment's date and every purchase it
     * paid. The payment and its allocations go in one transaction with the DELETED event (the full payment: allocations,
     * TDS, reference) — the purchases are owed again; nothing else is stored, so every figure recalculates.
     */
    remove: (id: string, reason: string) =>
      tx(async () => {
        assertAdBluePayments("delete")
        assertReason(reason)
        const before = await adbluePayments.get(id)
        if (!before) return
        assertMonthEditable(before.date)
        assertAbAllocationMonths(before.allocations)
        await adbluePayments.remove(id)
        const all = payablesOf(readCollection("adblue_purchases"), readCollection("adblue_entries"))
        const bills = [...new Set(before.allocations.map((a) => a.purchaseId))].map((x) => all.find((p) => p.id === x)).filter((p) => !!p).map((p) => abPayableLabel(p!))
        audit({ action: "DELETED", ...meta.adbluePayment(before), before, reason: reason.trim(), note: bills.length ? `Allocations removed: ${bills.join(", ")} owed again` : "No purchase allocated: its advance credit is removed" })
      }),
  },

  invoices: {
    list: invoices.list,
    get: invoices.get,
    /**
     * POST /api/invoices/opening — go-live opening (owner, 3 Nov 2026), Owner / Dev: an invoice still unpaid when
     * records begin, with its original number, invoice and due dates, and the amount outstanding. No lines, no tax (they
     * belong to the old books). Issued at once, so receipts settle it and receivables / aging include it; revenue comes
     * from trips, so it is never revenue of the period. Not editable: cancel it (no receipts) and enter it again.
     */
    createOpening: (input: { customerId: string; invoiceNo: string; date: string; dueDate: string; outstanding: number; notes: string }) =>
      tx(async () => {
        assertWorkspaceAdmin("record opening invoices")
        assertCan("invoices", "create")
        const customer = readCollection("customers").find((c) => c.id === input.customerId)
        if (!customer) throw new NotFoundError("Customer", input.customerId)
        const invoiceNo = input.invoiceNo.trim()
        if (!invoiceNo) throw new Error("Enter the invoice number")
        if (readCollection("invoices").some((i) => i.invoiceNo.toLowerCase() === invoiceNo.toLowerCase())) throw new Error(`Invoice ${invoiceNo} already exists`)
        for (const d of [input.date, input.dueDate]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Enter the invoice date and due date")
        if (input.date > todayISO()) throw new Error("An opening invoice can't be dated in the future.")
        if (input.dueDate < input.date) throw new Error("The due date can't be before the invoice date")
        if (!(input.outstanding > 0)) throw new Error("Enter the amount still unpaid")
        assertMonthEditable(input.date)
        const amount = round2(input.outstanding)
        const after = await invoices.create({ invoiceNo, companyCode: customer.companyCode, customerId: customer.id, date: input.date, dueDate: input.dueDate, periodFrom: input.date, periodTo: input.date, lines: [], subtotal: amount, taxType: "CGST_SGST", taxRate: 0, cgst: 0, sgst: 0, igst: 0, total: amount, status: "ISSUED", notes: input.notes.trim(), opening: true })
        audit({ action: "CREATED", ...meta.invoice(after), after, note: `Opening invoice: ${formatINR(amount)} unpaid at go-live` })
        return after
      }),
    /** POST /api/invoices — builds lines from trips, numbers it, locks the trips. */
    create: (input: InvoiceDraftInput) =>
      tx(async () => {
        assertCan("invoices", "create")
        ensureSeeded()
        const settings = settingsOrThrow()
        const customer = readCollection("customers").find((c) => c.id === input.customerId)
        if (!customer) throw new NotFoundError("Customer", input.customerId)
        const allTrips = readCollection("trips")
        const clash = allTrips.find((t) => input.tripIds.includes(t.id) && t.invoiceId)
        if (clash) throw new Error(`Trip ${clash.tripNo} is already invoiced`)
        const draft = buildInvoice(input, { customer, trips: allTrips, vehicles: readCollection("vehicles"), settings })
        if (!draft.lines.length) throw new Error("Add at least one trip or line")
        const prefix = `${companyPrefix(customer.companyCode)}/${fyLabel(input.date)}/`
        const seq = nextSeq(readCollection("invoices").map((i) => i.invoiceNo), prefix)
        const invoice = await invoices.create({ ...draft, invoiceNo: `${prefix}${String(seq).padStart(3, "0")}` })
        const ids = new Set(input.tripIds)
        writeCollection(
          "trips",
          readCollection("trips").map((t) => (ids.has(t.id) ? { ...t, invoiceId: invoice.id } : t))
        )
        audit({ action: "CREATED", ...meta.invoice(invoice), after: invoice })
        return invoice
      }),
    issue: (id: string) =>
      tx(async () => {
        assertCan("invoices", "edit")
        const before = await invoices.get(id)
        const after = await invoices.update(id, { status: "ISSUED" })
        audit({ action: "UPDATED", ...meta.invoice(after), before, after })
        return after
      }),
    /** Cancelling releases trips so they can be re-billed. */
    cancel: (id: string, reason?: string) =>
      tx(async () => {
        assertCan("invoices", "edit")
        const paid = settlementIndex(readCollection("payments")).get(id) ?? 0
        if (paid > 0) throw new Error("Invoice has receipts allocated. Reverse the receipts first.")
        const before = await invoices.get(id)
        const inv = await invoices.update(id, { status: "CANCELLED" })
        writeCollection(
          "trips",
          readCollection("trips").map((t) => (t.invoiceId === id ? { ...t, invoiceId: null } : t))
        )
        audit({ action: "UPDATED", ...meta.invoice(inv), before, after: inv, reason })
        return inv
      }),
  },

  payments: {
    list: payments.list,
    get: payments.get,
    remove: (id: string, reason: string) => tx(() => removePayment(id, reason)),
    create: (input: Omit<NewEntity<Payment>, "paymentNo">) => tx(() => createPayment(input)),
  },

  settings: {
    async get() {
      await latency()
      return settingsOrThrow()
    },
    update: (patch: Partial<Settings>) =>
      tx(async () => {
        // Vehicle types are also added inline from the vehicle forms (vehicles:edit); everything else needs settings:edit.
        if (!(Object.keys(patch).every((k) => k === "vehicleTypes") && can(currentRole(), "vehicles", "edit"))) assertCan("settings", "edit")
        await latency()
        const before = settingsOrThrow()
        const next = { ...before, ...patch }
        writeSettings(next)
        audit({ action: "UPDATED", module: "Settings", recordType: "Settings", recordId: "settings", label: "Business settings", before, after: next })
        return next
      }),
  },

  admin: {
    /**
     * The full backup (all collections and settings; not the audit log). On the shared database it is a read-only
     * export for Dev (system administration) — also the rollback path: it restores into one browser.
     */
    async exportBackup(): Promise<BackupFile> {
      await latency()
      if (requestScope() && !can(currentRole(), "system")) throw new Error("Only Dev can export the shared database.")
      if (!can(currentRole(), "settings")) throw new Error("Only the Owner or Dev can export a backup.")
      return exportBackup()
    },
    /**
     * Go-live setup (Owner / Dev): the three company tankers — JIO (TN70AX9480), Office (KA53C0538), Mini (KA51AF1429)
     * — each with its tanker vehicle record. Adds only what is missing (matched by registration); never renames or
     * moves anything. Vehicle details the books don't record (make, model, type, year) stay blank — never invented.
     */
    setupTankerMasters: () =>
      tx(async () => {
        assertDataAdmin("set up the tanker masters")
        const clean = cleanWorkspace(new Date())
        let added = 0
        for (const station of clean.fuel_stations)
          if (!readCollection("fuel_stations").some((s) => s.id === station.id)) throw new Error("The internal tanker source (dv_tanker) is missing — the database schema isn't complete.")
        // The confirmed ids (CONFIRMED_TANKERS, same as the fuel import's TANKER_MASTER): tnk_tn70ax9480, veh_tn70ax9480…
        const now = new Date().toISOString()
        for (const t of clean.tankers) {
          const wanted = clean.vehicles.find((v) => v.id === t.vehicleId)!
          let vehicle = readCollection("vehicles").find((v) => normReg(v.regNo) === t.regNo)
          if (!vehicle) {
            vehicle = { ...wanted, createdAt: now, updatedAt: now }
            writeCollection("vehicles", [...readCollection("vehicles"), vehicle])
            audit({ action: "CREATED", ...meta.vehicle(vehicle), after: vehicle, note: `Tanker vehicle ${t.name} (go-live setup)` })
            added++
          }
          if (!readCollection("tankers").some((x) => normReg(x.regNo) === t.regNo || x.id === t.id)) {
            const tanker: Tanker = { ...t, vehicleId: readCollection("tankers").some((x) => x.vehicleId === vehicle!.id) ? null : vehicle.id, createdAt: now, updatedAt: now }
            writeCollection("tankers", [...readCollection("tankers"), tanker])
            audit({ action: "CREATED", ...meta.tanker(tanker), after: tanker, note: "Company tanker (go-live setup)" })
            added++
          }
        }
        return added
      }),
    /**
     * Replaces all data with a backup or prepared import file — Owner and Dev only (it overwrites everything).
     * Validated first; atomic (`tx`): if it doesn't fit in storage or anything fails, the old data stays.
     */
    restoreBackup: (raw: unknown, fileName: string) =>
      tx(async () => {
        await latency()
        assertNotShared("Restore from file")
        assertDataAdmin("restore a backup")
        const file = parseBackup(raw)
        restoreBackup(file)
        const counts = (["customers", "vehicles", "fuel_stations", "diesel_entries", "tanker_loads", "payments"] as const).map((k) => `${(file.collections[k] ?? []).length} ${k.replace("_", " ")}`).join(", ")
        audit({ action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: `All data replaced from ${fileName}${file.label ? ` (${file.label})` : ""}: ${counts}` })
        return file
      }),
    resetDemoData: () =>
      tx(async () => {
        await latency()
        assertNotShared("Reset to demo data")
        assertDataAdmin("reset the data")
        loadDemoData()
        audit({ action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: "All data replaced with demo data (Settings → Reset)" })
      }),
    clearAllData: () =>
      tx(async () => {
        await latency()
        assertNotShared("Clear all data")
        assertDataAdmin("clear the data")
        loadEmptyWorkspace()
        audit({ action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: "All data cleared to an empty workspace (Settings → Clear)" })
      }),
  },

  /**
   * Audit trail — read-only; events are only ever appended by the writes above.
   * GET /api/audit-events (Owner and Dev), GET /api/audit-events?recordId=… and the edited-record list.
   */
  audit: {
    /** The central Audit Log, newest first — every role with the `audit` permission (Owner, Dev, Employee). */
    async list(): Promise<AuditLogRow[]> {
      await latency()
      if (!can(currentRole(), "audit")) throw new Error("Your role can't view the audit log.")
      ensureSeeded()
      const ids = new Map<string, Set<string>>()
      const exists = (e: AuditEvent) => {
        const key = RECORD_COLLECTION[e.recordType]
        if (!key) return null
        if (!ids.has(key)) ids.set(key, new Set(readCollection(key).map((r) => r.id)))
        return ids.get(key)!.has(e.recordId)
      }
      const reviews = new Map(readAuditReviews().map((r) => [r.eventId, { at: r.at, actor: r.actor }]))
      const restored = restorations(visibleEvents())
      return newestFirst(visibleEvents()).map((e) => ({
        ...e,
        recordExists: exists(e),
        review: reviews.get(e.id) ?? null,
        restoredBy: restored.get(e.id) ?? null,
        restorableType: e.action === "DELETED" && !!RESTORABLE[e.recordType],
      }))
    },
    /** Deletion events the Owner hasn't reviewed yet (the Audit Log badge). Owner only. */
    async unreviewedDeletions() {
      await latency()
      if (!hasOwnerAuthority(currentRole())) throw new Error("Only the Owner or Dev can review deletions.")
      return unreviewedDeletions(visibleEvents(), readAuditReviews()).length
    },
    /**
     * Owner marks deletion events as reviewed. Only DELETED events count; already-reviewed ones are
     * skipped, so a retry or double click never double-counts. Events themselves are never changed.
     */
    markReviewed: (eventIds: string[]) =>
      tx(async () => {
        if (!hasOwnerAuthority(currentRole())) throw new Error("Only the Owner or Dev can review deletions.")
        const reviewed = new Set(readAuditReviews().map((r) => r.eventId))
        const open = new Set(visibleEvents().filter((e) => e.action === "DELETED" && !reviewed.has(e.id)).map((e) => e.id)) // restored deletions can be marked too
        const ids = [...new Set(eventIds)].filter((id) => open.has(id))
        if (ids.length) appendAuditReviews(ids.map((eventId) => ({ eventId, at: new Date().toISOString(), actor: currentActor() })))
        return ids.length
      }),
    /** Dry run of a restore (nothing written): what it would change, or why it can't happen. Owner only. */
    async checkRestore(eventId: string): Promise<{ ok: true; note: string; duplicate: { id: string; label: string } | null } | { ok: false; reason: string }> {
      await latency()
      try {
        const plan = planRestore(eventId)
        return { ok: true, note: plan.note, duplicate: plan.duplicate }
      } catch (err) {
        if (err instanceof NeedData) throw err // server: load the data and run again — never a "can't restore" answer
        return { ok: false, reason: err instanceof Error ? err.message : "This record can't be restored." }
      }
    },
    /**
     * Restore / Push Back — puts a deleted record back with its original id, values and createdAt,
     * from the DELETED event's snapshot. The deletion event stays; a new RESTORED event points to it.
     * Atomic (`tx`), Owner only, mandatory reason, every safety check of `planRestore`. A possible
     * duplicate must be confirmed explicitly (`confirmNotDuplicate`). A second restore of the same
     * deletion is refused, so retries never apply it twice.
     */
    restoreDeleted: (eventId: string, reason: string, opts: { confirmNotDuplicate?: boolean } = {}) =>
      tx(async () => {
        if (!hasOwnerAuthority(currentRole())) throw new Error("Only the Owner or Dev can restore deleted records.")
        const reasonError = deletionReasonError(reason, "restoring")
        if (reasonError) throw new Error(reasonError)
        const plan = planRestore(eventId)
        if (plan.duplicate && !opts.confirmNotDuplicate) throw new PossibleDuplicateError(plan.duplicate)
        const deletion = visibleEvents().find((x) => x.id === eventId)!
        writeCollection(plan.key, [...readCollection(plan.key), plan.record] as never)
        if (plan.key === "diesel_entries") {
          // The vehicle's "last known km" cache, as when the fill was first saved.
          const d = plan.record as unknown as DieselEntry
          const v = readCollection("vehicles").find((x) => x.id === d.vehicleId)
          if (v && d.odometerKm !== null && d.odometerKm > v.odometerKm) await vehicles.update(v.id, { odometerKm: d.odometerKm })
        }
        audit({
          action: "RESTORED",
          module: deletion.module,
          recordType: deletion.recordType,
          recordId: deletion.recordId,
          label: deletion.label,
          recordDate: deletion.recordDate,
          before: null,
          after: restoredView(plan.key, plan.record),
          reason,
          restoresEventId: deletion.id,
          note: plan.duplicate ? `${plan.note} Owner confirmed it is not a duplicate of ${plan.duplicate.label}.` : plan.note,
        })
        return plan.record
      }),
    /** One record's history (oldest first), for roles that can view that module's records. */
    async history(recordId: string) {
      await latency()
      const role = currentRole()
      if (!can(role, "audit")) return [] // the AdBlue profiles see no audit history (owner, 11 Nov 2026)
      return recordHistory(visibleEvents(), recordId).filter((e) => can(role, MODULE_RESOURCE[e.module] ?? "audit"))
    },
    /** Ids of records with at least one edit — drives the "Edited" badge. */
    async editedIds() {
      await latency()
      if (!can(currentRole(), "audit")) return []
      return [...editedIds(visibleEvents())] // an array: a Set doesn't survive JSON (shared backend)
    },
  },
}

export { newId }
