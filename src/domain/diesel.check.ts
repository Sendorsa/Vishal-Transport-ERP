/**
 * Runnable check for the diesel KM / cost formulas:  npm run check:diesel
 * Fails loudly if KM Run stops being the sum of odometer gaps between fills.
 */
import assert from "node:assert/strict"
import { round2 } from "@/lib/format"
import { dieselByVendor, type Dataset } from "./analytics"
import { buildDieselIndex, customerCards, fillRow, groupMonth, vehicleMonth } from "./diesel"
import { buildMaster, last12Months, litresByFuelType } from "./fuel-master"
import { QUARTERS, inQuarter, quarterMonths, quarterOf } from "./quarters"
import { inEntryOrder } from "./payment-order"
import { fillAmount, insufficientTankerMessage, loadsAsStationPurchases, tankerLedger, tankerMoves, tankerPeriod, valueTankers, type TankerRecords } from "./tanker"
import { fyMonths, fyName, fyRange, fyStartYear, inFY, fyLabel } from "./financial-year"
import { FUEL_TDS_PERCENT, tdsDate, tdsDue } from "./station-ledger"
import { isDirectAdBlue, stockDraws } from "./adblue-inventory"
import { insufficientMessage, inventoryLedger, purchasedIn, stockFor, valueInventory, vendorAnalytics } from "./adblue-inventory"
import { inPeriod } from "./consumables"
import { adBlueStats, withRuns } from "./adblue"
import { asOfMonth, historyOf, statusOn, withStatus } from "./status-history"
import { canEditMonth, monthLockInfo } from "./month-lock"
import { balanceType, ledgerFor, stationLedger, stationPaymentHistory } from "./station-ledger"
import { inStationPeriod, stationSummary, stationTransactions } from "./fuel-stations"
import { activeVehicleIds, handoverFrom, inferAssignments, resolveCustomers, customerVehicles, searchVehicles, transferPeriods } from "./assignments"
import { matchesSearch } from "@/lib/utils"

const base = { createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }
const fill = (id: string, odometerKm: number, litres: number, amount: number, extra: object = {}) => ({
  ...base, id, companyCode: "VT" as const, date: "2026-10-05", vehicleId: "v1", customerId: "c1", vendorId: "p1",
  litres, rate: amount / litres, amount, odometerKm, billNo: "", paymentMode: "CREDIT" as const, ...extra,
})

const ds = {
  customers: [{ ...base, id: "c1", code: "APPLE", shortName: "Apple", name: "Apple", status: "ACTIVE" }],
  vehicles: [{ ...base, id: "v1", regNo: "KA05NK5115", fuelType: "DIESEL", mileageKmpl: 5, defaultDriverId: null, assignedCustomerId: "c1", status: "ACTIVE" }],
  drivers: [],
  trips: [], // no trips at all — KM must still come from odometers (the original bug)
  diesel: [fill("f1", 500, 60, 6000), fill("f2", 1800, 60, 6000), fill("f3", 2700, 120, 12000)],
  invoices: [],
  payments: [],
  settings: {},
} as unknown as Dataset

const idx = buildDieselIndex(ds)
const v = vehicleMonth(idx, "c1", "v1", "2026-10")!
assert.deepEqual(v.entries.map((e) => fillRow(idx, e).kmSince), [null, 1300, 900])
assert.equal(v.km, 2200) // 1300 + 900 = 2700 − 500
assert.equal(v.spend, 24000)
assert.equal(v.litres, 240)
assert.equal(v.costPerKm, 10.91) // 24000 ÷ 2200
assert.equal(v.kmpl, 9.17) // 2200 ÷ 240
assert.equal(groupMonth(idx, "c1", "2026-10").km, 2200) // customer total uses the same source

// EV vehicle (fuel type lives on the vehicle): its kWh count toward spend and km, never toward litres.
const ev = buildDieselIndex({
  ...ds,
  vehicles: [...(ds.vehicles as object[]), { ...base, id: "v2", regNo: "KA01EV0001", fuelType: "EV", mileageKmpl: 6, defaultDriverId: null, assignedCustomerId: "c1", status: "ACTIVE" }],
  diesel: [...ds.diesel, { ...fill("e1", 100, 20, 200), vehicleId: "v2" }, { ...fill("e2", 400, 50, 500), vehicleId: "v2" }],
} as Dataset)
const evVehicle = vehicleMonth(ev, "c1", "v2", "2026-10")!
assert.equal(evVehicle.km, 300)
assert.equal(evVehicle.litres, 0)
assert.equal(evVehicle.kwh, 70)
const all = groupMonth(ev, "c1", "2026-10")
assert.equal(all.km, 2500) // 2200 diesel + 300 EV
assert.equal(all.litres, 240) // EV kWh never mixed into litres
assert.equal(all.kmpl, 9.17) // km/L only from diesel/petrol vehicles

// An odometer lower than the previous fill is a typing error: shown as negative, counted as 0.
const typo = buildDieselIndex({ ...ds, diesel: [fill("a", 1000, 50, 5000), { ...fill("b", 900, 50, 5000), date: "2026-10-06" }] } as Dataset)
assert.equal(vehicleMonth(typo, "c1", "v1", "2026-10")!.km, 0)

// Master sheets: same numbers as the vehicle view, grouped; AdBlue alongside, never summed into diesel.
// Spec example: previous entry closed at 245000 (Oct 1), new entry 247500 → KM Run 2500, 10 L, ₹800.
const adFirst = { ...base, id: "a0", vehicleId: "v1", customerId: "c1", vendorId: "p2", date: "2026-09-01", closingKm: 245000, quantityLitres: 12, amount: 900, invoiceNo: "", notes: "" }
const adRuns = withRuns([{ ...adFirst, id: "a1", date: "2026-10-05", closingKm: 247500, quantityLitres: 10, amount: 800 }, adFirst])
const adEntry = adRuns[0]
assert.equal(adEntry.prevKm, 245000)
assert.equal(adEntry.kmRun, 2500)
assert.equal(adRuns[1].kmRun, null) // first entry: no reference point
const m = buildMaster(
  { idx, diesel: ds.diesel, adblue: adRuns, customers: new Map([["c1", ds.customers[0]]]), vendors: new Map() },
  (e) => e.date.startsWith("2026-10")
)
assert.equal(m.totals.km, 2200)
assert.equal(m.totals.spend, 24000) // diesel only — AdBlue ₹800 not added
assert.equal(m.extras[0].total.spend, 800)
assert.equal(m.byCustomer[0].km, 2200)
assert.equal(m.byCustomer[0].share, 100)
assert.equal(m.byCustomer[0].extras.adblue.qty, 10)
assert.equal(m.byVehicle[0].costPerKm, 10.91)
assert.equal(m.byVehicle[0].extras.adblue.perUnit, 250)
assert.deepEqual(m.byVendor.map((v) => [v.key, v.total.spend]), [["diesel", 24000]]) // pump tables are fuel only — AdBlue is bought into inventory
assert.equal(m.byVendor[0].rows[0].avgRate, 100) // 24000 ÷ 240
assert.deepEqual(m.fluid, { spend: 24800, qty: 250 }) // Running Fluid = diesel 24000 + AdBlue 800; 240 L + 10 L
assert.equal(m.byVehicle[0].fluid.spend, 24800)
assert.deepEqual(last12Months("2026-02").slice(0, 2), ["2025-03", "2025-04"])

// AdBlue: separate entries, separate formulas (spec example 245000 → 247500, 10 L, ₹800).
const ab = adBlueStats(adRuns) // both entries: first one's 12 L / ₹900 count in totals, not in km/L or ₹/km
assert.equal(ab.litres, 22)
assert.equal(ab.spend, 1700)
assert.equal(ab.kmPerLitre, 250)
assert.equal(ab.costPerKm, 0.32)
assert.equal(v.litres, 240) // diesel figures unaffected by AdBlue

// Archiving is a status change only: the customer and vehicle stay in every report with the same numbers.
const archived = buildDieselIndex({
  ...ds,
  customers: ds.customers.map((c) => ({ ...c, status: "ARCHIVED" })),
  vehicles: ds.vehicles.map((x) => ({ ...x, status: "ARCHIVED" })),
} as Dataset)
assert.equal(customerCards(archived, "2026-10", "2026-10-31").total, customerCards(idx, "2026-10", "2026-10-31").total)
assert.equal(vehicleMonth(archived, "c1", "v1", "2026-10")!.km, 2200)

// Status history: archived 15 Oct 2026 → September stays ACTIVE, October / November ARCHIVED.
const veh = { status: "ACTIVE" as string, statusHistory: [{ status: "ACTIVE", startDate: "2026-01-01", endDate: null }], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
const archivedOct = { ...veh, status: "ARCHIVED", statusHistory: withStatus(veh, "ARCHIVED", "2026-10-15") }
assert.deepEqual(archivedOct.statusHistory, [
  { status: "ACTIVE", startDate: "2026-01-01", endDate: "2026-10-14" },
  { status: "ARCHIVED", startDate: "2026-10-15", endDate: null },
])
assert.equal(statusOn(archivedOct, asOfMonth("2026-09", "2026-12-20")), "ACTIVE")
assert.equal(statusOn(archivedOct, asOfMonth("2026-10", "2026-12-20")), "ARCHIVED")
assert.equal(statusOn(archivedOct, asOfMonth("2026-11", "2026-12-20")), "ARCHIVED")
// Restore 11 Dec appends a new ACTIVE period; nothing is rewritten.
assert.deepEqual(withStatus(archivedOct, "ACTIVE", "2026-12-11").map((p) => [p.status, p.startDate, p.endDate]), [
  ["ACTIVE", "2026-01-01", "2026-10-14"],
  ["ARCHIVED", "2026-10-15", "2026-12-10"],
  ["ACTIVE", "2026-12-11", null],
])
// Archive then restore on the same day leaves no zero-length period.
assert.deepEqual(withStatus(archivedOct, "ACTIVE", "2026-10-15"), [{ status: "ACTIVE", startDate: "2026-01-01", endDate: null }])
// Migration: a record archived before history existed is ACTIVE until its last update.
assert.deepEqual(historyOf({ status: "ARCHIVED", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-06T09:00:00Z" }), [
  { status: "ACTIVE", startDate: "2026-01-01", endDate: "2026-10-05" },
  { status: "ARCHIVED", startDate: "2026-10-06", endDate: null },
])

// Vehicle transfer: KA05NK5115 works for TEPL in September, Apple from 1 Oct 2026.
const k5 = { id: "v5", createdAt: "2026-09-01T00:00:00Z", assignedCustomerId: "tepl" } as never
const k5Entries = [
  { id: "s", vehicleId: "v5", customerId: "tepl", date: "2026-09-05", amount: 1000 },
  { id: "o", vehicleId: "v5", customerId: "tepl", date: "2026-10-05", amount: 2000 }, // entered before the transfer was recorded
]
const k5Before = inferAssignments(k5, k5Entries, "2026-10-06")
assert.deepEqual(k5Before, [{ vehicleId: "v5", customerId: "tepl", startDate: "2026-09-01", endDate: null, status: "ACTIVE" }]) // migration = current reporting
assert.deepEqual(resolveCustomers(k5Entries, k5Before), k5Entries) // nothing moves before a transfer
const k5After = transferPeriods(k5Before, "v5", "apple", "2026-10-01")
assert.deepEqual(k5After.map((p) => [p.customerId, p.startDate, p.endDate, p.status]), [
  ["tepl", "2026-09-01", "2026-09-30", "ENDED"],
  ["apple", "2026-10-01", null, "ACTIVE"],
])
const moved = resolveCustomers(k5Entries, k5After)
assert.equal(moved[0].customerId, "tepl") // September stays with TEPL
assert.equal(moved[1].customerId, "apple") // October moves to Apple
assert.equal(moved.reduce((t, e) => t + e.amount, 0), 3000) // totals unchanged — only the customer column moves
assert.throws(() => transferPeriods(k5After, "v5", "tepl", "2026-09-15")) // can't rewrite an earlier assignment
// Migration of a vehicle that already changed customers reproduces each run.
assert.deepEqual(
  inferAssignments({ id: "v6", createdAt: "2026-01-01T00:00:00Z", assignedCustomerId: "b" } as never, [
    { vehicleId: "v6", customerId: "a", date: "2026-03-02" },
    { vehicleId: "v6", customerId: "b", date: "2026-05-10" },
  ], "2026-10-06").map((p) => [p.customerId, p.startDate, p.endDate]),
  [["a", "2026-01-01", "2026-05-09"], ["b", "2026-05-10", null]]
)

// Previous owner sees a read-only handover from the effective month on; the new owner and earlier months don't.
assert.deepEqual(handoverFrom(k5After, "tepl", asOfMonth("2026-10", "2026-10-06")), { toCustomerId: "apple", effectiveDate: "2026-10-01" })
assert.equal(handoverFrom(k5After, "tepl", asOfMonth("2026-09", "2026-10-06")), null)
assert.equal(handoverFrom(k5After, "apple", asOfMonth("2026-10", "2026-10-06")), null)

// Active Vehicles: open assignment today + status ACTIVE. The transferred vehicle counts for Apple only.
const fleet = new Map([["v5", { status: "ACTIVE" }], ["v7", { status: "ARCHIVED" }]]) as unknown as Parameters<typeof activeVehicleIds>[1]
const periods = [...k5After, { vehicleId: "v7", customerId: "tepl", startDate: "2026-01-01", endDate: null, status: "ACTIVE" as const }]
assert.equal(activeVehicleIds(periods, fleet, "tepl", "2026-10-06").size, 0) // v5 transferred away, v7 archived
assert.deepEqual([...activeVehicleIds(periods, fleet, "apple", "2026-10-06")], ["v5"])
assert.equal(activeVehicleIds(periods, fleet, "tepl", "2026-09-15").size, 1) // before the transfer it was TEPL's

// Month lock: employees edit only the open month; the Owner always can and can override.
assert.equal(monthLockInfo("2026-10", "2026-10-06", []).state, "OPEN") // current month open
assert.equal(monthLockInfo("2026-09", "2026-10-06", []).state, "LOCKED") // locks once October starts
assert.equal(canEditMonth("EMPLOYEE", "2026-09", "2026-10-06", []), false)
assert.equal(canEditMonth("OWNER", "2026-09", "2026-10-06", []), true)
const unlockedSep = [{ month: "2026-09", state: "OPEN", changedBy: "OWNER" }] as never
assert.equal(canEditMonth("EMPLOYEE", "2026-09", "2026-10-06", unlockedSep), true) // Owner unlocked September
const lockedOct = [{ month: "2026-10", state: "LOCKED", changedBy: "OWNER" }] as never
assert.equal(canEditMonth("DEV", "2026-10", "2026-10-06", lockedOct), false) // Owner locked October early — Dev follows the lock
assert.equal(canEditMonth("DEV", "2026-09", "2026-10-06", []), false) // Dev is a non-Owner for month locks
assert.equal(canEditMonth("OWNER", "2026-10", "2026-10-06", lockedOct), true)

// Fuel station report: derived from transactions; fuel type from the vehicle; AdBlue separate.
const stVehicles = new Map([["v1", { fuelType: "DIESEL" }], ["v2", { fuelType: "PETROL" }], ["v3", { fuelType: "EV" }]]) as never
const stTx = stationTransactions(
  "p1",
  [
    { id: "a", vendorId: "p1", vehicleId: "v1", customerId: "c1", date: "2026-10-02", litres: 100, rate: 90, amount: 9000 },
    { id: "b", vendorId: "p1", vehicleId: "v2", customerId: "c2", date: "2026-10-03", litres: 20, rate: 100, amount: 2000 },
    { id: "c", vendorId: "p1", vehicleId: "v3", customerId: "c2", date: "2026-09-03", litres: 50, rate: 10, amount: 500 },
    { id: "d", vendorId: "p9", vehicleId: "v1", customerId: "c1", date: "2026-10-04", litres: 70, rate: 90, amount: 6300 }, // other station
  ] as never,
  [{ id: "e", vendorId: "p1", vehicleId: "v1", customerId: "c1", date: "2026-10-05", quantityLitres: 10, amount: 800 }] as never,
  stVehicles
)
const stAll = stationSummary(stTx)
assert.deepEqual([stAll.dieselLitres, stAll.petrolLitres, stAll.evKwh, stAll.adblueLitres], [100, 20, 50, 10])
assert.deepEqual([stAll.fuelSpend, stAll.adblueSpend, stAll.combinedSpend], [11500, 800, 12300])
assert.deepEqual([stAll.vehiclesServed, stAll.customersServed, stAll.fills], [3, 2, 3])
assert.equal(stationSummary(stTx.filter(inStationPeriod("2026-10"))).fuelSpend, 11000) // month filter
assert.equal(stTx.find((t) => t.kind === "ADBLUE")?.rate, 80)

// Quarters: Q1 Jan–Mar … Q4 Oct–Dec; calculated from the same entries and reconciling with months and the year.
assert.deepEqual([quarterOf("2026-01-15"), quarterOf("2026-03-31"), quarterOf("2026-04-01"), quarterOf("2026-09-30"), quarterOf("2026-10-01"), quarterOf("2026-12-31")], [1, 1, 2, 3, 4, 4])
assert.deepEqual(quarterMonths("2026", 4), ["2026-10", "2026-11", "2026-12"])
const mi = { idx, diesel: ds.diesel, adblue: adRuns, customers: new Map(), vendors: new Map() }
const spendOf = (pred: Parameters<typeof buildMaster>[1]) => buildMaster(mi, pred).fluid.spend
const q4 = spendOf(inQuarter("2026", 4))
assert.equal(q4, quarterMonths("2026", 4).reduce((t, m) => t + spendOf(inPeriod(m)), 0)) // quarter = Σ its months
assert.equal(QUARTERS.reduce((t, q) => t + spendOf(inQuarter("2026", q)), 0), spendOf(inPeriod("2026"))) // Σ quarters = year
assert.equal(spendOf(inQuarter("2026", 3)), 900) // September AdBlue lands in Q3, not Q4
assert.deepEqual(litresByFuelType(idx, ds.diesel, inQuarter("2026", 4)), { DIESEL: 240, PETROL: 0, EV: 0 })

// Fuel station ledger — the spec example: Sep buy 100 pay 70 → 30 Debit; Oct buy 80 pay 150 → 40 Credit; Nov buy 60 → 20 Debit.
const pay = (date: string, amount: number) => ({ vendorId: "s1", date, amount, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT" })
const led = stationLedger(
  "s1",
  [
    { vendorId: "s1", date: "2026-09-05", amount: 100, paymentMode: "CREDIT" },
    { vendorId: "s1", date: "2026-09-06", amount: 999, paymentMode: "CASH" }, // paid at the pump: purchase + payment, nets to 0
    { vendorId: "s1", date: "2026-10-05", amount: 80, paymentMode: "CREDIT" },
    { vendorId: "s1", date: "2026-11-05", amount: 60 }, // AdBlue (on account)
    { vendorId: "s2", date: "2026-10-05", amount: 500, paymentMode: "CREDIT" }, // other station
  ],
  [pay("2026-09-20", 70), pay("2026-10-20", 150), { ...pay("2026-10-21", 5), categoryCode: "OFFICE" }],
  "2026-12"
)
assert.deepEqual(led.map((r) => [r.month, r.opening, r.purchased, r.paid, r.closing]), [
  ["2026-09", 0, 1099, 1069, 30], // 100 credit + 999 cash bought; 70 voucher + 999 at the pump paid
  ["2026-10", 30, 80, 150, -40],
  ["2026-11", -40, 60, 0, 20],
  ["2026-12", 20, 0, 0, 20], // carried forward with no activity
])
assert.deepEqual([balanceType(30), balanceType(-40), balanceType(0)], ["DEBIT", "CREDIT", "SETTLED"])
assert.deepEqual(ledgerFor(led, ["2026-10"]), { opening: 30, purchased: 80, paid: 150, vouchers: 150, manualCash: 0, cashAtPump: 0, tds: 0, closing: -40, carriedFrom: "2026-09" })
assert.deepEqual([led[0].vouchers, led[0].cashAtPump], [70, 999])
// Quarter Q4 (Oct–Dec) = chain of its months; year = all of 2026; reconciles with months.
const q4l = ledgerFor(led, ["2026-10", "2026-11", "2026-12"])
assert.deepEqual([q4l.opening, q4l.purchased, q4l.paid, q4l.closing], [30, 140, 150, 20])
assert.equal(q4l.closing, led.at(-1)!.closing)
const y = ledgerFor(led, Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`))
assert.deepEqual([y.opening, y.purchased, y.paid, y.closing], [0, 1239, 1219, 20])

// Reconciliation: ledger Fuel Purchased = station transaction history (fuel + AdBlue), cash included.
{
  const stTx2 = stationTransactions("p1", [
    { id: "x", vendorId: "p1", vehicleId: "v1", customerId: "c1", date: "2026-10-01", litres: 90, rate: 94.92, amount: 8542.7, paymentMode: "CREDIT" },
    { id: "y", vendorId: "p1", vehicleId: "v1", customerId: "c1", date: "2026-10-01", litres: 55, rate: 93.89, amount: 5164.1, paymentMode: "CREDIT" },
    { id: "z", vendorId: "p1", vehicleId: "v1", customerId: "c1", date: "2026-10-02", litres: 99, rate: 92.96, amount: 9203.46, paymentMode: "CASH" },
  ] as never, [], stVehicles)
  const l = ledgerFor(stationLedger("p1", stTx2.map((t) => ({ vendorId: "p1", date: t.date, amount: t.amount, paymentMode: t.id === "z" ? ("CASH" as const) : ("CREDIT" as const) })), []), ["2026-10"])
  assert.equal(stationSummary(stTx2).fuelSpend, 22910.26)
  assert.equal(l.purchased, 22910.26) // = Σ transaction history = Fuel Spend
  assert.deepEqual([l.vouchers, l.cashAtPump, l.closing], [0, 9203.46, 13706.8]) // the cash fill is paid at the pump; owed = credit fills
}

// Station payments have no grace period (31 Oct 2026) — npm run check:month covers paying old months.

// Payment history, newest first: date DESC, createdAt DESC, then sequential id (spec: 10:00 ₹10,000 · 11:00 ₹2,00,000 · 12:00 ₹50,000 · 13:00 ₹60,000).
assert.deepEqual(
  inEntryOrder([
    { id: "pay_x1", date: "2026-10-07", createdAt: "2026-10-07T10:00:00Z", amount: 10000 },
    { id: "pay_x2", date: "2026-10-06", createdAt: "2026-10-07T14:00:00Z", amount: 1 }, // older date, entered later — still below
    { id: "pay_x3", date: "2026-10-07", createdAt: "2026-10-07T12:00:00Z", amount: 50000 },
    { id: "pay_x4", date: "2026-10-07", createdAt: "2026-10-07T13:00:00Z", amount: 60000 },
    { id: "pay_x5", date: "2026-10-07", createdAt: "2026-10-07T11:00:00Z", amount: 200000 },
  ]).map((p) => p.amount),
  [60000, 50000, 200000, 10000, 1]
)
// Same createdAt (seeded data) → sequential id decides, newest first — never array position.
assert.deepEqual(inEntryOrder([{ id: "pay_000a", date: "2026-09-12", createdAt: "x" }, { id: "pay_000c", date: "2026-09-12", createdAt: "x" }, { id: "pay_000b", date: "2026-09-12", createdAt: "x" }]).map((p) => p.id), ["pay_000c", "pay_000b", "pay_000a"])

// Cash handling — Raghuveer, October 2026 (real figures): 4 NEFT vouchers ₹3,20,000, manual cash ₹10,000 + ₹40,000, a ₹9,203.46 cash fill.
{
  const fills = [
    { id: "dsl_01d6", vendorId: "r", vehicleId: "v1", date: "2026-10-01", amount: 8542.7, paymentMode: "CREDIT" as const, createdAt: "2026-10-01T09:30:00Z" },
    { id: "dsl_06jj", vendorId: "r", vehicleId: "v1", date: "2026-10-01", amount: 5164.1, paymentMode: "CREDIT" as const, createdAt: "2026-10-01T09:30:00Z" },
    { id: "dsl_04h1", vendorId: "r", vehicleId: "v1", date: "2026-10-02", amount: 9203.46, paymentMode: "CASH" as const, createdAt: "2026-10-02T09:30:00Z" },
    { id: "dsl_sep1", vendorId: "r", vehicleId: "v1", date: "2026-09-20", amount: 466230.82, paymentMode: "CREDIT" as const, createdAt: "2026-09-20T09:30:00Z" },
  ]
  const v = (id: string, amount: number, mode: string, t: string) => ({ id, paymentNo: id, vendorId: "r", date: "2026-10-07", amount, mode, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT", createdAt: `2026-10-07T${t}`, notes: "" })
  const vouchers = [v("p0580", 10000, "NEFT", "06:05"), v("p0169", 200000, "NEFT", "06:06"), v("p0170", 50000, "NEFT", "06:19"), v("p0171", 60000, "NEFT", "06:27"), v("p0172", 10000, "CASH", "06:34"), v("p0173", 40000, "CASH", "06:36")]
  const rows = stationLedger("r", fills, vouchers)
  const oct = ledgerFor(rows, ["2026-10"])
  assert.deepEqual([oct.vouchers, oct.manualCash, oct.cashAtPump, oct.paid], [320000, 50000, 9203.46, 379203.46])
  // Reconciliation 1: Voucher + Manual Cash + Cash at Pump = Payments Made.
  assert.equal(round2(oct.vouchers + oct.manualCash + oct.cashAtPump), oct.paid)
  // Reconciliation 2: Opening + Fuel Purchased − Payments Made = Closing (manual cash reduces the debit like NEFT).
  assert.equal(round2(oct.opening + oct.purchased - oct.paid), oct.closing)
  assert.deepEqual([oct.opening, oct.purchased, oct.closing], [466230.82, 22910.26, 109937.62])
  // Payment history: every payment is a row — vouchers, manual cash and an auto "Cash at Pump" row; Σ = Payments Made.
  const hist = inEntryOrder(stationPaymentHistory("r", vouchers, fills).filter((h) => h.date.startsWith("2026-10")))
  assert.equal(round2(hist.reduce((t, h) => t + h.amount, 0)), oct.paid)
  const auto = hist.find((h) => h.kind === "CASH_AT_PUMP")!
  assert.deepEqual([auto.reference, auto.date, auto.amount, auto.linkedEntryId, auto.readOnly], ["AUTO-CASH-dsl_04h1", "2026-10-02", 9203.46, "dsl_04h1", true])
  assert.deepEqual(hist.filter((h) => h.kind === "MANUAL_CASH").map((h) => h.amount), [40000, 10000])
  assert.deepEqual(hist.map((h) => h.amount), [40000, 10000, 60000, 50000, 200000, 10000, 9203.46]) // newest first
  // Every station × month of the check data reconciles too.
  for (const r of stationLedger("s1", [], [])) assert.equal(round2(r.opening + r.purchased - r.paid), r.closing)
  for (const r of led) {
    assert.equal(round2(r.vouchers + r.manualCash + r.cashAtPump), r.paid)
    assert.equal(round2(r.opening + r.purchased - r.paid), r.closing)
  }
}

// AdBlue inventory — spec examples.
{
  const buy = (id: string, date: string, buckets: number, perBucket: number, price: number, vendorName = "XYZ Chemicals") => ({ id, date, vendorName, totalLitres: buckets * perBucket, totalCost: buckets * price })
  const draw = (id: string, date: string, quantityLitres: number) => ({ id, date, quantityLitres })
  // 10 buckets × 20 L @ ₹900 = 200 L for ₹9,000; a bus draws 15 L → 185 L worth ₹8,325.
  const v = valueInventory([buy("b1", "2026-10-01", 10, 20, 900)], [draw("u1", "2026-10-02", 15)])
  assert.deepEqual([v.stockLitres, v.stockValue, v.avgRate, v.costOf.get("u1"), v.shortfall], [185, 8325, 45, 675, null])
  // Weighted average re-averages on each purchase: 100 L @ ₹40 + 100 L @ ₹50 → ₹45/L.
  const w = valueInventory([buy("b1", "2026-09-01", 5, 20, 800), buy("b2", "2026-09-10", 5, 20, 1000)], [draw("u1", "2026-09-05", 50), draw("u2", "2026-09-20", 50)])
  assert.deepEqual([w.costOf.get("u1"), w.costOf.get("u2"), w.stockLitres, w.stockValue], [2000, 2333.33, 100, 4666.67]) // 50 L @ 40; then (2000+5000)/150 = 46.67/L
  assert.equal(round2(2000 + 2333.33 + w.stockValue), 9000) // Σ consumption cost + stock value = Σ purchase cost
  // No negative stock: 5 L in stock, 10 L drawn → blocked with the available stock.
  const short = valueInventory([buy("b1", "2026-10-01", 1, 5, 225)], [draw("u1", "2026-10-02", 10)])
  assert.deepEqual(short.shortfall, { date: "2026-10-02", available: 5, needed: 10, consumptionId: "u1" })
  assert.equal(insufficientMessage(5), "Insufficient AdBlue inventory. Available stock: 5L")
  // A back-dated draw before stock arrived is also a shortfall (stock is checked at every point in time).
  assert.equal(valueInventory([buy("b1", "2026-10-05", 1, 20, 900)], [draw("u1", "2026-10-03", 5)]).shortfall?.available, 0)
  // Monthly ledger & carry forward — Sep: 80 + 200 − 160 = 120; Oct: 120 + 100 − 50 = 170.
  const led = inventoryLedger(
    [buy("o", "2026-08-15", 4, 20, 900), buy("s", "2026-09-03", 10, 20, 900), buy("t", "2026-10-03", 5, 20, 900)],
    [draw("c1", "2026-09-20", 160), draw("c2", "2026-10-20", 50)]
  )
  assert.deepEqual(led.map((r) => [r.month, r.opening, r.purchased, r.consumed, r.closing]), [
    ["2026-08", 0, 80, 0, 80],
    ["2026-09", 80, 200, 160, 120],
    ["2026-10", 120, 100, 50, 170],
  ])
  for (let i = 1; i < led.length; i++) assert.equal(led[i].opening, led[i - 1].closing) // closing → next opening
  const oct = stockFor(led, ["2026-10"])
  assert.deepEqual([oct.opening, oct.carriedFrom, oct.closing], [120, "2026-09", 170])
  // Reconciliation: Σ purchased − Σ consumed = current stock; quarter / year chain through months.
  const all = stockFor(led)
  assert.equal(round2(all.purchased - all.consumed), valueInventory([buy("o", "2026-08-15", 4, 20, 900), buy("s", "2026-09-03", 10, 20, 900), buy("t", "2026-10-03", 5, 20, 900)], [draw("c1", "2026-09-20", 160), draw("c2", "2026-10-20", 50)]).stockLitres)
  assert.equal(stockFor(led, ["2026-07", "2026-08", "2026-09"]).closing, 120)
  assert.equal(round2(all.purchasedCost - all.consumedCost), round2(170 * 45)) // value reconciles too (single rate here)
  // Vendor analytics.
  assert.deepEqual(vendorAnalytics([buy("a", "2026-10-01", 60, 20, 900), buy("b", "2026-10-02", 1, 20, 1000, "ABC")]).map((x) => [x.vendor, x.litres, x.amount, x.avgRate]), [["XYZ Chemicals", 1200, 54000, 45], ["ABC", 20, 1000, 50]])
}

// AdBlue purchased in a period = only batches bought in it (spec: Sep 500 L ₹15,000, used 200; Oct 400 L ₹12,000, used 100).
{
  const buys = [
    { id: "sep", date: "2026-09-05", vendorName: "XYZ", totalLitres: 500, totalCost: 15000 },
    { id: "oct", date: "2026-10-05", vendorName: "XYZ", totalLitres: 400, totalCost: 12000 },
  ]
  const draws = [{ id: "u1", date: "2026-09-20", quantityLitres: 200 }, { id: "u2", date: "2026-10-20", quantityLitres: 100 }]
  const oct = purchasedIn(buys, (p) => p.date.startsWith("2026-10"))
  assert.deepEqual([oct.cost, oct.litres], [12000, 400]) // ✅ ₹12,000 / 400 L — not ₹27,000, not stock value, not carry-forward
  const led = inventoryLedger(buys, draws)
  const octStock = stockFor(led, ["2026-10"])
  assert.deepEqual([octStock.opening, octStock.purchased, octStock.purchasedCost, octStock.closing], [300, 400, 12000, 600]) // carry-forward 300 L never inflates purchases
  assert.equal(valueInventory(buys, draws).stockValue, 18000) // inventory value (600 L @ ₹30) is a different figure
  assert.equal(purchasedIn(buys, (p) => p.date.startsWith("2026")).cost, 27000) // yearly / all time = Σ all batches
  assert.equal(purchasedIn(buys, inQuarter("2026", 4)).cost, 12000) // Q4 = October batch only
}

// Diesel Tanker: cargo = loads − (tanker-sourced fills + external dispenses); carry forward; no overdraw.
const TA = "tnk_a"
const TB = "tnk_b"
const TC = "tnk_c"
const tkLoad = (id: string, date: string, litres: number, rate: number, tankerId = TA, stationId = "dv_vishal") => ({ id, tankerId, date, createdAt: `${date}T08:00:00Z`, updatedAt: "", stationId, invoiceNo: "", litres, rate, amount: round2(litres * rate), notes: "" })
const recs = (r: Partial<TankerRecords>): TankerRecords => ({ loads: [], fills: [], external: [], transfers: [], adjustments: [], ...r });
{
  const loads = [tkLoad("tkl_1", "2026-09-02", 1000, 90), tkLoad("tkl_2", "2026-10-03", 400, 95)]
  const fills = [
    { id: "f1", tankerId: TA, date: "2026-09-10", createdAt: "2026-09-10T10:00:00Z", litres: 300, vendorId: "dv_tanker", rate: 0 }, // registered vehicle from the tanker (saved without a rate)
    { id: "f2", date: "2026-09-12", createdAt: "2026-09-12T10:00:00Z", litres: 150, vendorId: "dv_vishal", rate: 100 }, // ordinary pump fill — not cargo
    { id: "f3", tankerId: TA, date: "2026-10-08", createdAt: "2026-10-08T10:00:00Z", litres: 250, vendorId: "dv_tanker", rate: 98.81 }, // rate recorded on the fill (answer 23)
  ]
  const ext = [{ id: "tkd_1", tankerId: TA, date: "2026-09-20", createdAt: "2026-09-20T10:00:00Z", updatedAt: "", vehicleNo: "KA01AB1234", litres: 200, notes: "" }]
  const r = recs({ loads, fills, external: ext })
  const led = tankerLedger(tankerMoves(r), TA)
  // Sep: 0 + 1000 − (300 + 200) = 500; Oct: 500 carried forward + 400 − 250 = 650.
  assert.deepEqual(led.map((x) => [x.month, x.opening, x.loaded, x.dispensed, x.closing]), [["2026-09", 0, 1000, 500, 500], ["2026-10", 500, 400, 250, 650]])
  assert.deepEqual([tankerPeriod(led, ["2026-10"]).opening, tankerPeriod(led, ["2026-10"]).carriedFrom], [500, "2026-09"])
  const v = valueTankers(r)
  assert.equal(v.stock.get(TA)!.litres, 650) // Loaded 1400 − Dispensed 750 = 650 (the 150 L pump fill never touches cargo)
  assert.equal(round2(tankerPeriod(led).loaded - tankerPeriod(led).dispensed), v.stock.get(TA)!.litres)
  assert.equal(v.costOf.get("f1"), 27000) // a fill saved without a rate: 300 L × ₹90 average
  // Answer 23 — a fill's amount is litres × the rate recorded on it, never replaced by the weighted average.
  assert.equal(fillAmount(fills[2], v.costOf), round2(250 * 98.81))
  assert.equal(fillAmount(fills[0], v.costOf), 27000)
  // Four separate figures: purchase cost (loads), fill amount (rate on fill), stock valuation (average), revenue (trips — not here).
  assert.equal(tankerPeriod(led, ["2026-10"]).loadedCost, 38000) // purchase cost = Oct load only
  assert.notEqual(fillAmount(fills[2], v.costOf), v.costOf.get("f3")) // fill amount ≠ the stock's average cost of those litres
  // Overdraw: 300 L in the tanker, 400 L requested → rejected.
  const over = valueTankers(recs({ loads: [tkLoad("tkl_x", "2026-10-01", 300, 90)], fills: [{ id: "big", tankerId: TA, date: "2026-10-02", createdAt: "2026-10-02T10:00:00Z", litres: 400, vendorId: "dv_tanker" }] }))
  assert.deepEqual([over.shortfall?.available, over.shortfall?.tankerId, insufficientTankerMessage(over.shortfall!.available)], [300, TA, "Insufficient tanker inventory. Available: 300 L"])
  assert.equal(insufficientTankerMessage(50, "Tanker TN70AX9480"), "Insufficient tanker inventory in Tanker TN70AX9480. Available: 50 L")
  // Alerts (per tanker; defaults 500 / 100 L).
  // Loads are credit purchases at their supplier station (money owed); tanker fills never are.
  const station = stationLedger("dv_vishal", [...fills.map((f) => ({ ...f, amount: f.litres * 100, paymentMode: "CREDIT" as const })), ...loadsAsStationPurchases(loads)], [])
  assert.equal(ledgerFor(station).purchased, 150 * 100 + 1000 * 90 + 400 * 95) // pump fill + both loads; tanker fills (f1, f3) excluded
  // Records saved before tankers existed (no tankerId) belong to the default tanker.
  const legacy = valueTankers(recs({ loads: [{ ...tkLoad("tkl_old", "2026-08-01", 100, 90), tankerId: undefined }] }))
  assert.equal(legacy.stock.get("tnk_default")!.litres, 100)
}

// Multi-tanker (answer 24): three tankers plus a fourth, each with its own stock; transfers and adjustments.
{
  const loads = [tkLoad("l_a", "2026-09-01", 1000, 90, TA), tkLoad("l_b", "2026-09-01", 600, 92, TB), tkLoad("l_c", "2026-09-02", 300, 94, TC), tkLoad("l_d", "2026-10-02", 200, 95, "tnk_d")]
  const fills = [{ id: "fa", tankerId: TA, date: "2026-09-05", createdAt: "", litres: 400, vendorId: "dv_tanker", rate: 95 }, { id: "fb", tankerId: TB, date: "2026-09-06", createdAt: "", litres: 100, vendorId: "dv_tanker", rate: 95 }]
  const transfers = [{ id: "t1", date: "2026-09-10", createdAt: "", fromTankerId: TA, toTankerId: TC, litres: 250 }]
  const adjustments = [{ id: "a1", date: "2026-09-30", createdAt: "", tankerId: TB, litres: -20 }, { id: "a2", date: "2026-09-30", createdAt: "", tankerId: TC, litres: 5 }]
  const r = recs({ loads, fills, transfers, adjustments })
  const v = valueTankers(r)
  // A: 1000 − 400 − 250 = 350 · B: 600 − 100 − 20 = 480 · C: 300 + 250 + 5 = 555 · D (added later): 200
  assert.deepEqual([TA, TB, TC, "tnk_d"].map((t) => v.stock.get(t)!.litres), [350, 480, 555, 200])
  const moves = tankerMoves(r)
  const sep = (t: string | null) => tankerPeriod(tankerLedger(moves, t, "2026-10"), ["2026-09"])
  assert.deepEqual([sep(TA).transferOut, sep(TC).transferIn, sep(TB).adjusted, sep(TC).adjusted], [250, 250, -20, 5])
  // Opening + Loaded + Transfers in + Adjustments − Dispensed − Transfers out = Closing, per tanker.
  for (const t of [TA, TB, TC]) {
    const p = sep(t)
    assert.equal(p.closing, round2(p.opening + p.openingStock + p.loaded + p.transferIn + p.adjusted - p.dispensed - p.transferOut))
    assert.equal(tankerPeriod(tankerLedger(moves, t, "2026-10"), ["2026-10"]).opening, p.closing) // carries forward
  }
  // All tankers together: a transfer is not a purchase and doesn't change company stock; loads are counted once.
  const all = sep(null)
  assert.deepEqual([all.loaded, all.loadedCost, all.transferIn, all.transferOut, all.closing], [1900, round2(90000 + 55200 + 28200), 0, 0, 350 + 480 + 555])
  assert.equal(round2(sep(TA).loadedCost + sep(TB).loadedCost + sep(TC).loadedCost), all.loadedCost)
  // Station purchases: loads only — transfers never appear as purchases.
  assert.equal(loadsAsStationPurchases(loads).length, 4)
  // A transfer can't overdraw the source tanker (no other tanker's stock is borrowed).
  const tooMuch = valueTankers(recs({ loads, transfers: [{ id: "t2", date: "2026-09-02", createdAt: "", fromTankerId: TC, toTankerId: TA, litres: 301 }] }))
  assert.deepEqual([tooMuch.shortfall?.tankerId, tooMuch.shortfall?.available], [TC, 300])
  // A negative adjustment can't take a tanker below zero either.
  assert.equal(valueTankers(recs({ loads: [loads[2]], adjustments: [{ id: "a3", date: "2026-09-03", createdAt: "", tankerId: TC, litres: -301 }] })).shortfall?.tankerId, TC)
  // Opening stock (stock already in a tanker when records began) is not a purchase and owes no station.
  const opening = { ...tkLoad("l_open", "2026-04-01", 7721, 90.99, TA), stationId: "", opening: true }
  const withOpening = tankerPeriod(tankerLedger(tankerMoves(recs({ loads: [opening, tkLoad("l_apr", "2026-04-03", 2000, 92.99, TA)] })), TA, "2026-04"), ["2026-04"])
  assert.deepEqual([withOpening.openingStock, withOpening.loaded, withOpening.loadedCost, withOpening.closing], [7721, 2000, 185980, 9721])
  assert.equal(loadsAsStationPurchases([opening]).length, 0)
}

// Financial year (Apr–Mar) — the one shared helper; FY 2026–27 = 1 Apr 2026 … 31 Mar 2027.
{
  assert.deepEqual(fyRange(2026), { from: "2026-04-01", to: "2027-03-31" })
  assert.deepEqual([fyStartYear("2026-03-31"), fyStartYear("2026-04-01"), fyStartYear("2027-03-31"), fyStartYear("2027-04-01")], [2025, 2026, 2026, 2027])
  assert.equal(fyName(2026), "FY 2026–27")
  assert.equal(fyLabel("2026-10-05"), "26-27")
  const months = fyMonths(2026)
  assert.deepEqual([months.length, months[0], months.at(-1), new Set(months).size], [12, "2026-04", "2027-03", 12]) // no month twice
  const inFy = inFY(2026)
  assert.deepEqual(["2026-03-31", "2026-04-01", "2027-03-31", "2027-04-01"].map((date) => inFy({ date })), [false, true, true, false])
  // A FY total = Σ its months, each transaction counted once (calendar years overlap two FYs, never double count).
  const txns = ["2026-03-15", "2026-04-02", "2026-12-31", "2027-01-01", "2027-03-31", "2027-04-01"].map((date, i) => ({ date, amount: (i + 1) * 100 }))
  const fyTotal = txns.filter(inFy).reduce((t, x) => t + x.amount, 0)
  const byMonth = months.reduce((t, m) => t + txns.filter((x) => x.date.startsWith(m)).reduce((s, x) => s + x.amount, 0), 0)
  assert.deepEqual([fyTotal, byMonth], [200 + 300 + 400 + 500, 1400])
}

// TDS on fuel purchases (uncle's answer 14): 0.1% of the month's Fuel Purchased, dated the month's last day.
{
  assert.equal(FUEL_TDS_PERCENT, 0.1)
  assert.equal(tdsDue(2334545.31), 2334.55) // Shree Shankara, April 2026 (source shows ₹2,335)
  assert.equal(tdsDue(9561015.69), 9561.02) // Raghuveer, April 2026 (source shows ₹9,562)
  assert.deepEqual([tdsDate("2026-04"), tdsDate("2026-02"), tdsDate("2028-02"), tdsDate("2026-12")], ["2026-04-30", "2026-02-28", "2028-02-29", "2026-12-31"])
  // A TDS entry settles the bill like a payment, appears in the history and never touches the bank (amount 0).
  const tdsVoucher = { id: "tds1", paymentNo: "V-T", vendorId: "s1", date: "2026-09-30", amount: 0, tdsAmount: 100, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT", mode: "TDS", notes: "" }
  const led = ledgerFor(stationLedger("s1", [{ vendorId: "s1", date: "2026-09-10", amount: 100000 }], [tdsVoucher]), ["2026-09"])
  assert.deepEqual([led.purchased, led.tds, led.paid, led.closing], [100000, 100, 100, 99900])
  const rows = stationPaymentHistory("s1", [tdsVoucher], [])
  assert.deepEqual([rows[0].kind, rows[0].amount], ["TDS", 100])
}

// AdBlue (uncle's answer 25): direct vendor purchases never enter or leave bulk stock, and are never counted twice.
{
  const buys = [{ id: "b1", date: "2026-09-01", vendorName: "Bulk Co", totalLitres: 200, totalCost: 9000 }]
  const entries = [
    { id: "s1", date: "2026-09-05", quantityLitres: 15, source: "STOCK" as const },
    { id: "d1", date: "2026-09-06", quantityLitres: 20, source: "DIRECT" as const, amount: 1900 },
    { id: "s2", date: "2026-09-07", quantityLitres: 10 }, // older entries without a source are stock draws
  ]
  const draws = stockDraws(entries)
  assert.deepEqual(draws.map((e) => e.id), ["s1", "s2"])
  assert.deepEqual([isDirectAdBlue(entries[1]), isDirectAdBlue(entries[0]), isDirectAdBlue(entries[2])], [true, false, false])
  const v = valueInventory(buys, draws)
  assert.equal(v.stockLitres, 175) // 200 − 15 − 10: the 20 L direct purchase never left bulk stock
  assert.equal(purchasedIn(buys, () => true).cost, 9000) // bulk purchases exclude the direct purchase
  const issuedCost = round2((v.costOf.get("s1") ?? 0) + (v.costOf.get("s2") ?? 0))
  const expense = round2(issuedCost + 1900) // Total AdBlue expense = bulk issued at cost + direct
  assert.equal(expense, round2(25 * 45 + 1900))
  // A direct purchase bigger than the stock is fine (it isn't drawn from it).
  assert.equal(valueInventory(buys, stockDraws([...entries, { id: "d2", date: "2026-09-08", quantityLitres: 500, source: "DIRECT" as const }])).shortfall, null)
}

// Fuel ecosystem audit (test_run.md) — regressions for the fixes made in the audit.
{
  const load = (id: string, date: string, litres: number, rate: number, stationId = "s1") => tkLoad(id, date, litres, rate, TA, stationId)
  const loads = [load("tkl_a", "2026-09-02", 1000, 94.8), load("tkl_b", "2026-09-09", 800, 95.1, "s2"), load("tkl_c", "2026-09-17", 900, 94.6, "s3"), load("tkl_d", "2026-09-24", 700, 95.2)]
  // A September like the dummy data: 3,400 L loaded, 2,850 L dispensed (registered + external) → 550 L into October.
  const out = [220, 260, 80, 280, 240, 100, 280, 240, 260, 90, 250, 280, 70, 200].map((l, i) => ({ id: `o${i}`, tankerId: TA, date: `2026-09-${String(4 + i * 2).padStart(2, "0")}`, createdAt: "", litres: l }))
  const octIn = [load("tkl_e", "2026-10-01", 1000, 95), load("tkl_f", "2026-10-03", 500, 94.5)]
  const led = tankerLedger(tankerMoves(recs({ loads: [...loads, ...octIn], external: [...out, { id: "x1", tankerId: TA, date: "2026-10-05", createdAt: "", litres: 300 }] })), TA)
  assert.deepEqual(led.map((r) => [r.month, r.opening, r.loaded, r.dispensed, r.closing]), [["2026-09", 0, 3400, 2850, 550], ["2026-10", 550, 1500, 300, 1750]])
  assert.equal(tankerPeriod(led, ["2026-10"]).opening, tankerPeriod(led, ["2026-09"]).closing) // September Closing = October Opening
  assert.equal(tankerPeriod(led, ["2026-10"]).loadedCost, 142250) // Fuel Purchase Cost: October loads only, never the carried 550 L
  assert.equal(tankerPeriod(led, ["2026-09"]).loadedCost, 322660)

  // Vehicles Served never counts a tanker load (no vehicle) as a vehicle.
  const purchases = [{ ...fill("pf1", 0, 50, 4650), vendorId: "s1" }, ...loadsAsStationPurchases(loads)]
  const vIdx = new Map([["v1", { ...ds.vehicles[0] }]]) as unknown as Parameters<typeof stationTransactions>[3]
  assert.equal(stationSummary(stationTransactions("s1", purchases as never, [], vIdx)).vehiclesServed, 1)

  // Vendor table purchases include tanker loads, like the ledger's payable (dieselByVendor = stationLedger).
  const dsv = { settings: { tanker: undefined }, diesel: [purchases[0]], payments: [], tankerLoads: loads, fuelStations: [{ id: "s1", name: "S1", isTanker: false }, { id: "dv_tanker", name: "Diesel Tanker", isTanker: true }] } as unknown as Dataset
  const s1 = dieselByVendor(dsv, { from: "2026-09-01", to: "2026-09-30" }).find((r) => r.vendor.id === "s1")!
  assert.deepEqual([s1.fills, s1.litres, s1.amount, s1.outstanding], [2, 1700, round2(94800 + 66640), round2(94800 + 66640 + 4650)]) // Sept purchases; payable is all time (incl. the Oct pump fill)

  // Station payment history filtered to a period sums to that period's Payments Made.
  const pays = [
    { id: "p1", paymentNo: "V1", vendorId: "s1", date: "2026-09-15", amount: 50000, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT", mode: "NEFT", notes: "" },
    { id: "p2", paymentNo: "V2", vendorId: "s1", date: "2026-10-03", amount: 20000, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT", mode: "CASH", notes: "" },
  ]
  const cashFill = { ...fill("cf1", 0, 10, 930), vendorId: "s1", date: "2026-10-04", paymentMode: "CASH" as const }
  const rowsOct = stationPaymentHistory("s1", pays, [cashFill]).filter(inStationPeriod("2026-10"))
  const ledOct = ledgerFor(stationLedger("s1", [cashFill, ...loadsAsStationPurchases(loads)], pays), ["2026-10"])
  assert.equal(round2(rowsOct.reduce((t, r) => t + r.amount, 0)), ledOct.paid) // 20,000 manual cash + 930 cash at pump
  assert.equal(ledOct.paid, 20930)
}

/* Search boxes: vehicle search (Diesel landing) and the shared match (customer searches). */
{
  assert.ok(matchesSearch("vishal", "Vishal Group") && matchesSearch("VISH", "vishal") && matchesSearch("ka 53", "KA53C0538") && matchesSearch("", "x"))
  assert.ok(!matchesSearch("tata", "Vishal Group", null, undefined))
  const veh = (id: string, regNo: string, extra: object = {}) => ({ id, regNo, make: "Tata", model: "LPT 1618", typeCode: "TRUCK", status: "ACTIVE", assignedCustomerId: "cus_cached", ...extra }) as unknown as Parameters<typeof searchVehicles>[1][number]
  const office = veh("v1", "KA53C0538")
  const spare = veh("v2", "KA53AB1234") // cached assignedCustomerId but no assignment → Unassigned
  const jio = veh("v3", "TN70AX9480", { make: "", model: "" })
  const periods = [
    { vehicleId: "v1", customerId: "cus_a", startDate: "2026-04-01", endDate: "2026-09-30", status: "ENDED" as const },
    { vehicleId: "v1", customerId: "cus_b", startDate: "2026-10-01", endDate: null, status: "ACTIVE" as const },
    { vehicleId: "v3", customerId: "cus_a", startDate: "2026-04-01", endDate: null, status: "ACTIVE" as const },
  ]
  const find = (q: string, asOf = "2026-10-31") => searchVehicles(q, [office, spare, jio, office], periods, "2026-10-31", asOf, new Map([["v3", "JIO"]]))
  assert.deepEqual(find("KA53").map((h) => h.vehicle.id), ["v2", "v1"]) // partial, each vehicle once (v1 passed twice), A–Z
  assert.deepEqual(find("ka53c0538").map((h) => h.vehicle.id), ["v1"]) // exact, any case
  assert.deepEqual(find("53c").map((h) => h.vehicle.id), ["v1"])
  assert.deepEqual(find("jio").map((h) => h.vehicle.id), ["v3"]) // by name
  assert.equal(find("  ").length, 0)
  assert.deepEqual([find("KA53C0538")[0].currentCustomerId, find("KA53AB1234")[0].currentCustomerId], ["cus_b", null]) // today's assignment; no cache
  assert.deepEqual([find("KA53C0538", "2026-09-30")[0].customerIdAsOf, find("KA53C0538", "2026-09-30")[0].currentCustomerId], ["cus_a", "cus_b"]) // September: its customer then
  // A customer's own vehicles (Customer Details → Vehicles): now vs previously, from the periods; others never listed.
  const fleet = new Map([office, spare, jio].map((v) => [v.id, v]))
  const ofA = customerVehicles("cus_a", periods, fleet, "2026-10-31")
  assert.deepEqual(ofA.map((r) => [r.vehicle.id, r.current, r.startDate, r.endDate, r.nowWith]), [["v1", false, "2026-04-01", "2026-09-30", "cus_b"], ["v3", true, "2026-04-01", null, null]])
  assert.deepEqual(customerVehicles("cus_b", periods, fleet, "2026-10-31").map((r) => [r.vehicle.id, r.current]), [["v1", true]])
  assert.deepEqual(customerVehicles("cus_b", periods, fleet, "2026-09-15"), []) // its period hadn't started
  assert.equal(customerVehicles("cus_cached", periods, fleet, "2026-10-31").length, 0) // the cache is never used
}

console.log("diesel calculations: all checks passed")
