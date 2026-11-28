/**
 * Expense → Road Tax, Insurance, Fitness, Fines, Broker Charges (owner, 25 Nov 2026; Phase 1 — browser backend only).
 * Pure rules shared by the form and the API: validation, validity status, broker balances, description suggestions and
 * the listing filters. Nothing here is stored: statuses and balances are calculated on every read.
 */
import { expiryOf } from "@/domain/compliance"
import { round2 } from "@/lib/format"
import type { BrokerEntryType, Expense, ExpenseMonthLock, ExpenseSection, NewEntity } from "@/lib/types"

export const EXPENSE_SECTIONS: Record<ExpenseSection, { title: string; one: string; href: string; recordType: string }> = {
  ROAD_TAX: { title: "Road Tax", one: "road tax payment", href: "/road-tax", recordType: "Road tax" },
  INSURANCE: { title: "Insurance", one: "insurance premium", href: "/insurance", recordType: "Insurance" },
  FITNESS: { title: "Fitness", one: "fitness (FC) payment", href: "/fitness", recordType: "Fitness" },
  FINE: { title: "Fines", one: "fine", href: "/fines", recordType: "Fine" },
  BROKER: { title: "Broker Charges", one: "broker bill", href: "/broker-charges", recordType: "Broker charge" },
}

export const BROKER_ENTRY_LABEL: Record<BrokerEntryType, string> = {
  // Owner, 27 Nov 2026: every bunk bill is recorded on its own; payments are made to the broker in bulk.
  CHARGE: "Bill",
  PAYMENT: "Payment",
  BROUGHT_FORWARD: "Opening balance",
}

/** What the API stores from the form: everything but the customer, which it stamps from the vehicle's assignment. */
export type ExpenseInput = Omit<NewEntity<Expense>, "customerId">

/** Sections that record one vehicle per entry. */
export const singleVehicle = (s: ExpenseSection) => s !== "BROKER"
/** Sections whose payment may cover a validity period (Insurance always does). */
export const hasValidity = (s: ExpenseSection) => s === "ROAD_TAX" || s === "INSURANCE" || s === "FITNESS"

/** Descriptions, broker names, providers… compared ignoring case and spacing ("MV  tax" = "MV TAX"). */
export const textKey = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase()

export function blankExpense(section: ExpenseSection, today: string): ExpenseInput {
  return {
    section, date: today, vehicleIds: [], companyCode: null, description: "", amount: 0, remarks: "", validFrom: "", validTill: "",
    taxType: "", provider: "", policyNo: "", paymentMode: "", paymentReference: "", paymentStatus: section === "FINE" ? "UNPAID" : null, paymentDate: "",
    entryType: section === "BROKER" ? "CHARGE" : null /* a new broker entry is a bill; payments go through Add Payment (owner, 27 Nov 2026) */, broker: "", purpose: "", operatingCompany: "", vehicleCount: 0, paidAmount: 0,
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const money = (n: number) => Number.isFinite(n) && n >= 0 && round2(n) === n

export type ExpenseProblems = Partial<Record<keyof ExpenseInput, string>>

/**
 * Every problem with an entry, by field (the form shows them under their fields; the API refuses the first). `periodOn`
 * = the entry covers a validity period (always for Insurance; a choice for Road Tax and Fitness).
 */
export function expenseProblems(x: ExpenseInput, today: string): ExpenseProblems {
  const p: ExpenseProblems = {}
  const broker = x.section === "BROKER"
  const type = x.entryType ?? "CHARGE"
  if (!ISO.test(x.date)) p.date = "Enter the date"
  else if (x.date > today) p.date = "The date can't be in the future"
  if (singleVehicle(x.section) && x.vehicleIds.length !== 1) p.vehicleIds = "Choose the vehicle"
  if (broker && type === "BROUGHT_FORWARD" && x.vehicleIds.length) p.vehicleIds = "An opening balance names no vehicle"
  if (new Set(x.vehicleIds).size !== x.vehicleIds.length) p.vehicleIds = "A vehicle is listed twice"

  // Validity period: both dates or neither; Insurance always has one.
  if (hasValidity(x.section)) {
    const any = !!(x.validFrom || x.validTill)
    if (x.section === "INSURANCE" || any) {
      if (!ISO.test(x.validFrom)) p.validFrom = x.section === "INSURANCE" ? "Enter the insurance start date" : "Enter the start of the period"
      if (!ISO.test(x.validTill)) p.validTill = x.section === "INSURANCE" ? "Enter the insurance end date" : "Enter the valid-till date"
      else if (ISO.test(x.validFrom) && x.validTill < x.validFrom) p.validTill = "Valid till can't be before the start date"
    }
  }

  if (!money(x.amount)) p.amount = "Enter an amount in rupees (up to 2 decimals)"
  else if (!(broker && type === "PAYMENT") && !(x.amount > 0)) p.amount = "Enter the amount"

  switch (x.section) {
    case "ROAD_TAX":
      if (!x.description.trim()) p.description = "Choose the tax description"
      // The company making the payment, chosen on the entry — never taken from the vehicle (owner, 27 Nov 2026).
      if (x.companyCode !== "VT" && x.companyCode !== "VTHPL") p.companyCode = "Choose the paying company (VT or VTHPL)"
      break
    case "INSURANCE":
      if (!x.provider.trim()) p.provider = "Enter the insurance provider"
      break
    case "FINE":
      if (!x.taxType.trim()) p.taxType = "Enter the fine type"
      if (x.paymentStatus !== "PAID" && x.paymentStatus !== "UNPAID") p.paymentStatus = "Choose paid or unpaid"
      if (x.paymentStatus === "PAID") {
        if (!ISO.test(x.paymentDate)) p.paymentDate = "Enter the day it was paid"
        else if (x.paymentDate > today) p.paymentDate = "The payment date can't be in the future"
        else if (ISO.test(x.date) && x.paymentDate < x.date) p.paymentDate = "The payment date can't be before the fine date"
      }
      break
    case "BROKER": {
      if (!x.broker.trim()) p.broker = "Choose the broker" // owner, 25 Nov 2026: every payment names its broker
      if (!Number.isInteger(x.vehicleCount) || x.vehicleCount < 0) p.vehicleCount = "Enter a whole number"
      else if (x.vehicleIds.length && x.vehicleCount !== x.vehicleIds.length) p.vehicleCount = "Must match the vehicles chosen"
      if (!money(x.paidAmount)) p.paidAmount = "Enter an amount in rupees (up to 2 decimals)"
      if (type === "CHARGE") {
        if (!x.description.trim()) p.description = "Enter what the bill is for"
        if (!p.paidAmount && !p.amount && x.paidAmount > x.amount) p.paidAmount = "More than the bill — record money paid with Add Payment"
      }
      if (type === "PAYMENT" && !(x.paidAmount > 0)) p.paidAmount = "Enter the amount paid"
      if (type === "BROUGHT_FORWARD" && x.paidAmount) p.paidAmount = "Record payments as their own entry"
      if (x.paidAmount > 0) {
        if (!ISO.test(x.paymentDate)) p.paymentDate = "Enter the cleared date"
        else if (x.paymentDate > today) p.paymentDate = "The cleared date can't be in the future"
      }
      break
    }
  }
  return p
}

/* ------------------------------------------------------------------ validity status (Road Tax, Insurance, Fitness) */

export type ValidityStatus = "ACTIVE" | "UPCOMING" | "EXPIRING" | "EXPIRED" | "RENEWED" | "NO_PERIOD"

export const VALIDITY_LABEL: Record<ValidityStatus, { label: string; tone: "green" | "blue" | "amber" | "red" | "gray" }> = {
  ACTIVE: { label: "Active", tone: "green" },
  UPCOMING: { label: "Not started", tone: "blue" },
  EXPIRING: { label: "Expiring", tone: "amber" },
  EXPIRED: { label: "Expired", tone: "red" },
  RENEWED: { label: "Renewed", tone: "gray" },
  NO_PERIOD: { label: "No validity period", tone: "gray" },
}

/** What a later record must share to renew this one: the vehicle, and for road tax the tax itself (MV TAX ≠ GREEN TAX). */
const renewalKey = (x: Expense) => `${x.section}|${x.vehicleIds[0] ?? ""}|${x.section === "ROAD_TAX" ? textKey(x.description) : ""}`

/**
 * Expiring = within 30 days (the vehicle documents' rule, compliance.ts). An expiring or expired record that a later
 * record of the same vehicle (and tax) runs past is "Renewed", so only what still needs action shows red / amber.
 */
export function validityOf(x: Expense, all: Expense[], today: string): ValidityStatus {
  if (!x.validTill) return "NO_PERIOD"
  if (x.validFrom > today) return "UPCOMING"
  const { state } = expiryOf(x.validTill, today)
  if (state === "VALID") return "ACTIVE"
  const key = renewalKey(x)
  if (all.some((y) => y.id !== x.id && y.validTill > x.validTill && renewalKey(y) === key)) return "RENEWED"
  return state === "EXPIRING" ? "EXPIRING" : "EXPIRED"
}

/* ------------------------------------------------------------------ Broker Charges */

/**
 * One entry's effect on what we owe the broker (owner, 27 Nov 2026): + a bill or the opening balance (less any Amount
 * Paid recorded on an older bill itself), − a payment. A payment belongs to the broker, never to a bill.
 */
export const brokerBalanceOf = (x: Pick<Expense, "entryType" | "amount" | "paidAmount">) => round2(x.entryType === "PAYMENT" ? -x.paidAmount : x.amount - x.paidAmount)

const TYPE_ORDER = { BROUGHT_FORWARD: 0, CHARGE: 1, PAYMENT: 2 } as const
/** A broker's entries in ledger order: date, then opening → bills → payments on one day, then as entered. */
export const ledgerOrder = <T extends Pick<Expense, "date" | "entryType" | "createdAt" | "id">>(xs: T[]) =>
  [...xs].sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.entryType ?? "CHARGE"] - TYPE_ORDER[b.entryType ?? "CHARGE"] || a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))

/** One broker's entries (spelling / spacing ignored). */
export const entriesOf = (all: Expense[], broker: string) => all.filter((x) => x.section === "BROKER" && textKey(x.broker) === textKey(broker))

/** One broker's ledger, oldest first, with the outstanding after each entry. */
export function brokerLedger(all: Expense[], broker: string) {
  let bal = 0
  return ledgerOrder(entriesOf(all, broker)).map((x) => ({ entry: x, balance: (bal = round2(bal + brokerBalanceOf(x))) }))
}

/** What's owed to the broker after every entry up to `asOf` (default: all). */
export const brokerOutstanding = (all: Expense[], broker: string, asOf = "9999-12-31") =>
  round2(entriesOf(all, broker).reduce((t, x) => t + (x.date <= asOf ? brokerBalanceOf(x) : 0), 0))

/** The first entry after which the broker would be owed less than nothing (paid more than billed), or null. */
export function firstOverpayment(entries: Expense[]) {
  let bal = 0
  for (const x of ledgerOrder(entries)) {
    bal = round2(bal + brokerBalanceOf(x))
    if (bal < -0.005) return { entry: x, balance: bal }
  }
  return null
}

/**
 * Per broker for one month (Opening Outstanding + Bills − Payments = Closing Outstanding):
 *   opening  — owed before the month, + an opening balance dated in it;
 *   bills    — the bills dated in the month;
 *   payments — payments dated in the month (+ Amount Paid recorded on an older bill of the month);
 *   closing  — owed at the month's end.
 * Brokers with no entry up to the month's end are left out.
 */
export function brokerMonthAccounts(all: Expense[], month: string) {
  const first = `${month}-01`
  const last = monthEnd(month)
  const by = new Map<string, { broker: string; opening: number; bills: number; payments: number; closing: number }>()
  for (const x of all) {
    if (x.section !== "BROKER" || x.date > last) continue
    const k = textKey(x.broker)
    const a = by.get(k) ?? { broker: x.broker || "No broker named", opening: 0, bills: 0, payments: 0, closing: 0 }
    const inMonth = x.date >= first
    if (!inMonth || x.entryType === "BROUGHT_FORWARD") a.opening += brokerBalanceOf(x)
    else if (x.entryType === "CHARGE") {
      a.bills += x.amount
      a.payments += x.paidAmount
    } else a.payments += x.paidAmount
    a.closing += brokerBalanceOf(x)
    by.set(k, a)
  }
  return [...by.values()]
    .map((a) => ({ broker: a.broker, opening: round2(a.opening), bills: round2(a.bills), payments: round2(a.payments), closing: round2(a.closing) }))
    .sort((a, b) => b.closing - a.closing || a.broker.localeCompare(b.broker))
}

export type BrokerPayStatus = "PAID" | "PARTIAL" | "UNPAID"
/** A new charge's own status (paid on that row); payments and openings have none. */
export function brokerPayStatus(x: Expense): BrokerPayStatus | null {
  if (x.entryType !== "CHARGE") return null
  return x.paidAmount >= x.amount ? "PAID" : x.paidAmount > 0 ? "PARTIAL" : "UNPAID"
}

/**
 * The two summary cards of one section, from its records as filtered on screen (each section its own records only):
 *   invoices — the section's expense records; Broker: new charges only (never a payment or an opening balance).
 *   paid     — money recorded as paid:
 *              Road Tax, Insurance, Fitness = Σ Amount — each of their entries IS a payment made on its transaction
 *              date (the RTO / insurance books list what was paid; the form asks for the amount paid);
 *              Broker = Σ Amount Paid on its charges + Σ payments to the broker (opening balances: neither);
 *              Fines = Σ the fines marked Paid (a fine is paid in full or not at all; unpaid 0).
 */
export function sectionCards(section: ExpenseSection, records: Expense[]): { invoices: number; paid: number } {
  if (section === "BROKER") {
    // Paid: Amount Paid on charges (older entries) + payments to the broker — since 25 Nov 2026 the form records money
    // paid only as "Payment to broker". Opening balances are neither invoices nor payments. Each amount counted once.
    const charges = records.filter((x) => x.entryType === "CHARGE")
    const paid = records.filter((x) => x.entryType === "CHARGE" || x.entryType === "PAYMENT")
    return { invoices: charges.length, paid: round2(paid.reduce((s, x) => s + x.paidAmount, 0)) }
  }
  const paid = section === "FINE" ? records.filter((x) => x.paymentStatus === "PAID") : records
  return { invoices: records.length, paid: round2(paid.reduce((s, x) => s + x.amount, 0)) }
}

/**
 * A vehicle's latest Road Tax / Insurance / Fitness payment from the Expense records (newest transaction date, then the
 * most recently entered) — the vehicle page's amount. Only that vehicle's own records; null = none recorded.
 */
export function latestPayment(expenses: Expense[], vehicleId: string, section: "ROAD_TAX" | "INSURANCE" | "FITNESS"): Expense | null {
  return expenses.filter((x) => x.section === section && x.vehicleIds.includes(vehicleId)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

/* ------------------------------------------------------------------ accounting months (owner, 25 Nov 2026) */

/**
 * The accounting month of a record = its own transaction date (`date`): Road Tax / Insurance / Fitness — the date it was
 * paid (never Tax From / Valid Till or policy dates); Fines — the fine date; Broker — the Pay Date. Never stored, so a
 * record can't drift from its date, and records saved before months existed need no migration.
 */
export const monthOf = (x: Pick<Expense, "date">) => x.date.slice(0, 7)

/**
 * Only an explicit lock locks a month — never the calendar. Each section locks its own months (owner, 25 Nov 2026):
 * locking Broker Charges for November leaves November open in the other four. A lock without a section applies to all.
 */
export const isMonthLocked = (locks: Pick<ExpenseMonthLock, "month" | "section">[], section: ExpenseSection, month: string) =>
  locks.some((l) => l.month === month && (l.section ?? section) === section)

/** "yyyy-MM" shifted by n months (n may be negative). */
export function addMonthKey(month: string, n: number) {
  const [y, m] = month.split("-").map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`
}

/** Last day ("yyyy-MM-dd") of a "yyyy-MM" month. */
export const monthEnd = (month: string) => `${month}-${String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()).padStart(2, "0")}`

/**
 * One section's month selector, newest first: the months holding at least one of its records + the current month
 * (always, so a new month can be started — `current` comes from India time, never hard-coded). Empty past months —
 * even between two populated ones — are not offered.
 */
export const expenseMonthOptions = (records: Pick<Expense, "date">[], current: string) => [...new Set([current, ...records.map(monthOf)])].sort().reverse()

/**
 * One section's summary of one month (`records` = the section's records, every month; only `month`'s are counted):
 *   records     — its entries dated in the month (broker payments and opening balances included);
 *   expense     — new expenses: the amounts; Broker: the bills (a payment settles bills already counted; an opening
 *                 balance was owed before);
 *   paid        — the section's Total Amount Paid (sectionCards) for the month;
 *   outstanding — Fines: the month's unpaid fines; Broker: owed at the month's end (Σ brokerBalanceOf over every broker
 *                 entry up to then — bills and opening balances add, payments subtract);
 *                 Road Tax / Insurance / Fitness: null (each entry is a payment, nothing is owed).
 */
export function monthSummary(section: ExpenseSection, records: Expense[], month: string) {
  const inMonth = records.filter((x) => x.section === section && monthOf(x) === month)
  // Broker: the bills (a payment settles bills already counted; an opening balance was owed before).
  const expense = inMonth.reduce((t, x) => t + (section !== "BROKER" || x.entryType === "CHARGE" ? x.amount : 0), 0)
  const end = monthEnd(month)
  const outstanding =
    section === "FINE"
      ? inMonth.reduce((t, x) => t + (x.paymentStatus === "PAID" ? 0 : x.amount), 0)
      : section === "BROKER"
        ? records.reduce((t, x) => t + (x.section === "BROKER" && x.date <= end ? brokerBalanceOf(x) : 0), 0)
        : null
  return { records: inMonth.length, expense: round2(expense), paid: sectionCards(section, inMonth).paid, outstanding: outstanding === null ? null : round2(outstanding) }
}

/* ------------------------------------------------------------------ suggestions (no master list) */

/**
 * Common descriptions seen in the RTO workbooks — only a starting point. The list grows from what is saved: every
 * description already recorded in the section is offered again (no separate description master exists or is created).
 */
const STARTERS: Record<ExpenseSection, string[]> = {
  // The descriptions in the road tax books 2025–26 and 2026–27 (Data/RTO Expense Data; FC FEES rows belong to Fitness).
  ROAD_TAX: ["MV TAX", "TN TP", "GREEN TAX", "DIFF TAX", "DIFFERENCE TAX FLOOR AREA", "TEMPORARY REGISTRATION"],
  INSURANCE: [],
  FITNESS: ["FC FEES", "FC 1 YEAR", "FC 2 YEARS"],
  FINE: [],
  BROKER: ["PSV BUS REGISTRATION", "NEW REGISTRATION", "FC", "HPT", "PERMIT RENEWAL", "NOC"],
}
export const TAX_TYPE_STARTERS = ["Same state", "Interstate"]
export const PAYMENT_MODES = ["Cash", "UPI", "NEFT", "RTGS", "Cheque"]

/** Values already used in a section's field (most used first), after `starters`, one per spelling-insensitive key. */
export function usedValues(all: Expense[], section: ExpenseSection, field: "description" | "taxType" | "provider" | "broker" | "purpose" | "operatingCompany" | "paymentMode", starters: string[] = []) {
  const count = new Map<string, { label: string; n: number }>()
  for (const x of all) {
    const v = x.section === section ? x[field].trim() : ""
    if (!v) continue
    const k = textKey(v)
    count.set(k, { label: count.get(k)?.label ?? v, n: (count.get(k)?.n ?? 0) + 1 })
  }
  for (const s of starters) if (!count.has(textKey(s))) count.set(textKey(s), { label: s, n: 0 })
  return [...count.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((v) => v.label)
}
export const descriptionOptions = (all: Expense[], section: ExpenseSection) => usedValues(all, section, "description", STARTERS[section])

/* ------------------------------------------------------------------ listing filters */

export interface ExpenseFilters {
  search: string
  vehicleId: string
  /** A customer id, NO_CUSTOMER, (Road Tax) the paying company VT / VTHPL, or (Broker) an operating company. */
  company: string
  /** Road Tax → Customer Company (owner, 27 Nov 2026): a customer id or NO_CUSTOMER — the record's `customerId`. */
  customer: string
  /** Road Tax → Description (owner, 27 Nov 2026): textKey of the description (case and spacing ignored). */
  description: string
  from: string
  to: string
  /** Road Tax: tax type. Fines: fine type. */
  taxType: string
  provider: string
  broker: string
  /** Validity status (Road Tax, Insurance, Fitness) or payment status (Fines, Broker). */
  status: string
}
export const NO_FILTERS: ExpenseFilters = { search: "", vehicleId: "", company: "", customer: "", description: "", from: "", to: "", taxType: "", provider: "", broker: "", status: "" }
export const NO_CUSTOMER = "__none"

/** `regs`: the entry's registrations; `status`: its validity or payment status. */
/** `extra`: more text the search covers (a fine's driver name and DL number, from the driver master). */
export function expenseMatches(x: Expense, f: ExpenseFilters, regs: string[], status: string | null, extra: string[] = []) {
  // Company: Broker — operating company; Road Tax — the paying company, VT / VTHPL (owner, 27 Nov 2026); else the customer.
  const company = x.section === "BROKER" ? textKey(x.operatingCompany) : x.section === "ROAD_TAX" ? (x.companyCode ?? "") : (x.customerId ?? NO_CUSTOMER)
  if (f.vehicleId && !x.vehicleIds.includes(f.vehicleId)) return false
  if (f.company && company !== f.company) return false
  if (f.customer && (x.customerId ?? NO_CUSTOMER) !== f.customer) return false
  if (f.description && textKey(x.description) !== f.description) return false
  if (f.from && x.date < f.from) return false
  if (f.to && x.date > f.to) return false
  if (f.taxType && textKey(x.taxType) !== f.taxType) return false
  if (f.provider && textKey(x.provider) !== f.provider) return false
  if (f.broker && textKey(x.broker) !== f.broker) return false
  if (f.status && status !== f.status) return false
  const q = f.search.trim().toUpperCase()
  if (!q) return true
  const compact = q.replace(/[^A-Z0-9]/g, "")
  const hay = [x.description, x.remarks, x.taxType, x.provider, x.policyNo, x.broker, x.purpose, x.operatingCompany, x.paymentReference, ...extra].join(" ").toUpperCase()
  return hay.includes(q) || (!!compact && regs.some((r) => r.replace(/[^A-Z0-9]/gi, "").toUpperCase().includes(compact)))
}
