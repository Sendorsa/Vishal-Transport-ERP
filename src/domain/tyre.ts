/**
 * Tyre Data → Tyre (owner, 17 Nov 2026): tyre / repair invoices, one per supplier bill, with repair lines.
 *
 *   Line        Base Value = Quantity × Rate per Quantity (round2)
 *               GST        = Base × GST % (round2), split by calculateTax: CGST + SGST (half each) or IGST
 *               Total      = Base + GST
 *               KM Run     = Closing KM − Opening KM (when both are entered)
 *   Invoice     Σ of its lines (base, CGST, SGST, IGST, grand total) — never stored
 *
 * The database generates the same line amounts (migration 20261117000000_tyre_data.sql), so they agree to the paisa.
 * Pure functions: the invoice form, the API and the checks use the same ones.
 */
import { calculateTax } from "./pricing"
import { fyMonths, fyRange, fyStartYear } from "./financial-year"
import { isCalendarDate } from "./assignments"
import { round2 } from "@/lib/format"
import type { TyreInvoice, TyreInvoiceItem, TyreMaster, TyreMasterKind, TyrePayment, TyreTaxType } from "@/lib/types"

export const TYRE_MASTER_LABEL: Record<TyreMasterKind, { one: string; many: string }> = {
  SUPPLIER: { one: "Supplier", many: "Suppliers" },
  REPAIR_TYPE: { one: "Repair type", many: "Repair types" },
  BRAND: { one: "Tyre brand", many: "Tyre brands" },
  SIZE: { one: "Tyre size", many: "Tyre sizes" },
}

/**
 * The repair types found in the 2026–27 tyre register (`Data/Tyre Records Data/02. 2026 - 2027.xlsx`, DESCRIPTION),
 * written once each as the owner listed them — spelling variants ("WHEEL ALINGMENT") and combined descriptions
 * ("APOLLO TUBE/ FLAP") were not merged or split automatically. A starting list: new types are added from the form.
 */
export const DEFAULT_REPAIR_TYPES = [
  "New Tyre Purchased",
  "Rebuilt Tyres",
  "Wheel Alignment",
  "Wheel Alignment Charge",
  "Wheel Tyre Fitting",
  "Tyre Fitting",
  "Wheel Rotation Work",
  "Puncture Work",
  "Tube",
  "Flap",
  "Wheel Balancing",
  "Wheel Balance / Weights",
] as const

/** The starting repair types as master records (clean workspace, demo data, and a browser store that has none). */
export const defaultRepairTypes = (now: string): TyreMaster[] =>
  DEFAULT_REPAIR_TYPES.map((name, n) => ({ id: `tym_rt${String(n + 1).padStart(2, "0")}`, kind: "REPAIR_TYPE", name, status: "ACTIVE", createdAt: now, updatedAt: now }))

/** Master names compare with whitespace collapsed and case ignored (the database's unique index uses the same key). */
export const masterKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase()
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ")

/** Tyre details (brand, size, number, KM, removing number) are shown open for repair types about a tyre itself. */
export const isTyreWork = (repairTypeName: string | undefined) => /tyre|tube|flap|rebuilt|puncture|rotation/i.test(repairTypeName ?? "")

/** Line amounts from quantity, rate and GST — the one calculation (form, API, database). */
export function lineAmounts(quantity: number, rate: number, gstRate: number, taxType: TyreTaxType) {
  const baseValue = round2(quantity * rate)
  const tax = calculateTax(baseValue, gstRate, taxType === "CGST_SGST")
  return { baseValue, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, totalValue: tax.total }
}

/** Closing − opening KM, or null unless both are entered. */
export const kmRun = (item: Pick<TyreInvoiceItem, "openingKm" | "closingKm">) => (item.openingKm !== null && item.closingKm !== null ? item.closingKm - item.openingKm : null)

export interface TyreTotals {
  baseValue: number
  cgst: number
  sgst: number
  igst: number
  gst: number
  grandTotal: number
  lines: number
}

/** An invoice's (or any set of lines') totals: Σ of the lines' own rounded amounts. */
export function tyreTotals(items: Pick<TyreInvoiceItem, "baseValue" | "cgst" | "sgst" | "igst" | "totalValue">[]): TyreTotals {
  const sum = (f: (i: (typeof items)[number]) => number) => round2(items.reduce((t, i) => t + f(i), 0))
  const cgst = sum((i) => i.cgst)
  const sgst = sum((i) => i.sgst)
  const igst = sum((i) => i.igst)
  return { baseValue: sum((i) => i.baseValue), cgst, sgst, igst, gst: round2(cgst + sgst + igst), grandTotal: sum((i) => i.totalValue), lines: items.length }
}

const decimals = (n: number) => (String(n).split(".")[1] ?? "").length

/** What's wrong with a line's numbers, or null. The same rules in the form, the API and the database's checks. */
export function itemProblem(item: Pick<TyreInvoiceItem, "repairTypeId" | "quantity" | "rate" | "gstRate" | "openingKm" | "closingKm">): string | null {
  if (!item.repairTypeId) return "Choose the repair type"
  if (!(Number.isFinite(item.quantity) && item.quantity > 0)) return "Quantity must be greater than 0"
  if (decimals(item.quantity) > 3) return "Quantity: up to 3 decimals"
  if (!(Number.isFinite(item.rate) && item.rate >= 0)) return "Enter the rate per quantity (0 or more)"
  if (decimals(item.rate) > 2) return "Rate: up to 2 decimals (paise)"
  if (!(Number.isFinite(item.gstRate) && item.gstRate >= 0 && item.gstRate <= 100) || decimals(item.gstRate) > 2) return "GST % must be between 0 and 100"
  for (const km of [item.openingKm, item.closingKm]) if (km !== null && !(Number.isFinite(km) && km >= 0)) return "KM readings can't be negative"
  if (item.openingKm !== null && item.closingKm !== null && item.closingKm < item.openingKm) return "Closing KM can't be less than opening KM"
  return null
}

/** How an Office / No Customer invoice is named everywhere (it has no customer record — none is ever created). */
export const OFFICE_LABEL = "Office / No Customer"
/** The company filter's value for Office / No Customer invoices. */
export const OFFICE_FILTER = "OFFICE"

/** Duplicate-bill key: the same supplier and the same bill number (spaces and case ignored). A warning only. */
const billKey = (s: string) => s.replace(/\s+/g, "").toLowerCase()
export const sameBill = (a: Pick<TyreInvoice, "supplierId" | "billNo">, b: Pick<TyreInvoice, "supplierId" | "billNo">) => !!billKey(a.billNo) && a.supplierId === b.supplierId && billKey(a.billNo) === billKey(b.billNo)

type FinancialLine = Pick<TyreInvoiceItem, "repairTypeId" | "brandId" | "sizeId" | "tyreNumber" | "openingKm" | "closingKm" | "quantity" | "rate" | "gstRate" | "taxType" | "removingNumber" | "remarks">
export type FinancialFields = Pick<TyreInvoice, "date" | "vehicleId" | "office" | "supplierId" | "billNo"> & { items: FinancialLine[] }
/**
 * What an edit changes that needs a reason (owner, 17 Nov 2026): the date, vehicle, attribution, supplier, bill number
 * or any repair line (type, tyre, KM, quantity, rate, GST, line remarks; lines added or removed). The payment notes
 * and the invoice remarks alone need none. The form and the API use the same list.
 */
export function financialChanges(a: FinancialFields, b: FinancialFields): string[] {
  const out: string[] = []
  if (a.date !== b.date) out.push("invoice date")
  if (a.vehicleId !== b.vehicleId) out.push("vehicle")
  if (a.office !== b.office) out.push("attribution")
  if (a.supplierId !== b.supplierId) out.push("supplier")
  if (a.billNo.trim() !== b.billNo.trim()) out.push("bill number")
  const line = (i: FinancialLine) => JSON.stringify([i.repairTypeId, i.brandId ?? null, i.sizeId ?? null, i.tyreNumber.trim(), i.openingKm, i.closingKm, i.quantity, i.rate, i.gstRate, i.taxType, i.removingNumber.trim(), i.remarks.trim()])
  if (a.items.length !== b.items.length || a.items.some((x, n) => line(x) !== line(b.items[n]))) out.push("repair lines")
  return out
}

/** Spend by attribution: customers' invoices vs Office / No Customer — together the total tyre spend. */
export function attributionSplit(invoices: Pick<TyreInvoice, "office" | "items">[]) {
  const sum = (xs: typeof invoices) => tyreTotals(xs.flatMap((x) => x.items)).grandTotal
  return { customers: sum(invoices.filter((x) => !x.office)), office: sum(invoices.filter((x) => x.office)) }
}

/** An invoice view as the register shows it (names resolved by the caller). */
export interface TyreInvoiceView extends TyreInvoice {
  totals: TyreTotals
  regNo: string
  vehicleType: string
  vehicleTypeCode: string
  company: string
  supplier: string
}

export interface TyreFilters {
  /** Period: "ALL", a month ("yyyy-MM"), a financial year ("FY:2026") or a date range ("RANGE"). */
  period: string
  from: string
  to: string
  customerId: string
  vehicleId: string
  vehicleType: string
  supplierId: string
  billNo: string
  repairTypeId: string
  brandId: string
  sizeId: string
  paymentMode: string
  purchaseMode: string
  /** Bill number, vehicle registration, supplier or a line's tyre number. */
  search: string
}

export const NO_FILTERS: TyreFilters = { period: "ALL", from: "", to: "", customerId: "", vehicleId: "", vehicleType: "", supplierId: "", billNo: "", repairTypeId: "", brandId: "", sizeId: "", paymentMode: "", purchaseMode: "", search: "" }

/** The period's first and last day (inclusive), or null for all dates. */
export function periodRange(f: Pick<TyreFilters, "period" | "from" | "to">): { from: string; to: string } | null {
  if (f.period === "ALL") return null
  if (f.period === "RANGE") return { from: f.from || "0000-01-01", to: f.to || "9999-12-31" }
  if (f.period.startsWith("FY:")) {
    return fyRange(Number(f.period.slice(3)))
  }
  return { from: `${f.period}-01`, to: `${f.period}-31` } // a month ("yyyy-MM"): string compare covers 28–31 days
}

const norm = (s: string) => s.replace(/[\s-]+/g, "").toLowerCase()

/** Line-level filters (repair type, brand, size) on one line: an invoice matches when one of its lines matches them all. */
export const lineMatches = (i: TyreInvoiceItem, f: Pick<TyreFilters, "repairTypeId" | "brandId" | "sizeId">) =>
  (!f.repairTypeId || i.repairTypeId === f.repairTypeId) && (!f.brandId || i.brandId === f.brandId) && (!f.sizeId || i.sizeId === f.sizeId)

export const hasLineFilter = (f: TyreFilters) => !!(f.repairTypeId || f.brandId || f.sizeId)

/** Does the invoice pass every filter? Header filters on the invoice, line filters on one of its lines. */
export function invoiceMatches(v: TyreInvoiceView, f: TyreFilters) {
  const range = periodRange(f)
  if (range && (v.date < range.from || v.date > range.to)) return false
  if (f.customerId && (f.customerId === OFFICE_FILTER ? !v.office : v.office || v.customerId !== f.customerId)) return false
  if (f.vehicleId && v.vehicleId !== f.vehicleId) return false
  if (f.vehicleType && v.vehicleTypeCode !== f.vehicleType) return false
  if (f.supplierId && v.supplierId !== f.supplierId) return false
  if (f.billNo && !norm(v.billNo).includes(norm(f.billNo))) return false
  if (f.paymentMode && v.paymentMode !== f.paymentMode) return false
  if (f.purchaseMode && v.purchaseMode !== f.purchaseMode) return false
  if (hasLineFilter(f) && !v.items.some((i) => lineMatches(i, f))) return false
  const q = norm(f.search)
  if (q && ![v.billNo, v.regNo, v.supplier, ...v.items.map((i) => i.tyreNumber)].some((s) => norm(s).includes(q))) return false
  return true
}

/** Active masters of a kind for a picker (sorted), plus the ones already on the record being edited. */
export function masterOptions(masters: TyreMaster[], kind: TyreMasterKind, keep: (string | null)[] = []) {
  return masters
    .filter((m) => m.kind === kind && (m.status === "ACTIVE" || keep.includes(m.id)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ value: m.id, label: m.status === "ARCHIVED" ? `${m.name} (archived)` : m.name }))
}

/* ------------------------------------------------------------------ Monthly Sheet (a view; nothing stored) */

/** One repair line with its invoice: a row of the Monthly Sheet. */
export interface TyreLineRow {
  invoice: TyreInvoiceView
  item: TyreInvoiceItem
}

/**
 * The month's repair lines that pass the filters — each saved line once. Header filters (company, vehicle, type,
 * supplier) on the invoice; repair type, brand, size and the search on the line itself. `month` = "yyyy-MM".
 */
export const monthLines = (views: TyreInvoiceView[], month: string, f: TyreFilters): TyreLineRow[] => filteredLines(views, { ...f, period: month })

/** The repair lines that pass the filters (any period) — the Monthly Sheet's month, a vendor's whole history. */
export function filteredLines(views: TyreInvoiceView[], f: TyreFilters): TyreLineRow[] {
  const header: TyreFilters = { ...f, repairTypeId: "", brandId: "", sizeId: "", search: "" }
  const q = norm(f.search)
  return views
    .filter((v) => invoiceMatches(v, header))
    .flatMap((invoice) =>
      invoice.items
        .filter((i) => lineMatches(i, f) && (!q || [invoice.billNo, invoice.regNo, invoice.supplier, i.tyreNumber, i.removingNumber].some((s) => norm(s).includes(q))))
        .map((item) => ({ invoice, item }))
    )
}

/** The lines' totals and how many distinct invoices they come from (five lines of one bill = one invoice). */
export function sheetTotals(rows: TyreLineRow[]) {
  return { ...tyreTotals(rows.map((r) => r.item)), invoices: new Set(rows.map((r) => r.invoice.id)).size }
}

export interface TyreSpendRow extends ReturnType<typeof sheetTotals> {
  key: string
  label: string
}

/** Spend grouped by `keyOf` ([key, label]), largest first. Each line in exactly one group. */
export function spendBy(rows: TyreLineRow[], keyOf: (r: TyreLineRow) => [string, string]): TyreSpendRow[] {
  const groups = new Map<string, { label: string; rows: TyreLineRow[] }>()
  for (const r of rows) {
    const [key, label] = keyOf(r)
    const g = groups.get(key) ?? groups.set(key, { label, rows: [] }).get(key)!
    g.rows.push(r)
  }
  return [...groups].map(([key, g]) => ({ key, label: g.label, ...sheetTotals(g.rows) })).sort((a, b) => b.grandTotal - a.grandTotal || a.label.localeCompare(b.label))
}

/** Company of a line: its invoice's customer, or Office / No Customer — never a customer's total. */
export const companyKey = (r: TyreLineRow): [string, string] => (r.invoice.office ? [OFFICE_FILTER, OFFICE_LABEL] : [r.invoice.customerId ?? "", r.invoice.company])

/* ------------------------------------------------------------------ Tyre page = the current month; Monthly Sheet = any month */

/**
 * The main Tyre page: the invoices of the current India month (`today` = todayISO()) that pass the filters. A view,
 * never a reset: earlier months' invoices are untouched and stay in the Monthly Sheet. When the month changes at
 * 00:00 IST, the page shows the new month by itself (useCurrentMonth / AppShell).
 */
export const currentMonthInvoices = (views: TyreInvoiceView[], today: string, f: TyreFilters) => views.filter((v) => invoiceMatches(v, { ...f, period: today.slice(0, 7) }))

/** Monthly Sheet years: calendar years (Jan–Dec) or financial years (Apr–Mar, by start year). */
export type SheetBasis = "calendar" | "fy"

/** The years offered: every year with a tyre invoice, plus the current one — never a future one. Newest first. */
export function sheetYears(basis: SheetBasis, dates: string[], today: string): number[] {
  const of = (d: string) => (basis === "fy" ? fyStartYear(d) : Number(d.slice(0, 4)))
  const current = of(today)
  return [...new Set([current, ...dates.map(of)])].filter((y) => y <= current).sort((a, b) => b - a)
}

/** The months ("yyyy-MM") of a calendar year or financial year, up to the current month (future months never appear). */
export function sheetMonths(basis: SheetBasis, year: number, today: string): string[] {
  const months = basis === "fy" ? fyMonths(year) : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
  return months.filter((m) => m <= today.slice(0, 7))
}

/** Switching year or basis keeps the same month of the year when it is offered, otherwise the latest month offered. */
export const pickSheetMonth = (months: string[], month: string) => months.find((m) => m.slice(5) === month.slice(5)) ?? months[months.length - 1]

/* ------------------------------------------------------------------ Vendor payments and ledger (owner, 17 Nov 2026) */
/*
 *   Payment     Settled     = Paid to the vendor (`amount`: the bank / cash outflow) + TDS deducted (`tdsAmount`)
 *               TDS         = round2(Settled × TDS % / 100) when "Deduct TDS?" is on (17 Nov 2026), else 0
 *               Advance     = Settled − Σ its allocations — credit with the supplier, not yet on a bill
 *   Invoice     Paid        = Σ allocations to it (in settled terms: TDS included)
 *               Outstanding = Grand Total − Paid (never below 0: an allocation never exceeds what is outstanding)
 *               Status      = Paid (nothing outstanding) · Partially Paid · Unpaid / Credit (nothing paid)
 *   Vendor      Purchased   = Σ its invoices' grand totals (every invoice: unpaid, partial, credit)
 *               Paid        = Σ its payments' Settled — of which Cash paid = Σ amount, TDS = Σ tdsAmount
 *               Balance     = Purchased − Paid = Outstanding − Advance   (+ payable to the vendor, − advance with it)
 * TDS is counted once: inside Settled. Cash / bank outflow is `amount` only. There is no monthly tyre TDS entry.
 * Nothing here is stored: the API, the database's checks and every screen calculate the same figures.
 */

/** "Credit" on an invoice = bought on account: nothing is paid now, so no payment is recorded. */
export const CREDIT = "Credit"
/** How a recorded tyre payment was made (never Credit). The database accepts the same list. */
export const TYRE_PAYMENT_MODES = ["Cash", "UPI", "NEFT", "RTGS", "IMPS", "Cheque"] as const
/** What the payment's reference number is, by mode: a UTR for transfers, the cheque number, the cash receipt number. */
export const referenceLabel = (mode: string) => (mode === "Cheque" ? "Cheque number" : mode === "Cash" ? "Receipt number" : "UTR / transaction reference")
/** The same in a sentence: "Enter the {referenceNoun}". */
export const referenceNoun = (mode: string) => (mode === "Cheque" ? "cheque number" : mode === "Cash" ? "receipt number" : "UTR / transaction reference number")
/** Default TDS % offered by "Deduct TDS?" (the same 0.1% as fuel stations; kept separate from that module). */
export const TYRE_TDS_PERCENT = 0.1
/** The Payment Type on Add Invoice: Credit, or how it was paid. */
export const TYRE_PAYMENT_TYPES = [CREDIT, ...TYRE_PAYMENT_MODES] as const

export type TyrePayStatus = "PAID" | "PARTIAL" | "UNPAID"
export const PAY_STATUS_LABEL: Record<TyrePayStatus, string> = { PAID: "Paid", PARTIAL: "Partially Paid", UNPAID: "Unpaid / Credit" }

const sum2 = (xs: number[]) => xs.reduce((t, x) => round2(t + x), 0)
/** UTR key: spaces and case ignored (the database's unique index uses the same key). */
export const utrKey = (utr: string) => utr.replace(/\s+/g, "").toLowerCase()

/** A payment's total settled: paid to the vendor + TDS deducted (records saved before TDS had none). */
export const settledOf = (p: Pick<TyrePayment, "amount" | "tdsAmount">) => round2(p.amount + (p.tdsAmount ?? 0))

/** TDS on a total settled: TDS = round2(total × % / 100), paid to the vendor = the rest. */
export function tyreTdsSplit(total: number, percent: number) {
  const settled = round2(total)
  const tds = round2((settled * percent) / 100)
  return { settled, tds, paid: round2(settled - tds) }
}

/** What's wrong with a TDS %, or null (0 – < 100, ≤ 4 decimals, something left to pay). */
export function tdsProblem(total: number, percent: number): string | null {
  if (!Number.isFinite(percent)) return "Enter the TDS percentage"
  if (percent < 0) return "The TDS percentage can't be negative"
  if ((String(percent).split(".")[1] ?? "").length > 4) return "TDS percentage: up to 4 decimals"
  if (percent >= 100) return "TDS can't be the whole payment — the vendor must receive something"
  if (Number.isFinite(total) && total > 0 && !(tyreTdsSplit(total, percent).paid > 0)) return "Nothing would be paid to the vendor after TDS"
  return null
}

/** What is left of a payment for invoices: its advance credit. */
export const unallocated = (p: Pick<TyrePayment, "amount" | "tdsAmount" | "allocations">) => round2(settledOf(p) - sum2(p.allocations.map((a) => a.amount)))

/** Allocation status of a payment: fully allocated, partly, or nothing (all advance). */
export type AllocationStatus = "FULL" | "PARTIAL" | "ADVANCE"
export const ALLOCATION_STATUS_LABEL: Record<AllocationStatus, string> = { FULL: "Fully allocated", PARTIAL: "Partially allocated", ADVANCE: "Advance / Unallocated" }
export const allocationStatus = (p: TyrePayment): AllocationStatus => (unallocated(p) === 0 ? "FULL" : p.allocations.length ? "PARTIAL" : "ADVANCE")

/**
 * An invoice's settlement split into cash and TDS: each allocation carries its payment's TDS in proportion
 * (allocation × TDS ÷ settled, round2) — for display; the invoice's paid total is the allocations themselves.
 */
export function invoiceSettlement(payments: TyrePayment[], invoiceId: string) {
  let settled = 0
  let tds = 0
  for (const p of payments)
    for (const a of p.allocations)
      if (a.invoiceId === invoiceId) {
        settled = round2(settled + a.amount)
        tds = round2(tds + allocationTds(p, a.amount))
      }
  return { settled, tds, cash: round2(settled - tds) }
}
/** The TDS part of an allocation of `amount` from payment `p`. */
export const allocationTds = (p: Pick<TyrePayment, "amount" | "tdsAmount">, amount: number) => (p.tdsAmount ? round2((amount * p.tdsAmount) / settledOf(p)) : 0)

/** Σ paid per invoice. */
export function paidByInvoice(payments: TyrePayment[]): Map<string, number> {
  const paid = new Map<string, number>()
  for (const p of payments) for (const a of p.allocations) paid.set(a.invoiceId, round2((paid.get(a.invoiceId) ?? 0) + a.amount))
  return paid
}

export interface InvoicePay {
  total: number
  paid: number
  outstanding: number
  status: TyrePayStatus
}
export function invoicePay(total: number, paid: number): InvoicePay {
  const outstanding = Math.max(0, round2(total - paid))
  return { total, paid, outstanding, status: outstanding === 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID" }
}

export interface VendorAccount {
  supplierId: string
  /** Σ invoice grand totals. */
  purchased: number
  /** Σ payments' total settled: cash paid + TDS. */
  paid: number
  /** Σ paid to the vendor (bank / cash). */
  cashPaid: number
  /** Σ TDS deducted. */
  tds: number
  /** Σ of each invoice's outstanding amount. */
  outstanding: number
  /** Σ of the payments' unallocated amounts. */
  advance: number
  /** Purchased − Paid (= outstanding − advance): + payable to the vendor, − advance with it. */
  balance: number
  invoices: number
  payments: number
}

/** One account per supplier with an invoice or a payment — the complete history, never one month's. */
export function vendorAccounts(invoices: Pick<TyreInvoice, "id" | "supplierId" | "items">[], payments: TyrePayment[]): VendorAccount[] {
  const paid = paidByInvoice(payments)
  const acc = new Map<string, VendorAccount>()
  const of = (supplierId: string) => acc.get(supplierId) ?? acc.set(supplierId, { supplierId, purchased: 0, paid: 0, cashPaid: 0, tds: 0, outstanding: 0, advance: 0, balance: 0, invoices: 0, payments: 0 }).get(supplierId)!
  for (const x of invoices) {
    const a = of(x.supplierId)
    const pay = invoicePay(tyreTotals(x.items).grandTotal, paid.get(x.id) ?? 0)
    a.purchased = round2(a.purchased + pay.total)
    a.outstanding = round2(a.outstanding + pay.outstanding)
    a.invoices++
  }
  for (const p of payments) {
    const a = of(p.supplierId)
    a.paid = round2(a.paid + settledOf(p))
    a.cashPaid = round2(a.cashPaid + p.amount)
    a.tds = round2(a.tds + (p.tdsAmount ?? 0))
    a.advance = round2(a.advance + unallocated(p))
    a.payments++
  }
  for (const a of acc.values()) a.balance = round2(a.purchased - a.paid)
  return [...acc.values()]
}

export interface LedgerRow {
  date: string
  kind: "PURCHASE" | "PAYMENT"
  id: string
  /** Credit = a purchase (we owe the vendor more); Debit = a payment's total settled (we owe less). */
  credit: number
  debit: number
  /** Payments: the debit's split — paid to the vendor and TDS deducted. */
  paid: number
  tds: number
  /** Running Σ credit − Σ debit: + payable to the vendor, − advance with it. */
  balance: number
}

/**
 * The vendor's account in date order (a purchase before a payment on the same day, then as entered). The last
 * balance = Purchased − Paid.
 */
export function vendorLedger(invoices: Pick<TyreInvoice, "id" | "supplierId" | "date" | "createdAt" | "items">[], payments: TyrePayment[], supplierId: string): LedgerRow[] {
  const rows = [
    ...invoices.filter((x) => x.supplierId === supplierId).map((x) => ({ date: x.date, at: x.createdAt, kind: "PURCHASE" as const, id: x.id, credit: tyreTotals(x.items).grandTotal, debit: 0, paid: 0, tds: 0 })),
    ...payments.filter((p) => p.supplierId === supplierId).map((p) => ({ date: p.date, at: p.createdAt, kind: "PAYMENT" as const, id: p.id, credit: 0, debit: settledOf(p), paid: p.amount, tds: p.tdsAmount ?? 0 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "PURCHASE" ? -1 : 1) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  let balance = 0
  return rows.map((r) => ({ date: r.date, kind: r.kind, id: r.id, credit: r.credit, debit: r.debit, paid: r.paid, tds: r.tds, balance: (balance = round2(balance + r.credit - r.debit)) }))
}

export interface TyrePaymentDraft {
  date: string
  /** The total settled (paid to the vendor + TDS). */
  amount: number
  mode: string
  utr: string
  allocations: { invoiceId: string; amount: number }[]
  /** The unallocated part is meant as advance credit with the vendor (explicit, never assumed). */
  acceptAdvance?: boolean
}

const paise = (n: number) => Number.isFinite(n) && Math.abs(round2(n) - n) < 1e-9

/**
 * What's wrong with a payment, or null — the same rules in the dialogs and the API. `outstanding(invoiceId)`: what the
 * invoice still owes (undefined = not an invoice of this vendor).
 */
export function paymentProblem(p: TyrePaymentDraft, today: string, outstanding: (invoiceId: string) => number | undefined, label: (invoiceId: string) => string = (id) => id): string | null {
  if (!isCalendarDate(p.date ?? "")) return "Enter the payment date"
  if (p.date > today) return "A payment can't be dated in the future."
  if (p.mode === CREDIT) return "Credit means nothing is paid now — there is no payment to record."
  if (!(TYRE_PAYMENT_MODES as readonly string[]).includes(p.mode)) return "Choose how it was paid (Cash, UPI, NEFT, RTGS, IMPS or Cheque)"
  if (!(Number.isFinite(p.amount) && p.amount > 0)) return "The payment amount must be more than ₹0"
  if (!paise(p.amount)) return "Amount: up to 2 decimals (paise)"
  if (!(p.utr ?? "").trim()) return `Enter the ${referenceNoun(p.mode)} — it is required for a ${p.mode} payment.`
  const seen = new Set<string>()
  for (const a of p.allocations) {
    if (seen.has(a.invoiceId)) return `${label(a.invoiceId)} is listed twice`
    seen.add(a.invoiceId)
    const left = outstanding(a.invoiceId)
    if (left === undefined) return `${label(a.invoiceId)} isn't an invoice of this vendor`
    if (!(Number.isFinite(a.amount) && a.amount > 0) || !paise(a.amount)) return `${label(a.invoiceId)}: enter an amount more than ₹0 (up to 2 decimals)`
    if (a.amount > left) return `${label(a.invoiceId)}: ₹${a.amount.toFixed(2)} is more than its outstanding ₹${left.toFixed(2)}`
  }
  const allocated = sum2(p.allocations.map((a) => a.amount))
  if (allocated > p.amount) return `The allocations (₹${allocated.toFixed(2)}) are more than the payment (₹${p.amount.toFixed(2)})`
  const rest = round2(p.amount - allocated)
  if (rest > 0 && !p.acceptAdvance) return `₹${rest.toFixed(2)} of this payment isn't allocated to any invoice. Allocate it, or record it as advance credit with the vendor.`
  return null
}
