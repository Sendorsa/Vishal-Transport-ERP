/**
 * AdBlue inventory — physical stock in litres, bought in bulk and drawn by vehicles. Calculated
 * from transactions only (purchases + vehicle AdBlue entries), never stored, so it is reproducible.
 * Completely separate from the fuel station ledger (money owed to pumps).
 *
 *   Purchase        Total Litres = Buckets × Litres per Bucket; Total Cost = Buckets × Price per Bucket
 *   Batches         every purchase is a batch of its vendor (owner, 16 Nov 2026); opening stock and purchases without
 *                   a vendor are "No vendor" batches
 *   Costing         FIFO: a draw naming a vendor takes that vendor's oldest batches first; a draw without a vendor
 *                   takes unattributed stock ("No vendor": opening stock, and stock whose vendor is unknown) only.
 *                   Each litre is costed at its batch's rate, so a draw across two batches costs Σ litres × each rate
 *   Old draws       a draw recorded before vendor tracking (`beforeVendorTracking`, no vendor) never gets a vendor
 *                   guessed: when only one source held stock at that moment it took that source (the records leave
 *                   no other possibility); when two or more did, which one it used is unknown, so ALL the stock on
 *                   hand at that moment becomes unattributed ("moves"), and the draw takes it oldest first. Litres
 *                   and value are only relabelled, so Σ every vendor + unattributed = company stock, always
 *   Stock           Σ purchased litres − Σ consumed litres, per vendor and in total (never below 0 at any point in time)
 *   Inventory Value Σ value left in the batches (= Σ purchase cost − Σ consumption cost)
 *   Monthly ledger  Opening + Purchased − Consumed = Closing; Closing → next month's Opening
 *
 * Event order: date ASC; on the same day purchases come before consumption; then createdAt, id.
 */
import { addMonths, format, parseISO } from "date-fns"
import { round2 } from "@/lib/format"
import { purchaseValue } from "./adblue-payments"

interface Purchase {
  id: string
  date: string
  createdAt?: string
  totalLitres: number
  totalCost: number
  vendorName?: string
  /** The AdBlue vendor master record (null / absent: "No vendor"). */
  adblueVendorId?: string | null
  /** Opening stock (fresh start): litres and value already on hand — never a purchase. */
  opening?: boolean
  /** GST % on the bill (owed to the vendor; stock is costed before GST). */
  gstRate?: number | null
}
interface Consumption {
  id: string
  date: string
  createdAt?: string
  quantityLitres: number
  /** The vendor whose stock the draw takes (null / absent: unattributed stock). */
  adblueVendorId?: string | null
  /** Recorded before vendor tracking (16 Nov 2026): its vendor was never recorded and is never guessed. */
  beforeVendorTracking?: boolean
}

/** Vendor key of a batch or draw: the vendor id, or "" for none. */
export const NO_VENDOR = ""
export const vendorKey = (x: { adblueVendorId?: string | null }) => x.adblueVendorId || NO_VENDOR
export const NO_VENDOR_LABEL = "Unattributed stock (no vendor)"

type Event = { kind: "IN"; p: Purchase } | { kind: "OUT"; c: Consumption }

const eventOrder = (a: Event, b: Event) => {
  const da = a.kind === "IN" ? a.p : a.c
  const db = b.kind === "IN" ? b.p : b.c
  return da.date.localeCompare(db.date) || (a.kind === b.kind ? 0 : a.kind === "IN" ? -1 : 1) || (da.createdAt ?? "").localeCompare(db.createdAt ?? "") || da.id.localeCompare(db.id)
}

/** A vendor's stock that became unattributed at an old draw (vendor unknown): litres and value, relabelled only. */
export interface Move {
  consumptionId: string
  /** The purchase batch (lot) whose stock became unattributed. */
  purchaseId: string
  date: string
  vendor: string
  litres: number
  value: number
}

/** Litres a draw took from one vendor's batch, and their cost. */
export interface Take {
  consumptionId: string
  /** The purchase batch (lot) the litres came from. */
  purchaseId: string
  date: string
  vendor: string
  litres: number
  cost: number
}

export interface Valuation {
  /** Consumption entry id → its FIFO cost. */
  costOf: Map<string, number>
  stockLitres: number
  stockValue: number
  /** Stock value ÷ stock litres (null when stock is 0). */
  avgRate: number | null
  /** Litres and value left per vendor key (NO_VENDOR = ""). */
  vendorStock: Map<string, { litres: number; value: number }>
  /** Every batch portion each draw took, in event order. */
  takes: Take[]
  /** Vendor stock that became unattributed at old draws, in event order (Σ litres in = Σ litres out: never counted twice). */
  moves: Move[]
  /** Every purchase batch (lot) after the last event: litres and value left, and whose stock it is now (NO_VENDOR once unattributed). */
  lots: { purchaseId: string; vendor: string; litres: number; value: number }[]
  /**
   * First moment stock would go below zero, if any — of the draw's vendor, of unattributed stock (vendor NO_VENDOR) for
   * a new draw without one while vendors hold stock too, or in total (vendor null: an old draw, or a draw without a
   * vendor when unattributed stock is all there is).
   */
  shortfall: { date: string; available: number; needed: number; consumptionId: string; vendor: string | null } | null
}

/** Runs every purchase and consumption in order through FIFO batches. */
export function valueInventory(purchases: Purchase[], consumptions: Consumption[]): Valuation {
  const events: Event[] = [...purchases.map((p) => ({ kind: "IN" as const, p })), ...consumptions.map((c) => ({ kind: "OUT" as const, c }))].sort(eventOrder)
  const lots: { purchaseId: string; vendor: string; litres: number; value: number }[] = []
  const costOf = new Map<string, number>()
  const takes: Take[] = []
  const moves: Move[] = []
  let shortfall: Valuation["shortfall"] = null
  for (const e of events) {
    if (e.kind === "IN") {
      lots.push({ purchaseId: e.p.id, vendor: vendorKey(e.p), litres: e.p.totalLitres, value: e.p.totalCost })
      continue
    }
    const want = e.c.adblueVendorId || null
    const old = want === null && !!e.c.beforeVendorTracking
    const open = lots.filter((l) => l.litres > 1e-9)
    // An old draw while two or more sources held stock: its source is unknown, so everything on hand becomes unattributed.
    if (old && new Set(open.map((l) => l.vendor)).size > 1)
      for (const l of open.filter((x) => x.vendor !== NO_VENDOR)) {
        moves.push({ consumptionId: e.c.id, purchaseId: l.purchaseId, date: e.c.date, vendor: l.vendor, litres: l.litres, value: l.value })
        l.vendor = NO_VENDOR
      }
    // Old draw: whatever is on hand (one source by now). New draw: its vendor's stock, or unattributed stock only.
    const pool = old ? open : open.filter((l) => l.vendor === (want ?? NO_VENDOR))
    const available = pool.reduce((t, l) => t + l.litres, 0)
    if (e.c.quantityLitres > available + 1e-9 && !shortfall) shortfall = { date: e.c.date, available: round2(available), needed: e.c.quantityLitres, consumptionId: e.c.id, vendor: old || (want === null && pool.length === open.length) ? null : (want ?? NO_VENDOR) }
    let left = e.c.quantityLitres
    let cost = 0
    for (const l of pool) {
      if (left <= 1e-9) break
      const take = Math.min(left, l.litres)
      const whole = take >= l.litres - 1e-9
      const part = whole ? l.value : round2((l.value * take) / l.litres) // the last litres of a batch take what is left of its value
      l.litres = whole ? 0 : l.litres - take
      l.value = whole ? 0 : round2(l.value - part)
      left -= take
      cost += part
      takes.push({ consumptionId: e.c.id, purchaseId: l.purchaseId, date: e.c.date, vendor: l.vendor, litres: take, cost: part })
    }
    costOf.set(e.c.id, round2(cost))
  }
  const vendorStock = new Map<string, { litres: number; value: number }>()
  for (const l of lots) {
    const r = vendorStock.get(l.vendor) ?? { litres: 0, value: 0 }
    vendorStock.set(l.vendor, { litres: round2(r.litres + l.litres), value: round2(r.value + l.value) })
  }
  const litres = lots.reduce((t, l) => t + l.litres, 0)
  const value = lots.reduce((t, l) => t + l.value, 0)
  return { costOf, stockLitres: round2(litres), stockValue: round2(value), avgRate: litres > 1e-9 ? round2(value / litres) : null, vendorStock, takes, moves, lots: lots.map((l) => ({ ...l, litres: round2(l.litres) })), shortfall }
}

export interface VendorStockUse {
  /** Litres vehicles drew from the vendor's lots while they were its stock (FIFO takes). */
  used: number
  /** Litres left in the vendor's lots that are still its stock. */
  remaining: number
  /** Litres of its lots that became unattributed at an old draw (vendor unknown) — counted under unattributed stock. */
  moved: number
}

/**
 * Used and remaining stock of the bulk lots dated in a period, as of today (owner, 24 Nov 2026: the Overview's vendor
 * table), read from `valueInventory`'s own lots and takes — never a second FIFO. Per vendor: Purchased = Used +
 * Remaining + Moved. Opening stock and stock whose vendor is unknown are never a vendor's: they are `unattributed`.
 * Σ vendors' remaining + unattributed remaining = the period lots' stock (all time: the bulk stock).
 */
export function bulkStockUse<P extends Purchase>(purchases: P[], draws: Consumption[], inPeriod: (p: P) => boolean) {
  const v = valueInventory(purchases, draws)
  const lots = new Map(purchases.filter(inPeriod).map((p) => [p.id, p]))
  const byVendor = new Map<string, VendorStockUse>()
  const unattributed = { opening: 0, used: 0, remaining: 0 }
  const row = (k: string) => byVendor.get(k) ?? byVendor.set(k, { used: 0, remaining: 0, moved: 0 }).get(k)!
  // A lot is its vendor's while its stock is labelled with that vendor; opening stock / no vendor / moved stock is not.
  const owner = (purchaseId: string, label: string) => {
    const p = lots.get(purchaseId)
    return !p ? null : p.adblueVendorId && label === p.adblueVendorId ? p.adblueVendorId : NO_VENDOR
  }
  for (const t of v.takes) {
    const k = owner(t.purchaseId, t.vendor)
    if (k === null) continue
    if (k === NO_VENDOR) unattributed.used += t.litres
    else row(k).used += t.litres
  }
  for (const l of v.lots) {
    const k = owner(l.purchaseId, l.vendor)
    if (k === null) continue
    if (k === NO_VENDOR) unattributed.remaining += l.litres
    else row(k).remaining += l.litres
  }
  for (const m of v.moves) if (lots.has(m.purchaseId)) row(m.vendor).moved += m.litres
  for (const p of lots.values()) if (p.opening) unattributed.opening += p.totalLitres
  const r = (x: VendorStockUse) => ({ used: round2(x.used), remaining: round2(x.remaining), moved: round2(x.moved) })
  return { byVendor: new Map([...byVendor].map(([k, x]) => [k, r(x)])), unattributed: { opening: round2(unattributed.opening), used: round2(unattributed.used), remaining: round2(unattributed.remaining) } }
}

/** "Insufficient AdBlue inventory. Available stock: 5L" */
export const insufficientMessage = (available: number) => `Insufficient AdBlue inventory. Available stock: ${round2(available)}L`
/** "Insufficient AdBlue stock from XYZ Chemicals. Available: 5L" — a draw naming a vendor is checked against that vendor's stock. */
export const insufficientVendorMessage = (vendor: string, available: number) => `Insufficient AdBlue stock from ${vendor}. Available: ${round2(available)}L`
/** The message for a shortfall: in total, unattributed stock, or a vendor's (`nameOf` gives the vendor's name). */
export const adBlueShortfallMessage = (s: NonNullable<Valuation["shortfall"]>, nameOf: (id: string) => string) =>
  s.vendor === null ? insufficientMessage(s.available) : s.vendor === NO_VENDOR ? `Not enough unattributed AdBlue stock (no vendor): ${round2(s.available)}L. Choose the vendor whose stock is used.` : insufficientVendorMessage(nameOf(s.vendor), s.available)

export interface StockRow {
  month: string
  opening: number
  /** Opening-stock records dated in the month (fresh start) — stock, never a purchase. */
  openingStock: number
  purchased: number
  consumed: number
  /** A vendor's ledger only: stock that became unattributed at old draws (− from the vendor, + to unattributed stock). */
  unattributed: number
  closing: number
  /** ₹ bought and ₹ drawn (at weighted-average cost) in the month. */
  purchasedCost: number
  consumedCost: number
}

type In = { date: string; totalLitres: number; totalCost: number; opening?: boolean }
type Out = { date: string; litres: number; cost: number }

/** Month-by-month stock ledger from the first activity through `throughMonth` (default: last activity). `moved`: signed litres relabelled to / from unattributed stock. */
function ledgerRows(ins: In[], outs: Out[], throughMonth?: string, moved: { date: string; litres: number }[] = []): StockRow[] {
  const empty = () => ({ openingStock: 0, purchased: 0, consumed: 0, unattributed: 0, purchasedCost: 0, consumedCost: 0 })
  const by = new Map<string, ReturnType<typeof empty>>()
  const at = (m: string) => by.get(m) ?? (by.set(m, empty()), by.get(m)!)
  for (const p of ins) {
    const r = at(p.date.slice(0, 7))
    if (p.opening) {
      r.openingStock += p.totalLitres
      continue
    }
    r.purchased += p.totalLitres
    r.purchasedCost += p.totalCost
  }
  for (const c of outs) {
    const r = at(c.date.slice(0, 7))
    r.consumed += c.litres
    r.consumedCost += c.cost
  }
  for (const x of moved) at(x.date.slice(0, 7)).unattributed += x.litres
  const active = [...by.keys()].sort()
  if (!active.length) return []
  const last = throughMonth && throughMonth > active.at(-1)! ? throughMonth : active.at(-1)!
  const rows: StockRow[] = []
  let stock = 0
  for (let m = active[0]; m <= last; m = format(addMonths(parseISO(`${m}-01`), 1), "yyyy-MM")) {
    const r = by.get(m) ?? empty()
    const closing = round2(stock + r.openingStock + r.purchased + r.unattributed - r.consumed)
    rows.push({ month: m, opening: stock, openingStock: round2(r.openingStock), purchased: round2(r.purchased), consumed: round2(r.consumed), unattributed: round2(r.unattributed), closing, purchasedCost: round2(r.purchasedCost), consumedCost: round2(r.consumedCost) })
    stock = closing
  }
  return rows
}

/** The company's monthly AdBlue stock ledger. */
export function inventoryLedger(purchases: Purchase[], consumptions: Consumption[], throughMonth?: string): StockRow[] {
  const { costOf } = valueInventory(purchases, consumptions)
  return ledgerRows(purchases, consumptions.map((c) => ({ date: c.date, litres: c.quantityLitres, cost: costOf.get(c.id) ?? 0 })), throughMonth)
}

/**
 * One vendor's monthly stock ledger (key: vendor id, or NO_VENDOR = unattributed stock): its batches in, every litre
 * vehicles drew from them out, and stock that became unattributed at old draws (out of the vendor, into NO_VENDOR) —
 * the same FIFO run as the company ledger, so Σ every vendor's ledger = the company ledger.
 */
export function vendorLedger(purchases: Purchase[], consumptions: Consumption[], vendor: string, throughMonth?: string): StockRow[] {
  const { takes, moves } = valueInventory(purchases, consumptions)
  const moved = moves.filter((x) => vendor === NO_VENDOR || x.vendor === vendor).map((x) => ({ date: x.date, litres: vendor === NO_VENDOR ? x.litres : -x.litres }))
  return ledgerRows(purchases.filter((p) => vendorKey(p) === vendor), takes.filter((t) => t.vendor === vendor), throughMonth, moved)
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
  const unattributed = sum((r) => r.unattributed)
  return { opening, openingStock, purchased, consumed, unattributed, closing: round2(opening + openingStock + purchased + unattributed - consumed), purchasedCost: sum((r) => r.purchasedCost), consumedCost: sum((r) => r.consumedCost), carriedFrom: before?.month ?? null }
}

/** A purchase's vendor: the vendor master id, or its saved name for a purchase not linked to one. */
const purchaseVendor = (p: { adblueVendorId?: string | null; vendorName?: string }) => p.adblueVendorId || `name:${p.vendorName?.trim().toLowerCase() || "unknown"}`

/** Per vendor (by vendor id, so a rename keeps one row): litres, amount and average ₹ per litre purchased. */
export function vendorAnalytics(purchases: Purchase[]) {
  const m = new Map<string, { vendor: string; litres: number; amount: number; purchases: number }>()
  for (const p of purchases) {
    if (p.opening) continue // opening stock was bought from nobody in the period
    const k = purchaseVendor(p)
    const r = m.get(k) ?? { vendor: "", litres: 0, amount: 0, purchases: 0 }
    m.set(k, { vendor: r.vendor || p.vendorName?.trim() || "Unknown", litres: r.litres + p.totalLitres, amount: r.amount + p.totalCost, purchases: r.purchases + 1 })
  }
  return [...m.values()].map(({ vendor, ...r }) => ({ vendor, litres: round2(r.litres), amount: round2(r.amount), purchases: r.purchases, avgRate: r.litres ? round2(r.amount / r.litres) : null }))
}

/**
 * AdBlue bought in a period — only purchase batches dated in it. Carry-forward stock and the value
 * of stock already held never enter it (that is Inventory Value, a different figure).
 */
export function purchasedIn<P extends Purchase>(purchases: P[], inPeriod: (p: P) => boolean) {
  const list = purchases.filter((p) => !p.opening && inPeriod(p))
  const litres = round2(list.reduce((t, p) => t + p.totalLitres, 0))
  const cost = round2(list.reduce((t, p) => t + p.totalCost, 0))
  return { litres, cost, purchases: list.length, vendors: new Set(list.map(purchaseVendor)).size, avgRate: litres ? round2(cost / litres) : null }
}

/**
 * Uncle's answer 25 — AdBlue reaches a vehicle two ways:
 *   STOCK  (default) bought in bulk into inventory, then drawn by the vehicle from one vendor's stock (FIFO cost)
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
  const draws = stockDraws(entries).map(({ id, date, createdAt, quantityLitres, adblueVendorId, beforeVendorTracking }) => ({ id, date, createdAt, quantityLitres, adblueVendorId, beforeVendorTracking }))
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

export interface VendorPurchases {
  key: string
  vendor: string
  purchases: number
  litres: number
  value: number
}

/**
 * The AdBlue Overview's purchase summary for a period: bulk purchases (stock batches dated in it; value = taxable + GST,
 * `purchaseValue`; opening stock is never a purchase) and direct vendor purchases (DIRECT entries dated in it, litres ×
 * rate; every role reads every AdBlue entry), vendor-wise and never mixed. Only purchase records count — payments, advance and outstanding never do. Each
 * section's total is the sum of its rows, and the overall total the sum of the two sections.
 */
type DirectPurchase = { date: string; quantityLitres: number; amount: number; source?: "STOCK" | "DIRECT"; adblueVendorId?: string | null; vendorName?: string }

export function purchaseSummary<P extends Purchase, E extends DirectPurchase>(purchases: P[], entries: E[], inPeriod: (x: { date: string }) => boolean) {
  const group = (rows: { key: string; vendor: string; count: number; litres: number; value: number }[]): VendorPurchases[] => {
    const m = new Map<string, VendorPurchases>()
    for (const r of rows) {
      const v = m.get(r.key) ?? { key: r.key, vendor: r.vendor, purchases: 0, litres: 0, value: 0 }
      m.set(r.key, { ...v, purchases: v.purchases + r.count, litres: v.litres + r.litres, value: v.value + r.value })
    }
    return [...m.values()].map((v) => ({ ...v, litres: round2(v.litres), value: round2(v.value) })).sort((a, b) => b.value - a.value || a.vendor.localeCompare(b.vendor))
  }
  const bulk = group(purchases.filter((p) => !p.opening && inPeriod(p)).map((p) => ({ key: purchaseVendor(p), vendor: p.vendorName?.trim() || "Unknown vendor", count: 1, litres: p.totalLitres, value: purchaseValue({ totalCost: p.totalCost, gstRate: p.gstRate ?? 0 }) })))
  const direct = group(entries.filter((e) => isDirectAdBlue(e) && inPeriod(e)).map((e) => ({ key: purchaseVendor(e), vendor: e.vendorName?.trim() || "Unknown vendor", count: 1, litres: e.quantityLitres, value: e.amount })))
  const total = (rows: VendorPurchases[]) => ({ litres: round2(rows.reduce((t, r) => t + r.litres, 0)), value: round2(rows.reduce((t, r) => t + r.value, 0)) })
  const b = total(bulk)
  const d = total(direct)
  return { bulk, direct, totals: { bulk: b, direct: d, overall: { litres: round2(b.litres + d.litres), value: round2(b.value + d.value) } } }
}

/** A period's figures from the totals (months: the period's yyyy-MM list; undefined = all time). */
export function totalsFor(t: AdBlueTotals, months: string[] | undefined, endedMonth: string | null) {
  const inPeriod = (m: string) => !months || months.includes(m)
  const d = t.direct.filter((r) => inPeriod(r.month))
  const sum = (f: (r: (typeof d)[number]) => number) => round2(d.reduce((s, r) => s + f(r), 0))
  const end = endedMonth ? ([...t.monthEnd].reverse().find((r) => r.month <= endedMonth) ?? { stockLitres: 0, stockValue: 0, avgRate: null }) : t.current
  return { stock: end, directCost: sum((r) => r.cost), directLitres: sum((r) => r.litres), directCount: d.reduce((s, r) => s + r.count, 0) }
}
