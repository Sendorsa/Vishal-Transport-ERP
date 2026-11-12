/**
 * AdBlue inventory — physical stock in litres, bought in bulk and drawn by vehicles. Calculated
 * from transactions only (purchases + vehicle AdBlue entries), never stored, so it is reproducible.
 * Completely separate from the fuel station ledger (money owed to pumps).
 *
 *   Purchase        Total Litres = Buckets × Litres per Bucket; Total Cost = Buckets × Price per Bucket
 *   Stock           Σ purchased litres − Σ consumed litres (never below 0 at any point in time)
 *   Valuation       moving weighted average: each purchase re-averages the rate; each consumption
 *                   is valued at the rate at that moment (cost = litres × average rate)
 *   Inventory Value stock value after the last event (= Σ purchase cost − Σ consumption cost)
 *   Monthly ledger  Opening + Purchased − Consumed = Closing; Closing → next month's Opening
 *
 * Event order: date ASC; on the same day purchases come before consumption; then createdAt, id.
 */
import { addMonths, format, parseISO } from "date-fns"
import { round2 } from "@/lib/format"

interface Purchase {
  id: string
  date: string
  createdAt?: string
  totalLitres: number
  totalCost: number
  vendorName?: string
  /** Opening stock (fresh start): litres and value already on hand — never a purchase. */
  opening?: boolean
}
interface Consumption {
  id: string
  date: string
  createdAt?: string
  quantityLitres: number
}

type Event = { kind: "IN"; p: Purchase } | { kind: "OUT"; c: Consumption }

const eventOrder = (a: Event, b: Event) => {
  const da = a.kind === "IN" ? a.p : a.c
  const db = b.kind === "IN" ? b.p : b.c
  return da.date.localeCompare(db.date) || (a.kind === b.kind ? 0 : a.kind === "IN" ? -1 : 1) || (da.createdAt ?? "").localeCompare(db.createdAt ?? "") || da.id.localeCompare(db.id)
}

export interface Valuation {
  /** Consumption entry id → its cost at the weighted-average rate when it was drawn. */
  costOf: Map<string, number>
  stockLitres: number
  stockValue: number
  /** Current weighted-average ₹ per litre (null when stock is 0). */
  avgRate: number | null
  /** First moment stock would go below zero, if any (for validation). */
  shortfall: { date: string; available: number; needed: number; consumptionId: string } | null
}

/** Runs every purchase and consumption in order through a moving weighted average. */
export function valueInventory(purchases: Purchase[], consumptions: Consumption[]): Valuation {
  const events: Event[] = [...purchases.map((p) => ({ kind: "IN" as const, p })), ...consumptions.map((c) => ({ kind: "OUT" as const, c }))].sort(eventOrder)
  let litres = 0
  let value = 0
  const costOf = new Map<string, number>()
  let shortfall: Valuation["shortfall"] = null
  for (const e of events) {
    if (e.kind === "IN") {
      litres += e.p.totalLitres
      value += e.p.totalCost
      continue
    }
    const q = e.c.quantityLitres
    if (q > litres + 1e-9 && !shortfall) shortfall = { date: e.c.date, available: round2(litres), needed: q, consumptionId: e.c.id }
    const rate = litres > 0 ? value / litres : 0
    const cost = round2(Math.min(q, litres) * rate)
    costOf.set(e.c.id, cost)
    value = litres - q > 1e-9 ? value - cost : 0
    litres = Math.max(0, litres - q)
  }
  return { costOf, stockLitres: round2(litres), stockValue: round2(value), avgRate: litres > 0 ? round2(value / litres) : null, shortfall }
}

/** "Insufficient AdBlue inventory. Available stock: 5L" */
export const insufficientMessage = (available: number) => `Insufficient AdBlue inventory. Available stock: ${round2(available)}L`

export interface StockRow {
  month: string
  opening: number
  /** Opening-stock records dated in the month (fresh start) — stock, never a purchase. */
  openingStock: number
  purchased: number
  consumed: number
  closing: number
  /** ₹ bought and ₹ drawn (at weighted-average cost) in the month. */
  purchasedCost: number
  consumedCost: number
}

/** Month-by-month stock ledger from the first activity through `throughMonth` (default: last activity). */
export function inventoryLedger(purchases: Purchase[], consumptions: Consumption[], throughMonth?: string): StockRow[] {
  const { costOf } = valueInventory(purchases, consumptions)
  const by = new Map<string, { openingStock: number; purchased: number; consumed: number; purchasedCost: number; consumedCost: number }>()
  const at = (m: string) => by.get(m) ?? (by.set(m, { openingStock: 0, purchased: 0, consumed: 0, purchasedCost: 0, consumedCost: 0 }), by.get(m)!)
  for (const p of purchases) {
    const r = at(p.date.slice(0, 7))
    if (p.opening) {
      r.openingStock += p.totalLitres
      continue
    }
    r.purchased += p.totalLitres
    r.purchasedCost += p.totalCost
  }
  for (const c of consumptions) {
    const r = at(c.date.slice(0, 7))
    r.consumed += c.quantityLitres
    r.consumedCost += costOf.get(c.id) ?? 0
  }
  const active = [...by.keys()].sort()
  if (!active.length) return []
  const last = throughMonth && throughMonth > active.at(-1)! ? throughMonth : active.at(-1)!
  const rows: StockRow[] = []
  let stock = 0
  for (let m = active[0]; m <= last; m = format(addMonths(parseISO(`${m}-01`), 1), "yyyy-MM")) {
    const r = by.get(m) ?? { openingStock: 0, purchased: 0, consumed: 0, purchasedCost: 0, consumedCost: 0 }
    const closing = round2(stock + r.openingStock + r.purchased - r.consumed)
    rows.push({ month: m, opening: stock, openingStock: round2(r.openingStock), purchased: round2(r.purchased), consumed: round2(r.consumed), closing, purchasedCost: round2(r.purchasedCost), consumedCost: round2(r.consumedCost) })
    stock = closing
  }
  return rows
}

/** A period (list of yyyy-MM months; omit for all time): opening before it, Σ in/out, closing. */
export function stockFor(rows: StockRow[], months?: string[]) {
  const inPeriod = months ? rows.filter((r) => months.includes(r.month)) : rows
  const first = months ? months[0] : rows[0]?.month
  const before = rows.filter((r) => first !== undefined && r.month < first).at(-1)
  const opening = months ? (before?.closing ?? 0) : 0
  const sum = (f: (r: StockRow) => number) => round2(inPeriod.reduce((t, r) => t + f(r), 0))
  const openingStock = sum((r) => r.openingStock)
  const purchased = sum((r) => r.purchased)
  const consumed = sum((r) => r.consumed)
  return { opening, openingStock, purchased, consumed, closing: round2(opening + openingStock + purchased - consumed), purchasedCost: sum((r) => r.purchasedCost), consumedCost: sum((r) => r.consumedCost), carriedFrom: before?.month ?? null }
}

/** Per vendor: litres, amount and average ₹ per litre purchased. */
export function vendorAnalytics(purchases: Purchase[]) {
  const m = new Map<string, { litres: number; amount: number; purchases: number }>()
  for (const p of purchases) {
    if (p.opening) continue // opening stock was bought from nobody in the period
    const k = p.vendorName?.trim() || "Unknown"
    const r = m.get(k) ?? { litres: 0, amount: 0, purchases: 0 }
    m.set(k, { litres: r.litres + p.totalLitres, amount: r.amount + p.totalCost, purchases: r.purchases + 1 })
  }
  return [...m].map(([vendor, r]) => ({ vendor, litres: round2(r.litres), amount: round2(r.amount), purchases: r.purchases, avgRate: r.litres ? round2(r.amount / r.litres) : null }))
}

/**
 * AdBlue bought in a period — only purchase batches dated in it. Carry-forward stock and the value
 * of stock already held never enter it (that is Inventory Value, a different figure).
 */
export function purchasedIn<P extends Purchase>(purchases: P[], inPeriod: (p: P) => boolean) {
  const list = purchases.filter((p) => !p.opening && inPeriod(p))
  const litres = round2(list.reduce((t, p) => t + p.totalLitres, 0))
  const cost = round2(list.reduce((t, p) => t + p.totalCost, 0))
  return { litres, cost, purchases: list.length, vendors: new Set(list.map((p) => p.vendorName?.trim() || "Unknown")).size, avgRate: litres ? round2(cost / litres) : null }
}

/**
 * Uncle's answer 25 — AdBlue reaches a vehicle two ways:
 *   STOCK  (default) bought in bulk into inventory, then drawn by the vehicle (costed at the weighted average)
 *   DIRECT bought from a vendor straight into the vehicle: litres × its own rate; never enters or leaves bulk stock
 * A direct purchase is never a bulk purchase and never a draw, so it can't be counted twice.
 */
export const isDirectAdBlue = (e: { source?: "STOCK" | "DIRECT" }) => e.source === "DIRECT"

/** Vehicle AdBlue entries that draw from bulk inventory (direct vendor purchases left out). */
export const stockDraws = <E extends { source?: "STOCK" | "DIRECT" }>(entries: E[]) => entries.filter((e) => !isDirectAdBlue(e))

type Stock = { stockLitres: number; stockValue: number; avgRate: number | null }

/**
 * Company-wide AdBlue figures by month — totals only (owner, 11 Nov 2026): the AdBlue page's stock, ledger and
 * consumption figures, computed on the server from every record, so Tata Adblue sees the whole company's AdBlue without
 * any single entry (no id, vehicle, customer or entry date) of a customer it wasn't granted.
 */
export interface AdBlueTotals {
  /** The monthly stock ledger, first activity → `throughMonth`. */
  ledger: StockRow[]
  current: Stock
  /** Stock and value at each ledger month's end. */
  monthEnd: ({ month: string } & Stock)[]
  /** Direct vendor purchases per month (never bulk stock). */
  direct: { month: string; litres: number; cost: number; count: number }[]
}

export function adBlueTotals(purchases: Purchase[], entries: (Consumption & { amount: number; source?: "STOCK" | "DIRECT" })[], throughMonth: string): AdBlueTotals {
  const draws = stockDraws(entries).map(({ id, date, createdAt, quantityLitres }) => ({ id, date, createdAt, quantityLitres }))
  const stock = (v: Valuation): Stock => ({ stockLitres: v.stockLitres, stockValue: v.stockValue, avgRate: v.avgRate })
  const ledger = inventoryLedger(purchases, draws, throughMonth)
  const upTo = (m: string) => (e: { date: string }) => e.date.slice(0, 7) <= m
  const direct = new Map<string, { litres: number; cost: number; count: number }>()
  for (const e of entries.filter(isDirectAdBlue)) {
    const r = direct.get(e.date.slice(0, 7)) ?? { litres: 0, cost: 0, count: 0 }
    direct.set(e.date.slice(0, 7), { litres: r.litres + e.quantityLitres, cost: r.cost + e.amount, count: r.count + 1 })
  }
  return {
    ledger,
    current: stock(valueInventory(purchases, draws)),
    monthEnd: ledger.map((r) => ({ month: r.month, ...stock(valueInventory(purchases.filter(upTo(r.month)), draws.filter(upTo(r.month)))) })),
    direct: [...direct].sort().map(([month, r]) => ({ month, litres: round2(r.litres), cost: round2(r.cost), count: r.count })),
  }
}

/** A period's figures from the totals (months: the period's yyyy-MM list; undefined = all time). */
export function totalsFor(t: AdBlueTotals, months: string[] | undefined, endedMonth: string | null) {
  const inPeriod = (m: string) => !months || months.includes(m)
  const d = t.direct.filter((r) => inPeriod(r.month))
  const sum = (f: (r: (typeof d)[number]) => number) => round2(d.reduce((s, r) => s + f(r), 0))
  const end = endedMonth ? ([...t.monthEnd].reverse().find((r) => r.month <= endedMonth) ?? { stockLitres: 0, stockValue: 0, avgRate: null }) : t.current
  return { stock: end, directCost: sum((r) => r.cost), directLitres: sum((r) => r.litres), directCount: d.reduce((s, r) => s + r.count, 0) }
}
