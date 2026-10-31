/**
 * Pure business analytics over a Dataset. The backend will compute the same figures
 * from the ledger / reporting views; the UI only depends on these function signatures.
 *
 * Rules (match the architecture doc):
 *  - Revenue is earned on completed trips (accrual, ex-GST). Invoicing is a separate lens.
 *  - Expenses = diesel fills + outgoing payments whose category kind is EXPENSE.
 *    SETTLEMENT categories (diesel vendor payments, GST) are not P&L expense.
 *  - Outstanding is derived from allocations — never stored on the invoice.
 *  - No bank balance is tracked (owner, 31 Oct 2026): money is followed per transaction — receipts, payments and
 *    each fuel station's ledger (src/domain/station-ledger.ts) — never as an account balance.
 */
import { differenceInCalendarDays, parseISO } from "date-fns"
import type {
  CompanyScope,
  Customer,
  DieselEntry,
  Driver,
  Invoice,
  InvoicePaymentStatus,
  Payment,
  Settings,
  Tanker,
  TankerLoad,
  Trip,
  Vehicle,
  VehicleAssignment,
  FuelStation,
} from "@/lib/types"
import { monthKey, round2 } from "@/lib/format"
import { inRange, type DateRange } from "./periods"
import { ledgerFor, openingOf, stationLedger } from "./station-ledger"
import { loadsAsStationPurchases } from "./tanker"

export interface Dataset {
  settings: Settings
  customers: Customer[]
  vehicles: Vehicle[]
  drivers: Driver[]
  trips: Trip[]
  diesel: DieselEntry[]
  invoices: Invoice[]
  payments: Payment[]
  /** Vehicle → customer assignment periods (src/domain/assignments.ts). */
  assignments?: VehicleAssignment[]
  /** Fuel stations (petrol pumps) — the master list. */
  fuelStations: FuelStation[]
  /** Diesel loaded into the tankers — credit purchases from their supplier station. */
  tankerLoads?: TankerLoad[]
  /** The company tankers (tanker master). */
  tankers?: Tanker[]
}

export function scopeDataset(ds: Dataset, scope: CompanyScope): Dataset {
  if (scope === "GROUP") return ds
  const f = <T extends { companyCode: string }>(xs: T[]) => xs.filter((x) => x.companyCode === scope)
  return {
    settings: ds.settings,
    customers: f(ds.customers),
    vehicles: f(ds.vehicles),
    drivers: f(ds.drivers),
    trips: f(ds.trips),
    diesel: f(ds.diesel),
    invoices: f(ds.invoices),
    payments: f(ds.payments),
    assignments: ds.assignments,
    fuelStations: ds.fuelStations,
    tankerLoads: ds.tankerLoads,
  }
}

const sum = <T,>(xs: T[], fn: (x: T) => number) => xs.reduce((s, x) => s + fn(x), 0)

/* ------------------------------------------------------------------ Invoices & settlement */

export function settlementIndex(payments: Payment[]) {
  const idx = new Map<string, number>()
  for (const p of payments) {
    if (p.direction !== "IN") continue
    for (const a of p.allocations) idx.set(a.invoiceId, (idx.get(a.invoiceId) ?? 0) + a.amount)
  }
  return idx
}

export function invoiceOutstanding(inv: Invoice, settled: number) {
  if (inv.status !== "ISSUED") return 0
  return Math.max(0, round2(inv.total - settled))
}

export function invoicePaymentStatus(inv: Invoice, settled: number, todayIso: string): InvoicePaymentStatus {
  if (inv.status === "DRAFT") return "DRAFT"
  if (inv.status === "CANCELLED") return "CANCELLED"
  if (settled >= inv.total - 0.5) return "PAID"
  if (inv.dueDate < todayIso) return "OVERDUE"
  if (settled > 0) return "PARTIAL"
  return "UNPAID"
}

export interface InvoiceView extends Invoice {
  settled: number
  outstanding: number
  paymentStatus: InvoicePaymentStatus
  daysOverdue: number
}

export function invoiceViews(ds: Dataset, todayIso: string): InvoiceView[] {
  const idx = settlementIndex(ds.payments)
  return ds.invoices.map((inv) => {
    const settled = round2(idx.get(inv.id) ?? 0)
    const outstanding = invoiceOutstanding(inv, settled)
    return {
      ...inv,
      settled,
      outstanding,
      paymentStatus: invoicePaymentStatus(inv, settled, todayIso),
      daysOverdue: outstanding > 0 ? Math.max(0, differenceInCalendarDays(parseISO(todayIso), parseISO(inv.dueDate))) : 0,
    }
  })
}

/* ------------------------------------------------------------------ Expense classification */

export function isExpensePayment(p: Payment, settings: Settings) {
  if (p.direction !== "OUT") return false
  const cat = settings.expenseCategories.find((c) => c.code === p.categoryCode)
  return (cat?.kind ?? "EXPENSE") === "EXPENSE"
}

export function categoryName(settings: Settings, code: string | null) {
  if (!code) return "—"
  if (code === "DIESEL") return "Diesel"
  return settings.expenseCategories.find((c) => c.code === code)?.name ?? code
}

/* ------------------------------------------------------------------ Headline KPIs */

export function receivablesTotal(views: InvoiceView[]) {
  return round2(sum(views, (v) => v.outstanding))
}

/** Per station, all time — from the fuel station ledger (src/domain/station-ledger.ts), so every screen agrees. */
export function vendorPayables(ds: Dataset) {
  // Pump fills + tanker loads (bought at a pump on credit). AdBlue is inventory; the tanker is cargo, not a pump.
  const purchases = [...ds.diesel, ...loadsAsStationPurchases(ds.tankerLoads ?? [], ds.tankers)]
  return ds.fuelStations
    .filter((v) => !v.isTanker)
    .map((v) => {
      const l = ledgerFor(stationLedger(v.id, purchases, ds.payments, undefined, openingOf(v)))
      return { vendor: v, purchased: l.purchased, paid: l.paid, closing: l.closing, outstanding: round2(Math.max(0, l.closing)) }
    })
    .filter((x) => x.purchased > 0 || x.paid > 0)
}

export function payablesTotal(ds: Dataset) {
  return round2(sum(vendorPayables(ds), (x) => x.outstanding))
}

export function revenueInRange(ds: Dataset, range: DateRange) {
  return round2(sum(ds.trips.filter((t) => t.status === "COMPLETED" && inRange(t.date, range)), (t) => t.revenue))
}

export function dieselInRange(ds: Dataset, range: DateRange) {
  return round2(sum(ds.diesel.filter((d) => inRange(d.date, range)), (d) => d.amount))
}

/** Litres of Diesel / Petrol fills in range — EV kWh kept out, as Total Litres in the Diesel module (statsOf). */
export function dieselLitresInRange(ds: Dataset, range: DateRange) {
  const ev = new Set(ds.vehicles.filter((v) => v.fuelType === "EV").map((v) => v.id))
  return round2(sum(ds.diesel.filter((d) => inRange(d.date, range) && !ev.has(d.vehicleId)), (d) => d.litres))
}

export function expensesInRange(ds: Dataset, range: DateRange) {
  const other = sum(
    ds.payments.filter((p) => inRange(p.date, range) && isExpensePayment(p, ds.settings)),
    (p) => p.amount
  )
  return round2(dieselInRange(ds, range) + other)
}

export function unbilledTrips(ds: Dataset) {
  return ds.trips.filter((t) => t.status === "COMPLETED" && !t.invoiceId)
}

/* ------------------------------------------------------------------ Monthly series */

export interface MonthPoint {
  month: string
  revenue: number
  expenses: number
  diesel: number
  otherExpenses: number
  profit: number
  invoiced: number
  collected: number
  paidOut: number
  litres: number
}

export function monthlySeries(ds: Dataset, months: string[]): MonthPoint[] {
  const map = new Map<string, MonthPoint>(
    months.map((m) => [m, { month: m, revenue: 0, expenses: 0, diesel: 0, otherExpenses: 0, profit: 0, invoiced: 0, collected: 0, paidOut: 0, litres: 0 }])
  )
  for (const t of ds.trips) {
    if (t.status !== "COMPLETED") continue
    const p = map.get(monthKey(t.date))
    if (p) p.revenue += t.revenue
  }
  for (const d of ds.diesel) {
    const p = map.get(monthKey(d.date))
    if (p) {
      p.diesel += d.amount
      p.litres += d.litres
      if (d.paymentMode === "CASH") p.paidOut += d.amount
    }
  }
  for (const pay of ds.payments) {
    const p = map.get(monthKey(pay.date))
    if (!p) continue
    if (pay.direction === "IN") p.collected += pay.amount
    else {
      p.paidOut += pay.amount
      if (isExpensePayment(pay, ds.settings)) p.otherExpenses += pay.amount
    }
  }
  for (const inv of ds.invoices) {
    if (inv.status !== "ISSUED") continue
    const p = map.get(monthKey(inv.date))
    if (p) p.invoiced += inv.subtotal
  }
  return [...map.values()].map((p) => {
    const expenses = p.diesel + p.otherExpenses
    return {
      ...p,
      revenue: round2(p.revenue),
      diesel: round2(p.diesel),
      otherExpenses: round2(p.otherExpenses),
      expenses: round2(expenses),
      profit: round2(p.revenue - expenses),
      invoiced: round2(p.invoiced),
      collected: round2(p.collected),
      paidOut: round2(p.paidOut),
      litres: round2(p.litres),
    }
  })
}

/* ------------------------------------------------------------------ Vehicle profitability */

export interface VehicleProfit {
  vehicle: Vehicle
  trips: number
  km: number
  revenue: number
  diesel: number
  litres: number
  kmpl: number | null
  driver: number
  maintenance: number
  fixed: number // EMI, insurance, road tax, attach hire
  totalCost: number
  contribution: number
  margin: number
  costPerKm: number | null
}

const MAINT_CODES = new Set(["MAINTENANCE", "TYRE"])

export function vehicleProfitability(ds: Dataset, range: DateRange): VehicleProfit[] {
  const trips = ds.trips.filter((t) => t.status === "COMPLETED" && inRange(t.date, range))
  const diesel = ds.diesel.filter((d) => inRange(d.date, range))
  const pays = ds.payments.filter((p) => p.vehicleId && inRange(p.date, range) && isExpensePayment(p, ds.settings))
  return ds.vehicles.map((v) => {
    const vt = trips.filter((t) => t.vehicleId === v.id)
    const vd = diesel.filter((d) => d.vehicleId === v.id)
    const vp = pays.filter((p) => p.vehicleId === v.id)
    const revenue = sum(vt, (t) => t.revenue)
    const km = sum(vt, (t) => t.distanceKm)
    const dieselAmt = sum(vd, (d) => d.amount)
    const litres = sum(vd, (d) => d.litres)
    const driver = sum(vp.filter((p) => p.categoryCode === "DRIVER_SALARY"), (p) => p.amount)
    const maintenance = sum(vp.filter((p) => MAINT_CODES.has(p.categoryCode ?? "")), (p) => p.amount)
    const fixed = sum(vp.filter((p) => p.categoryCode !== "DRIVER_SALARY" && !MAINT_CODES.has(p.categoryCode ?? "")), (p) => p.amount)
    const totalCost = dieselAmt + driver + maintenance + fixed
    return {
      vehicle: v,
      trips: vt.length,
      km,
      revenue: round2(revenue),
      diesel: round2(dieselAmt),
      litres: round2(litres),
      kmpl: litres > 0 ? round2(km / litres) : null,
      driver: round2(driver),
      maintenance: round2(maintenance),
      fixed: round2(fixed),
      totalCost: round2(totalCost),
      contribution: round2(revenue - totalCost),
      margin: revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : 0,
      costPerKm: km > 0 ? round2(totalCost / km) : null,
    }
  })
}

/* ------------------------------------------------------------------ Customer profitability */

export interface CustomerProfit {
  customer: Customer
  trips: number
  km: number
  revenue: number
  directCost: number
  contribution: number
  margin: number
  invoiced: number
  outstanding: number
  vehicles: number
}

/** Vehicle costs are allocated to customers by each customer's share of that vehicle's km. */
export function customerProfitability(ds: Dataset, range: DateRange, views: InvoiceView[]): CustomerProfit[] {
  const vp = vehicleProfitability(ds, range)
  const trips = ds.trips.filter((t) => t.status === "COMPLETED" && inRange(t.date, range))
  const kmByVehicle = new Map(vp.map((x) => [x.vehicle.id, x.km]))
  const costByVehicle = new Map(vp.map((x) => [x.vehicle.id, x.totalCost]))
  return ds.customers.map((c) => {
    const ct = trips.filter((t) => t.customerId === c.id)
    const revenue = sum(ct, (t) => t.revenue)
    const km = sum(ct, (t) => t.distanceKm)
    const vehKm = new Map<string, number>()
    ct.forEach((t) => vehKm.set(t.vehicleId, (vehKm.get(t.vehicleId) ?? 0) + t.distanceKm))
    let directCost = 0
    vehKm.forEach((k, vid) => {
      const total = kmByVehicle.get(vid) ?? 0
      if (total > 0) directCost += ((costByVehicle.get(vid) ?? 0) * k) / total
    })
    const cv = views.filter((v) => v.customerId === c.id)
    return {
      customer: c,
      trips: ct.length,
      km,
      revenue: round2(revenue),
      directCost: round2(directCost),
      contribution: round2(revenue - directCost),
      margin: revenue > 0 ? ((revenue - directCost) / revenue) * 100 : 0,
      invoiced: round2(sum(cv.filter((v) => v.status === "ISSUED" && inRange(v.date, range)), (v) => v.subtotal)),
      outstanding: round2(sum(cv, (v) => v.outstanding)),
      vehicles: vehKm.size,
    }
  })
}

/* ------------------------------------------------------------------ Diesel analysis */

export function dieselByVendor(ds: Dataset, range: DateRange) {
  // Same purchases as the station ledger: pump fills + tanker loads, so Purchases and Payable agree.
  const entries = [...ds.diesel, ...loadsAsStationPurchases(ds.tankerLoads ?? [], ds.tankers)].filter((d) => inRange(d.date, range))
  const payables = new Map(vendorPayables(ds).map((p) => [p.vendor.id, p.outstanding]))
  return ds.fuelStations
    .filter((v) => !v.isTanker)
    .map((v) => {
      const ve = entries.filter((e) => e.vendorId === v.id)
      const litres = sum(ve, (e) => e.litres)
      const amount = sum(ve, (e) => e.amount)
      return {
        vendor: v,
        fills: ve.length,
        litres: round2(litres),
        amount: round2(amount),
        avgRate: litres > 0 ? round2(amount / litres) : 0,
        outstanding: payables.get(v.id) ?? 0,
      }
    })
    .filter((x) => x.fills > 0 || x.outstanding > 0)
    .sort((a, b) => b.amount - a.amount)
}

/* ------------------------------------------------------------------ P&L */

export interface PnLLine {
  code: string
  label: string
  amount: number
}

export function profitAndLoss(ds: Dataset, range: DateRange) {
  const trips = ds.trips.filter((t) => t.status === "COMPLETED" && inRange(t.date, range))
  const customerUnit = new Map(ds.customers.map((c) => [c.id, c.businessUnit]))
  const revByUnit = new Map<string, number>()
  trips.forEach((t) => {
    const u = customerUnit.get(t.customerId) ?? "OTHER"
    revByUnit.set(u, (revByUnit.get(u) ?? 0) + t.revenue)
  })
  const income: PnLLine[] = [...revByUnit.entries()]
    .map(([code, amount]) => ({ code, label: BUSINESS_UNIT_LABEL[code] ?? code, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)

  const expMap = new Map<string, number>()
  expMap.set("DIESEL", dieselInRange(ds, range))
  ds.payments
    .filter((p) => inRange(p.date, range) && isExpensePayment(p, ds.settings))
    .forEach((p) => expMap.set(p.categoryCode ?? "OTHER", (expMap.get(p.categoryCode ?? "OTHER") ?? 0) + p.amount))
  const expenses: PnLLine[] = [...expMap.entries()]
    .map(([code, amount]) => ({ code, label: categoryName(ds.settings, code), amount: round2(amount) }))
    .filter((l) => l.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  const totalIncome = round2(sum(income, (l) => l.amount))
  const totalExpenses = round2(sum(expenses, (l) => l.amount))
  return { income, expenses, totalIncome, totalExpenses, netProfit: round2(totalIncome - totalExpenses), margin: totalIncome ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0 }
}

export const BUSINESS_UNIT_LABEL: Record<string, string> = {
  STAFF_BUS: "Staff bus services",
  SCHOOL_BUS: "School bus services",
  TAXI: "Taxi / cab services",
  GOODS: "Goods transport",
  MANPOWER: "Manpower supply",
  PROPERTY: "Property rent",
  FUEL_RETAIL: "Fuel retail",
  INTERNAL: "Internal / own use",
}

/* ------------------------------------------------------------------ Cash flow */

/** Money received and paid in a period, by category — transactions only, never a bank balance. */
export function cashFlow(ds: Dataset, range: DateRange) {
  const pays = ds.payments.filter((p) => inRange(p.date, range))
  const receipts = round2(sum(pays.filter((p) => p.direction === "IN"), (p) => p.amount))
  const outByCat = new Map<string, number>()
  pays
    .filter((p) => p.direction === "OUT")
    .forEach((p) => outByCat.set(p.categoryCode ?? "OTHER", (outByCat.get(p.categoryCode ?? "OTHER") ?? 0) + p.amount))
  const cashDiesel = sum(ds.diesel.filter((d) => d.paymentMode === "CASH" && inRange(d.date, range)), (d) => d.amount)
  if (cashDiesel) outByCat.set("DIESEL", cashDiesel)
  const outflows: PnLLine[] = [...outByCat.entries()]
    .map(([code, amount]) => ({ code, label: categoryName(ds.settings, code), amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)
  const totalOut = round2(sum(outflows, (l) => l.amount))
  return { receipts, outflows, totalOut }
}

/* ------------------------------------------------------------------ Receivables aging */

export const AGING_BUCKETS = [
  { key: "notDue", label: "Not due" },
  { key: "d0_30", label: "1–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90p", label: "90+ days" },
] as const

export type AgingKey = (typeof AGING_BUCKETS)[number]["key"]

export function agingBucket(daysOverdue: number, dueDate: string, todayIso: string): AgingKey {
  if (dueDate >= todayIso) return "notDue"
  if (daysOverdue <= 30) return "d0_30"
  if (daysOverdue <= 60) return "d31_60"
  if (daysOverdue <= 90) return "d61_90"
  return "d90p"
}

export function receivablesAging(ds: Dataset, views: InvoiceView[], todayIso: string) {
  const rows = ds.customers
    .map((c) => {
      const row: Record<AgingKey, number> & { customer: Customer; total: number; invoices: number } = {
        customer: c, notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, total: 0, invoices: 0,
      }
      views
        .filter((v) => v.customerId === c.id && v.outstanding > 0)
        .forEach((v) => {
          row[agingBucket(v.daysOverdue, v.dueDate, todayIso)] += v.outstanding
          row.total += v.outstanding
          row.invoices += 1
        })
      return row
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, round2(sum(rows, (r) => r[b.key]))])) as Record<AgingKey, number>
  return { rows, totals, total: round2(sum(rows, (r) => r.total)) }
}

/* ------------------------------------------------------------------ Compliance */

export interface ComplianceAlert {
  vehicle: Vehicle
  document: "Insurance" | "Road tax" | "Fitness" | "Permit"
  validTill: string
  daysLeft: number
}

export function complianceAlerts(ds: Dataset, todayIso: string, withinDays = 30): ComplianceAlert[] {
  const out: ComplianceAlert[] = []
  const t = parseISO(todayIso)
  for (const v of ds.vehicles) {
    if (v.status === "INACTIVE" || v.status === "ARCHIVED") continue
    const docs: [ComplianceAlert["document"], string][] = [
      ["Insurance", v.insurance.validTill],
      ["Road tax", v.roadTax.validTill],
      ["Fitness", v.fitnessValidTill],
      ["Permit", v.permitValidTill],
    ]
    for (const [document, validTill] of docs) {
      const daysLeft = differenceInCalendarDays(parseISO(validTill), t)
      if (daysLeft <= withinDays) out.push({ vehicle: v, document, validTill, daysLeft })
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft)
}
