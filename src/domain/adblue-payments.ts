/**
 * AdBlue supplier credit and payments (owner, 18 Nov 2026) — money owed to AdBlue vendors for bulk purchases, kept
 * completely apart from stock: payments never touch litres, FIFO batches or Inventory Value (domain/adblue-inventory.ts).
 *
 *   Purchase   Value       = Taxable (= Total Cost: buckets × price per bucket — what FIFO costs stock at) + GST
 *              GST         = round2(Taxable × GST % / 100)   (purchases saved before GST: 0 %, value = Total Cost)
 *              Paid        = Σ allocations to it (settled terms: TDS included)
 *              Outstanding = Value − Paid (never below 0) · status Paid / Partially Paid / Unpaid
 *   Payment    Settled     = Paid to the vendor (`amount`: the cash / bank outflow) + TDS deducted (`tdsAmount`)
 *              TDS         = round2(Settled × TDS % / 100) when "Deduct TDS?" is on, else 0
 *              Advance     = Settled − Σ its allocations — credit with the vendor, not yet on a purchase
 *   Vendor     Purchased   = Σ purchase values (opening stock is never a purchase: no vendor, nothing owed)
 *              Settled     = Σ payments' Settled — of which Cash paid = Σ amount, TDS = Σ tdsAmount
 *              Outstanding = Σ purchases' outstanding · Advance = Σ payments' advance
 *              Net payable = Purchased − Settled = Outstanding − Advance (+ we owe the vendor, − the vendor holds our money)
 * TDS is counted once, inside Settled. No monthly AdBlue TDS entry exists, so the same purchases are never taxed twice.
 * Nothing here is stored: the API, the database's checks and every screen calculate the same figures.
 * Independent of the tyre and fuel station payment modules (same rules, its own code and tables).
 */
import { isCalendarDate } from "./assignments"
import { fyRange } from "./financial-year"
import { round2 } from "@/lib/format"
import type { AdBluePayment, AdBluePurchase } from "@/lib/types"

/** Credit on a purchase = bought on account: nothing paid now, so no payment is recorded. */
export const CREDIT = "Credit"
/** How a recorded AdBlue payment was made (never Credit). The database accepts the same list. */
export const ADBLUE_PAYMENT_MODES = ["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash"] as const
/** Default TDS % offered by "Deduct TDS?". */
export const ADBLUE_TDS_PERCENT = 0.1
/** Add Bulk Purchase → Payment Type. */
export type PurchasePaymentType = "CREDIT" | "FULL" | "PARTIAL"
export const PURCHASE_PAYMENT_TYPE_LABEL: Record<PurchasePaymentType, string> = { CREDIT: "Credit", FULL: "Fully Paid", PARTIAL: "Partially Paid" }

/** The reference number by mode: a UTR for transfers, the cheque number, the cash receipt number. */
export const referenceLabel = (mode: string) => (mode === "Cheque" ? "Cheque number" : mode === "Cash" ? "Receipt number" : "UTR / transaction reference")
export const referenceNoun = (mode: string) => (mode === "Cheque" ? "cheque number" : mode === "Cash" ? "receipt number" : "UTR / transaction reference number")
/** Reference key: spaces and case ignored (the database's unique index uses the same key). */
export const refKey = (s: string) => s.replace(/\s+/g, "").toLowerCase()

const sum2 = (xs: number[]) => xs.reduce((t, x) => round2(t + x), 0)
const paise = (n: number) => Number.isFinite(n) && Math.abs(round2(n) - n) < 1e-9

/* ------------------------------------------------------------------ purchases */

/** GST on a purchase's taxable amount (its Total Cost). */
export const gstOf = (taxable: number, gstRate: number | null | undefined) => round2((taxable * (gstRate ?? 0)) / 100)
/** What the purchase is worth to the vendor: taxable + GST. Stock and FIFO use the taxable amount only. */
export const purchaseValue = (p: Pick<AdBluePurchase, "totalCost" | "gstRate">) => round2(p.totalCost + gstOf(p.totalCost, p.gstRate))
/** Opening stock was bought from nobody in the records: never owed, never paid. */
export const isPayable = (p: Pick<AdBluePurchase, "opening" | "adblueVendorId">) => !p.opening && !!p.adblueVendorId

export type PurchasePayStatus = "PAID" | "PARTIAL" | "UNPAID"
export const PURCHASE_PAY_LABEL: Record<PurchasePayStatus, string> = { PAID: "Paid", PARTIAL: "Partially Paid", UNPAID: "Unpaid / Credit" }
export interface PurchasePay {
  value: number
  paid: number
  outstanding: number
  status: PurchasePayStatus
}
export function purchasePay(value: number, paid: number): PurchasePay {
  const outstanding = Math.max(0, round2(value - paid))
  return { value, paid, outstanding, status: outstanding === 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID" }
}

/** Σ allocated per purchase id. */
export function paidByPurchase(payments: Pick<AdBluePayment, "allocations">[]): Map<string, number> {
  const paid = new Map<string, number>()
  for (const p of payments) for (const a of p.allocations) paid.set(a.purchaseId, round2((paid.get(a.purchaseId) ?? 0) + a.amount))
  return paid
}

/* ------------------------------------------------------------------ payments */

/** A payment's total settled: paid to the vendor + TDS deducted. */
export const settledOf = (p: Pick<AdBluePayment, "amount" | "tdsAmount">) => round2(p.amount + (p.tdsAmount ?? 0))
/** What is left of a payment for purchases: its advance credit. */
export const unallocated = (p: Pick<AdBluePayment, "amount" | "tdsAmount" | "allocations">) => round2(settledOf(p) - sum2(p.allocations.map((a) => a.amount)))

/** TDS on a total settled: TDS = round2(total × % / 100), paid to the vendor = the rest. */
export function tdsSplit(total: number, percent: number) {
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
  if (Number.isFinite(total) && total > 0 && !(tdsSplit(total, percent).paid > 0)) return "Nothing would be paid to the vendor after TDS"
  return null
}

export type AllocationStatus = "FULL" | "PARTIAL" | "ADVANCE"
export const ALLOCATION_STATUS_LABEL: Record<AllocationStatus, string> = { FULL: "Fully allocated", PARTIAL: "Partially allocated", ADVANCE: "Advance / Unallocated" }
export const allocationStatus = (p: AdBluePayment): AllocationStatus => (unallocated(p) === 0 ? "FULL" : p.allocations.length ? "PARTIAL" : "ADVANCE")

/** An allocation's share of its payment's TDS (display: allocation × TDS ÷ settled). */
export const allocationTds = (p: Pick<AdBluePayment, "amount" | "tdsAmount">, amount: number) => (p.tdsAmount ? round2((amount * p.tdsAmount) / settledOf(p)) : 0)

export interface PaymentDraft {
  date: string
  /** The total settled (paid to the vendor + TDS). */
  amount: number
  mode: string
  utr: string
  allocations: { purchaseId: string; amount: number }[]
  /** The unallocated part is meant as advance credit (explicit, never assumed). */
  acceptAdvance?: boolean
}

/**
 * What's wrong with a payment, or null — the same rules in the dialogs and the API. `outstanding(purchaseId)`: what the
 * purchase still owes (undefined = not a payable purchase of this vendor).
 */
export function paymentProblem(p: PaymentDraft, today: string, outstanding: (purchaseId: string) => number | undefined, label: (purchaseId: string) => string = (id) => id): string | null {
  if (!isCalendarDate(p.date ?? "")) return "Enter the payment date"
  if (p.date > today) return "A payment can't be dated in the future."
  if (p.mode === CREDIT) return "Credit means nothing is paid now — there is no payment to record."
  if (!(ADBLUE_PAYMENT_MODES as readonly string[]).includes(p.mode)) return "Choose how it was paid (Cash, UPI, NEFT, RTGS, IMPS or Cheque)"
  if (!(Number.isFinite(p.amount) && p.amount > 0)) return "The payment amount must be more than ₹0"
  if (!paise(p.amount)) return "Amount: up to 2 decimals (paise)"
  if (!(p.utr ?? "").trim()) return `Enter the ${referenceNoun(p.mode)} — it is required for a ${p.mode} payment.`
  const seen = new Set<string>()
  for (const a of p.allocations) {
    if (seen.has(a.purchaseId)) return `${label(a.purchaseId)} is listed twice`
    seen.add(a.purchaseId)
    const left = outstanding(a.purchaseId)
    if (left === undefined) return `${label(a.purchaseId)} isn't a purchase from this vendor`
    if (!(Number.isFinite(a.amount) && a.amount > 0) || !paise(a.amount)) return `${label(a.purchaseId)}: enter an amount more than ₹0 (up to 2 decimals)`
    if (a.amount > left) return `${label(a.purchaseId)}: ₹${a.amount.toFixed(2)} is more than its outstanding ₹${left.toFixed(2)}`
  }
  const allocated = sum2(p.allocations.map((a) => a.amount))
  if (allocated > p.amount) return `The allocations (₹${allocated.toFixed(2)}) are more than the payment (₹${p.amount.toFixed(2)})`
  const rest = round2(p.amount - allocated)
  if (rest > 0 && !p.acceptAdvance) return `₹${rest.toFixed(2)} of this payment isn't allocated to any purchase. Allocate it, or record it as advance credit with the vendor.`
  return null
}

/**
 * "Allocate oldest first": `amount` spread over the purchases in the order given (oldest first), each up to what it still
 * owes; locked ones skipped. A suggestion shown in the dialog (editable) — never saved without the user.
 */
export function allocateOldestFirst(amount: number, rows: { id: string; left: number; locked?: boolean }[]): Record<string, number> {
  let rest = round2(amount)
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (rest <= 0) break
    if (r.locked || r.left <= 0) continue
    const take = round2(Math.min(rest, r.left))
    out[r.id] = take
    rest = round2(rest - take)
  }
  return out
}

/* ------------------------------------------------------------------ vendor accounts and ledger */

export interface VendorAccount {
  vendorId: string
  /** Σ purchase values (taxable + GST). */
  purchased: number
  /** Σ litres bought (every purchase of the vendor). */
  litres: number
  /** Σ payments' total settled: cash paid + TDS. */
  settled: number
  /** Σ paid to the vendor (cash / bank). */
  cashPaid: number
  /** Σ TDS deducted. */
  tds: number
  /** Σ of each purchase's outstanding amount. */
  outstanding: number
  /** Σ of the payments' unallocated amounts. */
  advance: number
  /** Purchased − Settled (= outstanding − advance): + payable to the vendor, − advance with it. */
  balance: number
  purchases: number
  payments: number
}

type P = Pick<AdBluePurchase, "id" | "date" | "createdAt" | "adblueVendorId" | "totalCost" | "gstRate" | "totalLitres" | "opening">

/** One account per vendor with a payable purchase or a payment — the complete history, never one period's. */
export function vendorAccounts(purchases: P[], payments: AdBluePayment[]): VendorAccount[] {
  const paid = paidByPurchase(payments)
  const acc = new Map<string, VendorAccount>()
  const of = (vendorId: string) => acc.get(vendorId) ?? acc.set(vendorId, { vendorId, purchased: 0, litres: 0, settled: 0, cashPaid: 0, tds: 0, outstanding: 0, advance: 0, balance: 0, purchases: 0, payments: 0 }).get(vendorId)!
  for (const x of purchases.filter(isPayable)) {
    const a = of(x.adblueVendorId!)
    const pay = purchasePay(purchaseValue(x), paid.get(x.id) ?? 0)
    a.purchased = round2(a.purchased + pay.value)
    a.litres = round2(a.litres + x.totalLitres)
    a.outstanding = round2(a.outstanding + pay.outstanding)
    a.purchases++
  }
  for (const p of payments) {
    const a = of(p.vendorId)
    a.settled = round2(a.settled + settledOf(p))
    a.cashPaid = round2(a.cashPaid + p.amount)
    a.tds = round2(a.tds + (p.tdsAmount ?? 0))
    a.advance = round2(a.advance + unallocated(p))
    a.payments++
  }
  for (const a of acc.values()) a.balance = round2(a.purchased - a.settled)
  return [...acc.values()]
}

export interface LedgerRow {
  date: string
  kind: "PURCHASE" | "PAYMENT"
  id: string
  /** Debit = a purchase's value (we owe the vendor more); Credit = a payment's total settled (we owe less). */
  debit: number
  credit: number
  /** Payments: the credit's split — paid to the vendor and TDS deducted. */
  paid: number
  tds: number
  /** Running Σ debit − Σ credit: + payable to the vendor, − advance with it. */
  balance: number
}

/**
 * The vendor's account in date order (a purchase before a payment on the same day, then as entered). Purchases are
 * debits (what we owe grows), payments credits (it shrinks); the last balance = Purchased − Settled. No opening balance
 * exists for AdBlue vendors.
 */
export function vendorLedger(purchases: P[], payments: AdBluePayment[], vendorId: string): LedgerRow[] {
  const rows = [
    ...purchases.filter((x) => isPayable(x) && x.adblueVendorId === vendorId).map((x) => ({ date: x.date, at: x.createdAt, kind: "PURCHASE" as const, id: x.id, debit: purchaseValue(x), credit: 0, paid: 0, tds: 0 })),
    ...payments.filter((p) => p.vendorId === vendorId).map((p) => ({ date: p.date, at: p.createdAt, kind: "PAYMENT" as const, id: p.id, debit: 0, credit: settledOf(p), paid: p.amount, tds: p.tdsAmount ?? 0 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "PURCHASE" ? -1 : 1) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  let balance = 0
  return rows.map((r) => ({ date: r.date, kind: r.kind, id: r.id, debit: r.debit, credit: r.credit, paid: r.paid, tds: r.tds, balance: (balance = round2(balance + r.debit - r.credit)) }))
}

/** Totals over every vendor (the AdBlue page's money cards): payables and advances never netted across vendors. */
export function supplierTotals(accounts: VendorAccount[]) {
  const s = (f: (a: VendorAccount) => number) => round2(accounts.reduce((t, a) => t + f(a), 0))
  return { purchased: s((a) => a.purchased), settled: s((a) => a.settled), cashPaid: s((a) => a.cashPaid), tds: s((a) => a.tds), outstanding: s((a) => a.outstanding), advance: s((a) => a.advance) }
}

/** A filter period: "ALL", a month "yyyy-MM", "FY:2026" or "RANGE" (from / to). */
export function periodRange(f: { period: string; from: string; to: string }): { from: string; to: string } | null {
  if (f.period === "ALL") return null
  if (f.period === "RANGE") return { from: f.from || "0000-01-01", to: f.to || "9999-12-31" }
  if (f.period.startsWith("FY:")) return fyRange(Number(f.period.slice(3)))
  return { from: `${f.period}-01`, to: `${f.period}-31` }
}
