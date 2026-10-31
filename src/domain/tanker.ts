/**
 * Diesel tankers — the company's tankers as mobile fuel stations (uncle's answer 24: three today, more later).
 * Two separate things per tanker:
 *
 *   A. Cargo inventory (this file): litres loaded in − litres dispensed out, one stock per tanker.
 *   B. The tanker VEHICLE's own fuel: ordinary diesel entries from a pump; never touches cargo.
 *
 * Per tanker, calculated from its own records only (never stored, never mixed with another tanker):
 *
 *   Opening + Loaded + Transfers in + Adjustments (+) − Dispensed − Transfers out − Adjustments (−) = Closing
 *   Closing → next month's Opening
 *
 *   Loaded       Σ litres of tanker loads (bought from a fuel station; Purchase cost = litres × rate, owed to it)
 *   Dispensed    Σ litres of diesel entries with source "Diesel Tanker" (registered vehicles) + external dispenses
 *   Transfers    litres moved between tankers — never a purchase; the company total doesn't change
 *   Adjustments  dip-reading / loss corrections with a mandatory reason
 *
 * Money — four separate figures (answer 23), never one amount field for all:
 *   Purchase cost   load litres × the supplier's rate (the station ledger's payable)
 *   Fill amount     a tanker fill's litres × the rate recorded on the fill (the source's rate); only fills
 *                   saved without a rate (older records) fall back to the weighted-average cost below
 *   Stock valuation moving weighted average per tanker — internal (suggested fill rate, legacy fills); not shown as a card
 *   Customer revenue trips / invoices — never derived from tanker figures
 *
 * Stock never goes below zero for any tanker at any point in time (event order: date; loads, transfers in
 * and + adjustments before draws on the same day; then createdAt, id).
 */
import { addMonths, format, parseISO } from "date-fns"
import type { DieselEntry, Tanker, TankerAdjustment, TankerDispense, TankerLoad, TankerTransfer } from "@/lib/types"
import { round2 } from "@/lib/format"

/** The Diesel Tanker fuel source (a FuelStation record with isTanker) — which tanker is on the fill (`tankerId`). */
export const TANKER_SOURCE_ID = "dv_tanker"

/** The tanker that records saved before tankers existed belong to (created by the storage migration). */
export const DEFAULT_TANKER_ID = "tnk_default"

/**
 * The company's three diesel tankers (uncle's answer 24; names and registrations from the owner, 15 Oct 2026).
 * Same ids as the fuel import's TANKER_MASTER, so a re-import never duplicates them.
 */
export const CONFIRMED_TANKERS = [
  { id: "tnk_tn70ax9480", name: "JIO", regNo: "TN70AX9480" },
  { id: "tnk_ka53c0538", name: "Office", regNo: "KA53C0538" },
  { id: "tnk_ka51af1429", name: "Mini", regNo: "KA51AF1429" },
] as const

/** Registration as compared everywhere: letters and digits only, upper case ("tn 70 ax-9480" → TN70AX9480). */
export const normReg = (reg: string) => reg.replace(/[^A-Za-z0-9]/g, "").toUpperCase()

/**
 * A tanker record without a registration is a stock pool, not a tanker vehicle: the records saved before tankers
 * were tracked (`tnk_default`) or the import's combined stock that isn't split by tanker yet (S-21, S-22). Pools
 * keep their history in every total but are never counted as a tanker. New tankers must have a registration.
 */
export const isStockPool = (t: Pick<Tanker, "regNo">) => !t.regNo

/** "JIO · TN70AX9480" — the name with its registration (once, if the name already contains it). */
export const tankerLabel = (t: Pick<Tanker, "name" | "regNo">) => (t.regNo && !t.name.includes(t.regNo) ? `${t.name} · ${t.regNo}` : t.name)

export const isTankerFill = (e: { vendorId: string }) => e.vendorId === TANKER_SOURCE_ID

/** A record's tanker; records saved before tankers existed (no tankerId) belong to the default tanker. */
export const tankerOf = (r: { tankerId?: string }) => r.tankerId || DEFAULT_TANKER_ID

export const insufficientTankerMessage = (available: number, tanker?: string) =>
  `Insufficient tanker inventory${tanker ? ` in ${tanker}` : ""}. Available: ${round2(available).toLocaleString("en-IN")} L`

/* ------------------------------------------------------------------ movements */

type Fill = Pick<DieselEntry, "id" | "date" | "createdAt" | "litres" | "vendorId" | "tankerId">
type External = Pick<TankerDispense, "id" | "date" | "createdAt" | "litres" | "tankerId">

export interface TankerRecords {
  loads: Pick<TankerLoad, "id" | "date" | "createdAt" | "litres" | "amount" | "tankerId" | "opening">[]
  fills: Fill[]
  external: External[]
  transfers?: Pick<TankerTransfer, "id" | "date" | "createdAt" | "fromTankerId" | "toTankerId" | "litres">[]
  adjustments?: Pick<TankerAdjustment, "id" | "date" | "createdAt" | "tankerId" | "litres">[]
}

export type MoveKind = "LOAD" | "OPENING" | "FILL" | "EXTERNAL" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUST"

/** One change to one tanker's stock. `litres` is signed (+ in, − out). */
export interface TankerMove {
  id: string
  date: string
  createdAt: string
  tankerId: string
  kind: MoveKind
  litres: number
  /** Loads only: purchase cost (litres × rate). */
  cost?: number
  /** Transfers: the other tanker. */
  otherTankerId?: string
}

/** Every stock movement of every tanker. A transfer is two moves (out of one, into the other) with the same id. */
export function tankerMoves(r: TankerRecords): TankerMove[] {
  const at = (x: { createdAt?: string }) => x.createdAt ?? ""
  return [
    ...r.loads.map((l): TankerMove => ({ id: l.id, date: l.date, createdAt: at(l), tankerId: tankerOf(l), kind: l.opening ? "OPENING" : "LOAD", litres: l.litres, cost: l.amount })),
    ...r.fills.filter(isTankerFill).map((e): TankerMove => ({ id: e.id, date: e.date, createdAt: at(e), tankerId: tankerOf(e), kind: "FILL", litres: -e.litres })),
    ...r.external.map((x): TankerMove => ({ id: x.id, date: x.date, createdAt: at(x), tankerId: tankerOf(x), kind: "EXTERNAL", litres: -x.litres })),
    ...(r.transfers ?? []).flatMap((t): TankerMove[] => [
      { id: t.id, date: t.date, createdAt: at(t), tankerId: t.fromTankerId, kind: "TRANSFER_OUT", litres: -t.litres, otherTankerId: t.toTankerId },
      { id: t.id, date: t.date, createdAt: at(t), tankerId: t.toTankerId, kind: "TRANSFER_IN", litres: t.litres, otherTankerId: t.fromTankerId },
    ]),
    ...(r.adjustments ?? []).map((a): TankerMove => ({ id: a.id, date: a.date, createdAt: at(a), tankerId: a.tankerId, kind: "ADJUST", litres: a.litres })),
  ]
}

// Same day: purchases / + adjustments first, then transfers (out before in), then draws — so a late-entered load still covers that day.
const RANK: Record<MoveKind, number> = { OPENING: 0, LOAD: 0, ADJUST: 0, TRANSFER_OUT: 1, TRANSFER_IN: 2, FILL: 3, EXTERNAL: 3 }
const rank = (m: TankerMove) => (m.kind === "ADJUST" && m.litres < 0 ? 3 : RANK[m.kind])
const moveOrder = (a: TankerMove, b: TankerMove) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

export interface TankerValuation {
  /** Fill / external dispense / transfer id → cost at the tanker's weighted-average rate when it was drawn. */
  costOf: Map<string, number>
  /** Per tanker, after the last movement. */
  stock: Map<string, { litres: number; value: number; avgRate: number | null }>
  /** First moment a tanker's stock would go below zero, if any (for validation). */
  shortfall: { tankerId: string; date: string; available: number; needed: number; id: string } | null
}

/** Runs every movement in order, one moving weighted average per tanker. */
export function valueTankers(r: TankerRecords): TankerValuation {
  const moves = tankerMoves(r).sort(moveOrder)
  const state = new Map<string, { litres: number; value: number }>()
  const of = (id: string) => state.get(id) ?? (state.set(id, { litres: 0, value: 0 }), state.get(id)!)
  const costOf = new Map<string, number>()
  let shortfall: TankerValuation["shortfall"] = null
  const transferCost = new Map<string, number>()
  for (const m of moves) {
    const s = of(m.tankerId)
    const avg = s.litres > 0 ? s.value / s.litres : 0
    if (m.litres >= 0) {
      const value = m.kind === "LOAD" || m.kind === "OPENING" ? (m.cost ?? 0) : m.kind === "TRANSFER_IN" ? (transferCost.get(m.id) ?? 0) : m.litres * avg
      s.litres += m.litres
      s.value += value
      continue
    }
    const q = -m.litres
    if (q > s.litres + 1e-9 && !shortfall) shortfall = { tankerId: m.tankerId, date: m.date, available: round2(s.litres), needed: q, id: m.id }
    const cost = round2(Math.min(q, s.litres) * avg)
    if (m.kind === "TRANSFER_OUT") transferCost.set(m.id, cost)
    else costOf.set(m.id, cost)
    s.value = s.litres - q > 1e-9 ? s.value - cost : 0
    s.litres = Math.max(0, s.litres - q)
  }
  const stock = new Map([...state].map(([id, s]) => [id, { litres: round2(s.litres), value: round2(s.value), avgRate: s.litres > 0 ? round2(s.value / s.litres) : null }]))
  return { costOf, stock, shortfall }
}

/** A tanker fill's amount (answer 23): litres × the rate recorded on the fill; only a fill saved without a rate is costed at the weighted average. */
export const fillAmount = (e: Pick<DieselEntry, "id" | "litres" | "rate">, costOf: Map<string, number>) => (e.rate > 0 ? round2(e.litres * e.rate) : (costOf.get(e.id) ?? 0))

/* ------------------------------------------------------------------ monthly ledger */

export interface TankerLedgerRow {
  month: string
  opening: number
  loaded: number
  /** ₹ of loads dated in the month (Fuel Purchase Cost) — opening stock is never a purchase. */
  loadedCost: number
  /** Stock already in the tanker when records began (an opening-stock load in this month). Not a purchase. */
  openingStock: number
  transferIn: number
  transferOut: number
  /** Net of + and − adjustments. */
  adjusted: number
  dispensed: number
  closing: number
}

/**
 * Month-by-month ledger of one tanker (`tankerId`) or of all of them together (null — transfers between
 * tankers cancel out, so they're left out of the company total). From the first movement through `throughMonth`.
 */
export function tankerLedger(moves: TankerMove[], tankerId: string | null, throughMonth?: string): TankerLedgerRow[] {
  const mine = moves.filter((m) => (tankerId ? m.tankerId === tankerId : m.kind !== "TRANSFER_IN" && m.kind !== "TRANSFER_OUT"))
  const blank = () => ({ loaded: 0, loadedCost: 0, openingStock: 0, transferIn: 0, transferOut: 0, adjusted: 0, dispensed: 0 })
  const by = new Map<string, ReturnType<typeof blank>>()
  for (const m of mine) {
    const k = m.date.slice(0, 7)
    const r = by.get(k) ?? (by.set(k, blank()), by.get(k)!)
    if (m.kind === "LOAD") {
      r.loaded += m.litres
      r.loadedCost += m.cost ?? 0
    } else if (m.kind === "OPENING") r.openingStock += m.litres
    else if (m.kind === "TRANSFER_IN") r.transferIn += m.litres
    else if (m.kind === "TRANSFER_OUT") r.transferOut -= m.litres
    else if (m.kind === "ADJUST") r.adjusted += m.litres
    else r.dispensed -= m.litres
  }
  const active = [...by.keys()].sort()
  if (!active.length) return []
  const last = throughMonth && throughMonth > active.at(-1)! ? throughMonth : active.at(-1)!
  const rows: TankerLedgerRow[] = []
  let stock = 0
  for (let m = active[0]; m <= last; m = format(addMonths(parseISO(`${m}-01`), 1), "yyyy-MM")) {
    const r = by.get(m) ?? blank()
    const closing = round2(stock + r.openingStock + r.loaded + r.transferIn + r.adjusted - r.dispensed - r.transferOut)
    rows.push({
      month: m,
      opening: stock,
      loaded: round2(r.loaded),
      loadedCost: round2(r.loadedCost),
      openingStock: round2(r.openingStock),
      transferIn: round2(r.transferIn),
      transferOut: round2(r.transferOut),
      adjusted: round2(r.adjusted),
      dispensed: round2(r.dispensed),
      closing,
    })
    stock = closing
  }
  return rows
}

/** A period (yyyy-MM months; omit for all time): opening before it, Σ of each movement, closing. */
export function tankerPeriod(rows: TankerLedgerRow[], months?: string[]) {
  const inPeriod = months ? rows.filter((r) => months.includes(r.month)) : rows
  const first = months ? months[0] : rows[0]?.month
  const before = rows.filter((r) => first !== undefined && r.month < first).at(-1)
  const opening = months ? (before?.closing ?? 0) : 0
  const sum = (f: (r: TankerLedgerRow) => number) => round2(inPeriod.reduce((t, r) => t + f(r), 0))
  const p = {
    opening,
    openingStock: sum((r) => r.openingStock),
    loaded: sum((r) => r.loaded),
    loadedCost: sum((r) => r.loadedCost),
    transferIn: sum((r) => r.transferIn),
    transferOut: sum((r) => r.transferOut),
    adjusted: sum((r) => r.adjusted),
    dispensed: sum((r) => r.dispensed),
  }
  return { ...p, closing: round2(p.opening + p.openingStock + p.loaded + p.transferIn + p.adjusted - p.dispensed - p.transferOut), carriedFrom: before?.month ?? null }
}

/* ------------------------------------------------------------------ station ledger */

/**
 * Tanker loads as purchases from their supplier station (credit — owed like any pump purchase).
 * Opening stock has no supplier and is owed to nobody, so it is left out. Transfers between tankers are
 * never purchases. Shaped like a diesel fill so station ledgers / transaction history include them.
 */
export const loadsAsStationPurchases = (loads: TankerLoad[], tankers: Pick<Tanker, "id" | "vehicleId">[] = []) =>
  loads
    .filter((l) => !l.opening)
    .map((l) => ({
      id: l.id,
      vendorId: l.stationId,
      vehicleId: tankers.find((t) => t.id === tankerOf(l))?.vehicleId ?? "",
      tankerId: tankerOf(l),
      customerId: null,
      date: l.date,
      createdAt: l.createdAt,
      litres: l.litres,
      rate: l.rate,
      amount: l.amount,
      billNo: l.invoiceNo,
      paymentMode: "CREDIT" as const,
    }))

export const isTankerLoadId = (id: string) => id.startsWith("tkl_")
