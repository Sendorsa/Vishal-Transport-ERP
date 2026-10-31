/**
 * Fuel station ledger — what we owe each station, month by month. Calculated from transactions
 * only (never stored, fuel records never modified), so it is reproducible:
 *
 *   Fuel Purchased  = every fuel fill + Diesel Tanker load at the station in the month
 *                     (= the station's transaction history, credit and cash alike; AdBlue is inventory)
 *   Payments Made   = Voucher payments (NEFT / UPI / cheque "Diesel vendor payment" vouchers)
 *                   + Manual cash payments (the same vouchers with mode CASH)
 *                   + Cash-at-pump payments (cash fills: a purchase and its payment at once)
 *                   + TDS deducted (`tdsAmount` on a voucher: settles what we owe the pump, never hits the bank)
 *                     — every one of them is a row in the station's payment history
 *   Closing         = Opening + Fuel Purchased − Payments Made
 *   Opening         = previous month's Closing (carried forward; 0 before the first activity)
 *
 *   Closing > 0 → Debit  (we owe the station)      Closing < 0 → Credit (paid in advance)
 *
 * A quarter / year / all-time ledger is the same chain: opening of its first month, Σ purchases,
 * Σ payments, closing — so monthly, quarterly and yearly figures always reconcile.
 */
import { addMonths, endOfMonth, format, parseISO } from "date-fns"
import { round2 } from "@/lib/format"

export const STATION_PAYMENT_CATEGORY = "DIESEL_SETTLEMENT"

interface Purchase {
  id?: string
  vehicleId?: string
  billNo?: string
  createdAt?: string
  vendorId: string
  date: string
  amount: number
  /** Diesel fills: CASH is paid at the pump (purchase + payment). AdBlue entries have none (on account). */
  paymentMode?: "CREDIT" | "CASH"
}
interface StationPayment {
  mode?: string
  /** TDS deducted on the purchase (u/s 194Q) — counts as paid to the station, but goes to the government, not the bank. */
  tdsAmount?: number
  vendorId: string | null
  date: string
  amount: number
  direction: "IN" | "OUT"
  categoryCode: string | null
  /** "yyyy-MM": the month's purchases this payment was paid against (informational; the ledger uses `date`). */
  forMonth?: string
}

export interface LedgerRow {
  month: string
  opening: number
  purchased: number
  /** vouchers + manualCash + cashAtPump */
  paid: number
  /** Non-cash vouchers (NEFT / UPI / cheque). */
  vouchers: number
  /** Vouchers paid in cash at the office. */
  manualCash: number
  cashAtPump: number
  /** TDS deducted on the station's bills. */
  tds: number
  closing: number
}

export const isStationPayment = (p: StationPayment, stationId: string) => p.direction === "OUT" && p.vendorId === stationId && p.categoryCode === STATION_PAYMENT_CATEGORY

/** A station's balance before its first ledger month (FuelStation.openingBalance / openingBalanceDate). */
export interface StationOpening {
  date: string
  amount: number
}

export const openingOf = (s: { openingBalance?: number; openingBalanceDate?: string }): StationOpening | undefined =>
  s.openingBalanceDate && s.openingBalance ? { date: s.openingBalanceDate, amount: s.openingBalance } : undefined

/**
 * Month-by-month ledger from the first activity (or the opening balance's month, if earlier)
 * through `throughMonth` (default: last activity). The first month opens at `opening`, else 0.
 */
export function stationLedger(stationId: string, purchases: Purchase[], payments: StationPayment[], throughMonth?: string, opening?: StationOpening): LedgerRow[] {
  const bought = new Map<string, number>()
  const cash = new Map<string, number>()
  const paid = new Map<string, number>()
  const manual = new Map<string, number>()
  const tdsBy = new Map<string, number>()
  const add = (m: Map<string, number>, date: string, n: number) => m.set(date.slice(0, 7), (m.get(date.slice(0, 7)) ?? 0) + n)
  for (const p of purchases) {
    if (p.vendorId !== stationId) continue
    add(bought, p.date, p.amount)
    if (p.paymentMode === "CASH") add(cash, p.date, p.amount)
  }
  for (const p of payments)
    if (isStationPayment(p, stationId)) {
      if (p.amount) add(p.mode === "CASH" ? manual : paid, p.date, p.amount)
      if (p.tdsAmount) add(tdsBy, p.date, p.tdsAmount)
    }
  const active = [...bought.keys(), ...paid.keys(), ...manual.keys(), ...tdsBy.keys(), ...(opening ? [opening.date.slice(0, 7)] : [])].sort()
  if (!active.length) return []
  const last = throughMonth && throughMonth > active.at(-1)! ? throughMonth : active.at(-1)!
  const rows: LedgerRow[] = []
  let balance = opening && opening.date.slice(0, 7) <= active[0] ? round2(opening.amount) : 0
  for (let m = active[0]; m <= last; m = format(addMonths(parseISO(`${m}-01`), 1), "yyyy-MM")) {
    const p = round2(bought.get(m) ?? 0)
    const vouchers = round2(paid.get(m) ?? 0)
    const manualCash = round2(manual.get(m) ?? 0)
    const cashAtPump = round2(cash.get(m) ?? 0)
    const tds = round2(tdsBy.get(m) ?? 0)
    const q = round2(vouchers + manualCash + cashAtPump + tds)
    const closing = round2(balance + p - q)
    rows.push({ month: m, opening: balance, purchased: p, paid: q, vouchers, manualCash, cashAtPump, tds, closing })
    balance = closing
  }
  return rows
}

/**
 * Ledger for any period, given as the list of yyyy-MM months it covers (a month, a quarter, a
 * year; omit for all time). Opening = closing before the period; rows outside it are ignored.
 */
export function ledgerFor(rows: LedgerRow[], months?: string[]) {
  const inPeriod = months ? rows.filter((r) => months.includes(r.month)) : rows
  const first = months ? months[0] : rows[0]?.month
  const before = rows.filter((r) => first !== undefined && r.month < first).at(-1)
  // No earlier month: the ledger's own opening balance, if the period reaches its first month.
  const start = rows[0] && (!months || (rows[0].month >= first! && rows[0].month <= months.at(-1)!)) ? rows[0].opening : 0
  const opening = before?.closing ?? start
  const purchased = round2(inPeriod.reduce((t, r) => t + r.purchased, 0))
  const paid = round2(inPeriod.reduce((t, r) => t + r.paid, 0))
  const vouchers = round2(inPeriod.reduce((t, r) => t + r.vouchers, 0))
  const manualCash = round2(inPeriod.reduce((t, r) => t + r.manualCash, 0))
  const cashAtPump = round2(inPeriod.reduce((t, r) => t + r.cashAtPump, 0))
  const tds = round2(inPeriod.reduce((t, r) => t + r.tds, 0))
  return { opening, purchased, paid, vouchers, manualCash, cashAtPump, tds, closing: round2(opening + purchased - paid), carriedFrom: before?.month ?? null }
}

/* ------------------------------------------------------------------ Payment history */

export type StationPaymentKind = "VOUCHER" | "MANUAL_CASH" | "CASH_AT_PUMP" | "TDS"

/** One row of a station's payment history — a voucher, or a cash fill shown as its payment. */
export interface StationPaymentRow {
  /** Voucher id, or AUTO-CASH-{fuel entry id} for a cash fill. */
  id: string
  /** Voucher number, or AUTO-CASH-{fuel entry id}. */
  reference: string
  date: string
  createdAt?: string
  amount: number
  kind: StationPaymentKind
  mode: string
  companyCode?: string
  notes: string
  /** "yyyy-MM" the payment was paid against; null = not recorded (payments saved before 31 Oct 2026). */
  forMonth: string | null
  /** Cash at pump: the fuel entry it comes from. */
  linkedEntryId?: string
  vehicleId?: string
  billNo?: string
  /** System-generated rows (cash at pump) can't be edited or deleted — they follow the fuel entry. */
  readOnly: boolean
}

interface HistoryVoucher extends StationPayment {
  id: string
  paymentNo: string
  createdAt?: string
  companyCode?: string
  notes: string
}

/**
 * Everything counted in Payments Made, as rows: vouchers, manual cash vouchers and an
 * auto-generated "Cash at Pump" row per cash fill (derived on read, never stored — it can't
 * drift from the fill, and there is nothing to edit or delete). Σ amount = ledger Payments Made.
 */
export function stationPaymentHistory(stationId: string, payments: HistoryVoucher[], purchases: Purchase[]): StationPaymentRow[] {
  return [
    ...payments
      .filter((p) => isStationPayment(p, stationId))
      .map((p): StationPaymentRow => ({
        id: p.id,
        reference: p.paymentNo,
        date: p.date,
        createdAt: p.createdAt,
        amount: round2(p.amount + (p.tdsAmount ?? 0)),
        kind: !p.amount && p.tdsAmount ? "TDS" : p.mode === "CASH" ? "MANUAL_CASH" : "VOUCHER",
        mode: p.mode ?? "",
        companyCode: p.companyCode,
        notes: p.notes,
        forMonth: p.forMonth ?? (!p.amount && p.tdsAmount ? p.date.slice(0, 7) : null),
        readOnly: false,
      })),
    ...purchases
      .filter((f) => f.vendorId === stationId && f.paymentMode === "CASH")
      .map((f): StationPaymentRow => ({
        id: `AUTO-CASH-${f.id}`,
        reference: `AUTO-CASH-${f.id}`,
        date: f.date,
        createdAt: f.createdAt,
        amount: f.amount,
        kind: "CASH_AT_PUMP",
        mode: "CASH",
        notes: "Cash paid at the pump for this fuel fill",
        forMonth: f.date.slice(0, 7),
        linkedEntryId: f.id,
        vehicleId: f.vehicleId,
        billNo: f.billNo,
        readOnly: true,
      })),
  ]
}

/* ------------------------------------------------------------------ Payment timing */

/*
 * A station payment can be recorded at any time — no grace period (owner, 31 Oct 2026). It sits in the ledger on its
 * payment date (the day the money was paid); `forMonth` records which month's purchases it was paid against, which
 * never moves it in the ledger. Back-dating a payment into a locked month follows the Monthly Sheet Lock (Owner only).
 */

/* ------------------------------------------------------------------ TDS on fuel purchases (uncle's answer 14) */

/**
 * TDS on a station's fuel bills: 0.1% of the station's total Fuel Purchased in the calendar month, dated the
 * last day of that month. One TDS entry per station per month. Kept exact to the paisa — the source books
 * show whole rupees, but no rounding rule has been confirmed (open question in issues.md, Problem 14).
 */
export const FUEL_TDS_PERCENT = 0.1

export const tdsDue = (monthPurchased: number) => round2((monthPurchased * FUEL_TDS_PERCENT) / 100)

/** Last calendar day of a yyyy-MM month — the TDS date. */
export const tdsDate = (month: string) => format(endOfMonth(parseISO(`${month}-01`)), "yyyy-MM-dd")

/** Debit (we owe) / Credit (advance) / Settled. */
export const balanceType = (closing: number) => (closing > 0 ? "DEBIT" : closing < 0 ? "CREDIT" : "SETTLED")
