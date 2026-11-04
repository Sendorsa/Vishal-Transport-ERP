/**
 * Fuel station reports — derived only from transaction history (fuel fills carrying the station's id
 * as vendorId, plus Diesel Tanker loads bought there). Nothing is stored per station.
 *
 *   Fuel type of a fill   = the vehicle's fuelType (Diesel / Petrol / EV — EV fills are kWh)
 *   Diesel / Petrol Litres, EV Usage (kWh), AdBlue Litres = Σ quantity per kind
 *   Fuel Spend            = Σ amount of Diesel + Petrol + EV fills
 *   AdBlue Spend          = Σ amount of AdBlue entries
 *   Combined Spend        = Fuel Spend + AdBlue Spend (the only combined figure)
 *   Vehicles / Customers Served = distinct ids across all those transactions
 */
import { byEntryOrder } from "./payment-order"
import { ledgerFor, type LedgerRow } from "./station-ledger"
import { isTankerLoadId } from "./tanker"
import type { AdBlueEntry, DieselEntry, FuelType, Vehicle } from "@/lib/types"
import { round2 } from "@/lib/format"

export type StationKind = FuelType | "ADBLUE"

export interface StationTxn {
  id: string
  date: string
  vehicleId: string
  customerId: string | null
  kind: StationKind
  /** Litres (kWh for EV). */
  qty: number
  rate: number | null
  amount: number
  /** When the entry was saved — orders same-day transactions (src/domain/payment-order.ts). */
  createdAt?: string
  /** Diesel fills only: CREDIT (owed) or CASH (paid at the pump). AdBlue is on account. */
  paymentMode?: "CREDIT" | "CASH"
}

export function stationTransactions(stationId: string, diesel: DieselEntry[], adblue: AdBlueEntry[], vehicles: Map<string, Vehicle>): StationTxn[] {
  return [
    ...diesel
      .filter((e) => e.vendorId === stationId)
      .map((e): StationTxn => ({ id: e.id, date: e.date, vehicleId: e.vehicleId, customerId: e.customerId, kind: vehicles.get(e.vehicleId)?.fuelType ?? "DIESEL", qty: e.litres, rate: e.rate, amount: e.amount, paymentMode: e.paymentMode, createdAt: e.createdAt })),
    ...adblue
      .filter((e) => e.vendorId === stationId)
      .map((e): StationTxn => ({ id: e.id, date: e.date, vehicleId: e.vehicleId, customerId: e.customerId, kind: "ADBLUE", qty: e.quantityLitres, rate: e.quantityLitres ? round2(e.amount / e.quantityLitres) : null, amount: e.amount, createdAt: e.createdAt })),
  ].sort(byEntryOrder)
}

export function stationSummary(txns: StationTxn[]) {
  const sum = (kinds: StationKind[], f: (t: StationTxn) => number) => round2(txns.filter((t) => kinds.includes(t.kind)).reduce((s, t) => s + f(t), 0))
  const fuelSpend = sum(["DIESEL", "PETROL", "EV"], (t) => t.amount)
  const adblueSpend = sum(["ADBLUE"], (t) => t.amount)
  return {
    dieselLitres: sum(["DIESEL"], (t) => t.qty),
    petrolLitres: sum(["PETROL"], (t) => t.qty),
    evKwh: sum(["EV"], (t) => t.qty),
    adblueLitres: sum(["ADBLUE"], (t) => t.qty),
    fuelSpend,
    adblueSpend,
    combinedSpend: round2(fuelSpend + adblueSpend),
    fills: txns.filter((t) => t.kind !== "ADBLUE").length,
    // Real vehicles only: a tanker load carries its tanker's vehicle (for the "Diesel Tanker load · reg" label) but serves none.
    vehiclesServed: new Set(txns.filter((t) => !isTankerLoadId(t.id)).map((t) => t.vehicleId).filter(Boolean)).size,
    customersServed: new Set(txns.map((t) => t.customerId).filter(Boolean)).size,
  }
}

/**
 * A station card for the selected period: Total Spend (fuel purchased — stationSummary, never mixed with payments)
 * plus Payments Made and the closing balance from the station ledger (ledgerFor) — the same figures as the ledger table.
 */
export function stationCard(txns: StationTxn[], ledger: LedgerRow[], period: { match: (t: { date: string }) => boolean; months?: string[] }) {
  const l = ledgerFor(ledger, period.months)
  return { ...stationSummary(txns.filter(period.match)), paid: l.paid, closing: l.closing }
}

/** Period filter: "2026-10" (month), "2026" (year) or "" (all time). */
export const inStationPeriod = (prefix: string) => (t: { date: string }) => t.date.startsWith(prefix)
