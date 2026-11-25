/**
 * Expense → Road Tax, Insurance, Fitness, Fines, Broker Charges (owner, 25 Nov 2026; Phase 1 — browser backend only).
 * Pure rules shared by the form and the API: validation, validity status, broker balances, description suggestions and
 * the listing filters. Nothing here is stored: statuses and balances are calculated on every read.
 */
import { expiryOf } from "@/domain/compliance"
import { round2 } from "@/lib/format"
import type { BrokerEntryType, Expense, ExpenseSection, NewEntity } from "@/lib/types"

export const EXPENSE_SECTIONS: Record<ExpenseSection, { title: string; one: string; href: string; recordType: string }> = {
  ROAD_TAX: { title: "Road Tax", one: "road tax payment", href: "/expenses/road-tax", recordType: "Road tax" },
  INSURANCE: { title: "Insurance", one: "insurance premium", href: "/expenses/insurance", recordType: "Insurance" },
  FITNESS: { title: "Fitness", one: "fitness (FC) payment", href: "/expenses/fitness", recordType: "Fitness" },
  FINE: { title: "Fines", one: "fine", href: "/expenses/fines", recordType: "Fine" },
  BROKER: { title: "Broker Charges", one: "broker entry", href: "/expenses/broker-charges", recordType: "Broker charge" },
}

export const BROKER_ENTRY_LABEL: Record<BrokerEntryType, string> = {
  CHARGE: "New charge",
  PAYMENT: "Payment to broker",
  BROUGHT_FORWARD: "Opening balance (brought forward)",
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
    entryType: section === "BROKER" ? "CHARGE" : null, broker: "", purpose: "", operatingCompany: "", vehicleCount: 0, paidAmount: 0,
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
  if (broker && type !== "CHARGE" && x.vehicleIds.length) p.vehicleIds = "Only a new charge names vehicles"
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
      if (!x.description.trim()) p.description = "Enter what was paid (e.g. the tax)"
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
      if (!x.broker.trim()) p.broker = "Enter the broker"
      if (!Number.isInteger(x.vehicleCount) || x.vehicleCount < 0) p.vehicleCount = "Enter a whole number"
      else if (x.vehicleIds.length && x.vehicleCount !== x.vehicleIds.length) p.vehicleCount = "Must match the vehicles chosen"
      if (!money(x.paidAmount)) p.paidAmount = "Enter an amount in rupees (up to 2 decimals)"
      if (type === "CHARGE") {
        if (!x.description.trim()) p.description = "Enter what the charge is for"
        if (!p.paidAmount && !p.amount && x.paidAmount > x.amount) p.paidAmount = "More than the charge — record the rest as a Payment to broker"
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

/** One entry's effect on what we owe the broker: + charge or opening balance, − payment. */
export const brokerBalanceOf = (x: Pick<Expense, "amount" | "paidAmount">) => round2(x.amount - x.paidAmount)

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
 *              Broker = Σ Amount Paid on its charges (partly paid counts only what was paid; unpaid 0);
 *              Fines = Σ the fines marked Paid (a fine is paid in full or not at all; unpaid 0).
 */
export function sectionCards(section: ExpenseSection, records: Expense[]): { invoices: number; paid: number } {
  if (section === "BROKER") {
    const charges = records.filter((x) => x.entryType === "CHARGE")
    return { invoices: charges.length, paid: round2(charges.reduce((s, x) => s + x.paidAmount, 0)) }
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

/* ------------------------------------------------------------------ suggestions (no master list) */

/**
 * Common descriptions seen in the RTO workbooks — only a starting point. The list grows from what is saved: every
 * description already recorded in the section is offered again (no separate description master exists or is created).
 */
const STARTERS: Record<ExpenseSection, string[]> = {
  ROAD_TAX: ["MV TAX", "TN TP", "GREEN TAX", "DIFF TAX", "TEMPORARY REGISTRATION"],
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
  /** A customer id, NO_CUSTOMER, or (Broker) an operating company. */
  company: string
  from: string
  to: string
  /** Road Tax: tax type. Fines: fine type. */
  taxType: string
  provider: string
  broker: string
  /** Validity status (Road Tax, Insurance, Fitness) or payment status (Fines, Broker). */
  status: string
}
export const NO_FILTERS: ExpenseFilters = { search: "", vehicleId: "", company: "", from: "", to: "", taxType: "", provider: "", broker: "", status: "" }
export const NO_CUSTOMER = "__none"

/** `regs`: the entry's registrations; `status`: its validity or payment status. */
export function expenseMatches(x: Expense, f: ExpenseFilters, regs: string[], status: string | null) {
  const company = x.section === "BROKER" ? textKey(x.operatingCompany) : (x.customerId ?? NO_CUSTOMER)
  if (f.vehicleId && !x.vehicleIds.includes(f.vehicleId)) return false
  if (f.company && company !== f.company) return false
  if (f.from && x.date < f.from) return false
  if (f.to && x.date > f.to) return false
  if (f.taxType && textKey(x.taxType) !== f.taxType) return false
  if (f.provider && textKey(x.provider) !== f.provider) return false
  if (f.broker && textKey(x.broker) !== f.broker) return false
  if (f.status && status !== f.status) return false
  const q = f.search.trim().toUpperCase()
  if (!q) return true
  const compact = q.replace(/[^A-Z0-9]/g, "")
  const hay = [x.description, x.remarks, x.taxType, x.provider, x.policyNo, x.broker, x.purpose, x.operatingCompany, x.paymentReference].join(" ").toUpperCase()
  return hay.includes(q) || (!!compact && regs.some((r) => r.replace(/[^A-Z0-9]/gi, "").toUpperCase().includes(compact)))
}
