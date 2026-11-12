/**
 * Runnable check for fuel-wise expenditure (owner, 12 Nov 2026):  npm run check:fuel-wise
 * Real API on in-memory demo data (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST.
 *
 *   1–9. Customers with Diesel only, Petrol only, Diesel + Petrol, EV only, Diesel + Petrol + EV, industrial supplies
 *        only, AdBlue, every category, and nothing: only the fuel types of their vehicles appear, each figure = its
 *        own records, Total Expenditure = the categories, fuel litres never include AdBlue litres or EV kWh.
 *   11–12. A vehicle moving A → B on 16 Oct: the 10 Oct fill stays A's, the 20 Oct fill is B's; A's figures for
 *        earlier fills never change because of the transfer.
 *   13. Month boundaries (31 Oct / 1 Nov) and periods: Σ months = the quarter = all time, each fill once.
 *   14. A deleted fill leaves every total; restored, it comes back once.
 *   15. Tata Adblue (one granted customer): only that customer's fills and supplies reach it.
 *   16. Reconciliation: Σ customers per fuel = the company's fills of that fuel; Σ Total Expenditure = every fill +
 *       every supply + every AdBlue entry of the month, each once; vehicle figures = their customer's.
 *   17. The main Diesel dashboard: the fleet's fuel cards = its fills of each fuel, Industrial and AdBlue each record once,
 *       Total Expenditure = Σ customer cards = Σ customer Overviews; comparison over the same days; Tata Adblue's own.
 *   18. Petrol: on the main page next to Diesel, its own expenditure, vehicles, KM/L (its own fills), customer figures,
 *       periods, edit / delete moving only Petrol, other fills untouched, its own labels and styling.
 *   19. Vehicle Count: every distinct Active vehicle of any fuel, fuelled or not; archived ones out; once each.
 * Not covered (no data model for it yet): a vehicle's fuel type changing — see CLAUDE.md "Fuel-wise expenditure".
 */
import assert from "node:assert/strict"
import { loadCheckDemoData, setRole } from "./test-browser"

const FIXED = new Date("2026-11-10T04:30:00.000Z").getTime()
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(FIXED)
  }
  static now() {
    return FIXED
  }
}
globalThis.Date = FixedDate as DateConstructor

async function main() {
  const { api } = await import("./index")
  const { todayISO, round2 } = await import("@/lib/format")
  const { buildDieselIndex, groupMonth, vehicleMonth, statsOf } = await import("@/domain/diesel")
  const { fuelWise, fuelLitres, totalExpenditure, fillFuel, withCustomerExpenditure, fleetExpenditure } = await import("@/domain/expenditure")
  const { customerCards } = await import("@/domain/diesel")
  const { industrialTotals } = await import("@/domain/industrial")
  const { adBlueStats, withRuns } = await import("@/domain/adblue")
  const { profileCall } = await import("@/lib/server/erp/profiles")
  assert.equal(todayISO(), "2026-11-10")
  loadCheckDemoData()
  setRole("OWNER")

  /* ---------------------------------------------------------------- set-up */
  const { id: _ci, createdAt: _cc, updatedAt: _cu, statusHistory: _cs, ...custBase } = (await api.customers.list())[0]
  const vTemplate = (await api.vehicles.list()).find((v) => v.fuelType === "DIESEL" && v.status === "ACTIVE")!
  const { id: _vi, createdAt: _vc, updatedAt: _vu, statusHistory: _vs, ...vBase } = vTemplate
  void [_ci, _cc, _cu, _cs, _vi, _vc, _vu, _vs]
  let n = 0
  const customer = async (name: string) => (await api.customers.create({ ...custBase, name, shortName: name, code: `FW${++n}`, logoDataUrl: undefined } as never)).id
  const odo = new Map<string, number>()
  const vehicle = async (customerId: string, fuelType: "DIESEL" | "PETROL" | "EV", since = "2026-09-01") => {
    const v = await api.vehicles.create({ ...vBase, regNo: `TN70FW${String(++n).padStart(4, "0")}`, fuelType, assignedCustomerId: customerId, assignedSince: since, odometerKm: 1000, defaultDriverId: null } as never)
    odo.set(v.id, 1000)
    return v.id
  }
  const station = (await api.fuelStations.list()).find((s) => !s.isTanker && s.status === "ACTIVE")!.id
  const fill = async (vehicleId: string, customerId: string, date: string, litres: number, rate: number) => {
    odo.set(vehicleId, odo.get(vehicleId)! + 400)
    return api.diesel.create({ date, vehicleId, customerId, vendorId: station, litres, rate, odometerKm: odo.get(vehicleId)!, billNo: "", paymentMode: "CREDIT" })
  }
  const abKm = new Map<string, number>()
  const adblue = (vehicleId: string, date: string, quantityLitres: number, extra: object) => {
    abKm.set(vehicleId, (abKm.get(vehicleId) ?? 5000) + 500)
    return api.adblue.create({ vehicleId, customerId: null, date, invoiceNo: "", notes: "", closingKm: abKm.get(vehicleId)!, quantityLitres, ...extra } as never)
  }
  // One company tanker with stock, for the industrial supplies.
  const tanker = (await api.tankers.create({ vehicleId: null, capacityLitres: null, notes: "", name: "FW", regNo: "KA00FW0001" })).id
  await api.tankerLoads.create({ tankerId: tanker, date: "2026-09-01", stationId: station, litres: 5000, rate: 90, invoiceNo: "", notes: "" })
  const supply = (customerId: string, date: string, litres: number, rate: number) =>
    api.industrialSupplies.create({ customerId, date, litres, rate, purpose: "Generator operation", remarks: "", allocations: [{ tankerId: tanker, litres }] })
  await api.adbluePurchases.create({ date: "2026-11-01", vendorName: "FW AdBlue", product: "AdBlue", buckets: 10, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })

  const D = await customer("FW Diesel"), P = await customer("FW Petrol"), M = await customer("FW Mixed"), E = await customer("FW EV")
  const X = await customer("FW DPE"), I = await customer("FW Industrial"), ALL = await customer("FW All"), Z = await customer("FW Zero")
  const dD = await vehicle(D, "DIESEL"), pP = await vehicle(P, "PETROL"), mD = await vehicle(M, "DIESEL"), mP = await vehicle(M, "PETROL"), eE = await vehicle(E, "EV")
  const xD = await vehicle(X, "DIESEL"), xP = await vehicle(X, "PETROL"), xE = await vehicle(X, "EV")
  const aD = await vehicle(ALL, "DIESEL"), aP = await vehicle(ALL, "PETROL"), aE = await vehicle(ALL, "EV")
  await fill(dD, D, "2026-11-02", 100, 92.5)
  await fill(dD, D, "2026-11-05", 50.55, 92.75)
  await fill(pP, P, "2026-11-03", 30, 102.1)
  await fill(mD, M, "2026-11-03", 80, 92)
  await fill(mP, M, "2026-11-04", 20, 101.99)
  await fill(eE, E, "2026-11-04", 45.5, 18.5) // kWh × ₹/kWh
  await fill(xD, X, "2026-11-02", 60, 93)
  await fill(xP, X, "2026-11-02", 25, 103)
  await fill(xE, X, "2026-11-02", 30, 19)
  await fill(aD, ALL, "2026-11-06", 120, 91.5)
  await fill(aP, ALL, "2026-11-06", 15, 104)
  await fill(aE, ALL, "2026-11-06", 22.25, 20)
  await supply(I, "2026-11-03", 200, 95.25)
  await supply(ALL, "2026-11-04", 150.5, 94)
  await adblue(dD, "2026-11-05", 12, { source: "STOCK" }) // a stock draw: at the weighted-average cost
  await adblue(aD, "2026-11-06", 10, { source: "STOCK" })
  await adblue(aD, "2026-11-07", 8, { source: "DIRECT", vendorName: "FW Vendor", rate: 60, paymentMode: "CASH" }) // a direct purchase: its own amount

  const dataset = async () => ({ customers: await api.customers.list(), vehicles: await api.vehicles.list(), drivers: await api.drivers.list(), diesel: await api.diesel.list(), trips: await api.trips.list(), assignments: await api.assignments.list() })
  type Data = Awaited<ReturnType<typeof dataset>> & { supplies: Awaited<ReturnType<typeof api.industrialSupplies.list>>; adblue: ReturnType<typeof withRuns> }
  const load = async (): Promise<Data> => ({ ...(await dataset()), supplies: await api.industrialSupplies.list(), adblue: withRuns(await api.adblue.list()) })
  /** The customer Overview's figures for a month, as the page builds them. */
  const summary = (data: Data, customerId: string | null, month: string) => {
    const ix = buildDieselIndex(data as never)
    const g = groupMonth(ix, customerId, month, undefined, month === "2026-11")
    const fuels = fuelWise(ix, g.entries, g.vehicles.map((v) => v.vehicle.fuelType))
    const s = industrialTotals(data.supplies.filter((x) => x.customerId === customerId && x.date.startsWith(month)))
    const ab = adBlueStats(data.adblue.filter((x) => x.customerId === customerId && x.date.startsWith(month)))
    const industrial = customerId ? { spend: s.value, litres: s.litres, entries: s.count } : undefined
    const adb = { spend: ab.spend, litres: ab.litres, entries: ab.entries }
    return { ix, g, fuels, industrial, adblue: adb, total: totalExpenditure(fuels, industrial, adb), litres: fuelLitres(fuels, industrial) }
  }
  const types = (s: ReturnType<typeof summary>) => s.fuels.map((f) => f.fuelType)
  const spendOf = (s: ReturnType<typeof summary>, t: string) => s.fuels.find((f) => f.fuelType === t)?.spend
  const amounts = (data: Data, customerId: string, month: string) => round2(data.diesel.filter((e) => e.customerId === customerId && e.date.startsWith(month)).reduce((t, e) => t + e.amount, 0))
  let data = await load()
  const nov = (id: string | null) => summary(data, id, "2026-11")

  /* ---------------------------------------------------------------- 1–9. the kinds of customer */
  assert.deepEqual([types(nov(D)), spendOf(nov(D), "DIESEL")], [["DIESEL"], round2(100 * 92.5 + round2(50.55 * 92.75))], "1. Diesel only: one Diesel figure = its fills")
  assert.deepEqual([types(nov(P)), spendOf(nov(P), "PETROL"), nov(P).litres], [["PETROL"], 3063, 30], "2. Petrol only: no Diesel card")
  assert.deepEqual([types(nov(M)), spendOf(nov(M), "DIESEL"), spendOf(nov(M), "PETROL")], [["DIESEL", "PETROL"], 7360, 2039.8], "3. Diesel + Petrol: both, each its own")
  assert.deepEqual([types(nov(E)), nov(E).fuels[0].qty, spendOf(nov(E), "EV"), nov(E).litres], [["EV"], 45.5, 841.75, 0], "4. EV only: kWh, never litres; fuel litres 0")
  assert.deepEqual(types(nov(X)), ["DIESEL", "PETROL", "EV"], "5. Diesel + Petrol + EV")
  assert.equal(nov(X).litres, 85, "…fuel litres = 60 + 25 (the 30 kWh kept apart)")
  assert.deepEqual([types(nov(I)), nov(I).industrial?.spend, nov(I).total], [[], 19050, 19050], "6. industrial supplies only: no vehicle fuel card; total = the supply")
  const dAb = data.adblue.find((x) => x.vehicleId === dD)!
  assert.ok(dAb.amount > 0 && nov(D).adblue.spend === dAb.amount, "7. AdBlue: the draw at its cost, under the customer")
  assert.equal(nov(D).total, round2(spendOf(nov(D), "DIESEL")! + dAb.amount), "…Total = Diesel + AdBlue (never inside Diesel)")
  const all = nov(ALL)
  const allAb = data.adblue.filter((x) => x.customerId === ALL)
  assert.deepEqual(types(all), ["DIESEL", "PETROL", "EV"])
  assert.equal(allAb.reduce((t, x) => t + x.amount, 0) > 480, true, "8. the direct purchase (8 × ₹60) and the draw")
  assert.equal(all.total, round2(amounts(data, ALL, "2026-11") + round2(150.5 * 94) + round2(allAb.reduce((t, x) => t + x.amount, 0))), "8. every category: Total = fills + supply + AdBlue, each once")
  assert.equal(all.litres, Number((120 + 15 + 150.5).toFixed(3)), "…fuel litres: Diesel + Petrol + Industrial (no AdBlue, no kWh)")
  assert.deepEqual([types(nov(Z)), nov(Z).total, nov(Z).litres], [[], 0, 0], "9. nothing: no fuel card, ₹0.00")
  assert.equal(totalExpenditure(all.fuels, null, all.adblue), null, "industrial not loaded: no total")
  assert.equal(totalExpenditure(all.fuels, all.industrial, null), null, "AdBlue not loaded: no total")
  assert.equal(totalExpenditure(all.fuels, undefined, all.adblue), round2(amounts(data, ALL, "2026-11") + all.adblue.spend), "no customer record (Unallocated): no industrial category")
  // Vehicle pages: each vehicle's own fuel; its fills = its customer's figure for that fuel.
  for (const [vid, cid, t] of [[aD, ALL, "DIESEL"], [aP, ALL, "PETROL"], [aE, ALL, "EV"]] as const) {
    const vm = vehicleMonth(all.ix, cid, vid, "2026-11")!
    assert.equal(vm.spend, spendOf(all, t), `vehicle ${t}: its spend = the customer's ${t} figure (one vehicle each)`)
    assert.equal(fillFuel(all.ix, { vehicleId: vid }), t)
  }
  assert.equal(vehicleMonth(all.ix, ALL, aE, "2026-11")!.kwh, 22.25, "EV vehicle: kWh")
  assert.equal(vehicleMonth(all.ix, ALL, aE, "2026-11")!.litres, 0, "…and no litres")

  /* ---------------------------------------------------------------- 11–12. reassignment A → B */
  const A = D, B = P
  const moved = await vehicle(A, "DIESEL", "2026-09-01")
  await fill(moved, A, "2026-10-10", 40, 90)
  data = await load()
  const aOctBefore = summary(data, A, "2026-10")
  await api.vehicles.transfer(moved, B, "2026-10-16", "Started working for B on 16 Oct")
  await fill(moved, B, "2026-10-20", 70, 91)
  data = await load()
  const oct = (id: string) => summary(data, id, "2026-10")
  assert.deepEqual(oct(A).g.entries.filter((e) => e.vehicleId === moved).map((e) => e.date), ["2026-10-10"], "10 Oct fill: Customer A")
  assert.deepEqual(oct(B).g.entries.filter((e) => e.vehicleId === moved).map((e) => e.date), ["2026-10-20"], "20 Oct fill: Customer B")
  assert.deepEqual(oct(A).fuels, aOctBefore.fuels, "A's October figures unchanged by the transfer")
  assert.equal(spendOf(oct(B), "DIESEL"), 6370, "B: only the fill after the effective date")

  /* ---------------------------------------------------------------- 13. month boundaries and periods */
  const edge = await vehicle(D, "DIESEL")
  await fill(edge, D, "2026-10-31", 10, 90) // back-dated (the Owner may change October)
  await fill(edge, D, "2026-11-01", 11, 90)
  data = await load()
  assert.deepEqual(summary(data, D, "2026-10").g.entries.filter((e) => e.vehicleId === edge).map((e) => e.date), ["2026-10-31"], "31 Oct: October")
  assert.deepEqual(nov(D).g.entries.filter((e) => e.vehicleId === edge).map((e) => e.date), ["2026-11-01"], "1 Nov: November")
  const months = ["2026-09", "2026-10", "2026-11", "2026-12"]
  const byMonth = months.map((m) => summary(data, D, m).fuels.reduce((t, f) => t + f.spend, 0))
  const allTime = round2(data.diesel.filter((e) => e.customerId === D).reduce((t, e) => t + e.amount, 0))
  assert.equal(round2(byMonth[1] + byMonth[2] + byMonth[3]), allTime, "Q4 (Oct–Dec) = Σ its months = all time for this customer: each fill once")

  /* ---------------------------------------------------------------- 14. delete and restore */
  const extra = await fill(xD, X, "2026-11-08", 33, 95)
  data = await load()
  const withExtra = nov(X).total!
  await api.diesel.remove(extra.id, "Entered twice")
  data = await load()
  assert.equal(nov(X).total, round2(withExtra - extra.amount), "deleted: out of Diesel and the total")
  const deletion = (await api.audit.list()).find((e) => e.recordId === extra.id && e.action === "DELETED")!
  await api.audit.restoreDeleted(deletion.id, "Deleted by mistake")
  data = await load()
  assert.equal(nov(X).total, withExtra, "restored: back once")

  /* ---------------------------------------------------------------- 15. Tata Adblue, one granted customer */
  const scoped = (await profileCall("TATA_ADBLUE", "diesel.list", async () => api.diesel.list(), new Set([M]))!()) as Data["diesel"]
  const scopedSupplies = (await profileCall("TATA_ADBLUE", "industrialSupplies.list", async () => api.industrialSupplies.list(), new Set([M]))!()) as Data["supplies"]
  assert.ok(scoped.length > 0 && scoped.every((e) => e.customerId === M), "only the granted customer's fills")
  assert.deepEqual(scopedSupplies, [], "…and supplies (none for this customer)")
  const asTata = async <T,>(method: string, call: () => Promise<T>) => (await profileCall("TATA_ADBLUE", method, call, new Set([M]))!()) as T
  const tata = {
    ...data,
    customers: await asTata("customers.list", () => api.customers.list()),
    vehicles: await asTata("vehicles.list", () => api.vehicles.list()),
    assignments: await asTata("assignments.list", () => api.assignments.list()),
    diesel: scoped,
    supplies: scopedSupplies,
    adblue: data.adblue.filter((x) => x.customerId === M),
  }
  assert.deepEqual(tata.customers.map((c) => c.id), [M], "Tata Adblue's customer list: the granted one")
  assert.deepEqual(summary(tata, M, "2026-11").fuels, nov(M).fuels, "the granted customer: the same figures as the Owner's")
  assert.deepEqual([summary(tata, ALL, "2026-11").fuels.length, summary(tata, ALL, "2026-11").total], [0, 0], "another customer: nothing reaches Tata Adblue")

  /* ---------------------------------------------------------------- 16. reconciliation */
  for (const month of ["2026-10", "2026-11"]) {
    const ix = buildDieselIndex(data as never)
    const groups = ix.groups.map((g) => g.id)
    const sums = new Map<string, number>()
    let totals = 0, fills = 0
    for (const id of groups) {
      const s = summary(data, id, month)
      for (const f of s.fuels) sums.set(f.fuelType, round2((sums.get(f.fuelType) ?? 0) + f.spend))
      fills += s.fuels.reduce((t, f) => t + f.fills, 0)
      totals += s.total!
    }
    const monthFills = data.diesel.filter((e) => e.date.startsWith(month))
    const company = fuelWise(ix, monthFills)
    for (const f of company) assert.equal(sums.get(f.fuelType) ?? 0, f.spend, `${month} ${f.fuelType}: Σ customers = the company's fills`)
    assert.equal(fills, monthFills.length, `${month}: every fill in exactly one customer and one fuel`)
    const expected = round2(
      monthFills.reduce((t, e) => t + e.amount, 0) +
        data.supplies.filter((x) => x.date.startsWith(month) && groups.includes(x.customerId)).reduce((t, x) => t + x.amount, 0) +
        data.adblue.filter((x) => x.date.startsWith(month) && groups.includes(x.customerId)).reduce((t, x) => t + x.amount, 0)
    )
    assert.equal(round2(totals), expected, `${month}: Σ Total Expenditure = every fill + supply + AdBlue entry, each once`)
  }

  /* ---------------------------------------------------------------- 17. the main Diesel dashboard (/diesel) */
  /** The dashboard as the page builds it: customer cards (Total Expenditure each) and the fleet-wide figures. */
  const dashboard = (d: Data, month: string) => {
    const ix = buildDieselIndex(d as never)
    const base = customerCards(ix, month, "2026-11-10")
    const cards = withCustomerExpenditure(base.cards, { supplies: d.supplies, adblue: d.adblue }, base)
    return { ix, base, cards, fleet: fleetExpenditure({ idx: ix, fills: d.diesel, month, cards, supplies: d.supplies, adblue: d.adblue }) }
  }
  for (const month of ["2026-10", "2026-11"]) {
    const { ix, base, cards, fleet } = dashboard(data, month)
    const fills = data.diesel.filter((e) => e.date.startsWith(month))
    assert.deepEqual(fleet.fuels.map((f) => f.fuelType), ["DIESEL", "PETROL", "EV"].filter((t) => fills.some((e) => fillFuel(ix, e) === t) || cards.some((c) => c.vehicleIds.some((v) => ix.vehicles.get(v)?.fuelType === t))), `${month}: a card per fuel the fleet uses`)
    for (const f of fleet.fuels) assert.equal(f.spend, round2(fills.filter((e) => fillFuel(ix, e) === f.fuelType).reduce((t, e) => t + e.amount, 0)), `${month} ${f.fuelType}: the fleet's fills of that fuel`)
    assert.equal(fleet.industrial!.spend, round2(data.supplies.filter((x) => x.date.startsWith(month)).reduce((t, x) => t + x.amount, 0)), `${month}: Industrial = every supply once (not its allocations)`)
    assert.equal(fleet.adblue!.spend, round2(data.adblue.filter((x) => x.date.startsWith(month)).reduce((t, x) => t + x.amount, 0)), `${month}: AdBlue = every entry once`)
    assert.equal(fleet.total, round2(cards.reduce((t, c) => t + c.spend, 0)), `${month}: Total Expenditure = Σ the customer cards`)
    assert.equal(round2(fleet.fuels.reduce((t, f) => t + f.spend, 0)), round2(base.total), `${month}: Σ vehicle fuels = every fill (the cards' vehicle part)`)
    for (const c of cards) assert.equal(c.spend, summary(data, c.group.id, month).total, `${month} ${c.group.shortName}: card = the customer Overview's Total Expenditure`)
    // The comparison: the same categories over the same days (previous month, 1–10 while November is in progress).
    const prev = month === "2026-11" ? "2026-10" : "2026-09"
    const inCmp = (date: string) => date.startsWith(prev) && (month !== "2026-11" || Number(date.slice(8, 10)) <= 10)
    const sumIf = (xs: { date: string; amount: number }[]) => xs.filter((x) => inCmp(x.date)).reduce((t, x) => t + x.amount, 0)
    assert.equal(fleet.compare, round2(sumIf(data.diesel) + sumIf(data.supplies) + sumIf(data.adblue)), `${month}: comparison = fills + supplies + AdBlue of the same days`)
    const dieselOnly = statsOf(ix, fills.filter((e) => fillFuel(ix, e) === "DIESEL"))
    assert.deepEqual([fleet.fuels[0].km, fleet.fuels[0].costPerKm, fleet.fuels[0].kmpl], [dieselOnly.km, dieselOnly.costPerKm, dieselOnly.kmpl], `${month}: Diesel KM, cost per KM and KM/L from Diesel fills only`)
  }
  // A comparison inside the same days only: an AdBlue entry on 25 Oct is in October's full figure, not in "1–10 Oct".
  const late = withCustomerExpenditure([{ group: { id: "c" }, spend: 0, compareSpend: 0, prevMonthSpend: 0, changePct: null }], { supplies: [], adblue: [{ customerId: "c", date: "2026-10-25", amount: 50 }, { customerId: null, date: "2026-11-02", amount: 7 }] }, { month: "2026-11", prev: "2026-10", day: 10 })
  assert.deepEqual([late[0].compareSpend, late[0].prevMonthSpend, late[0].spend], [0, 50, 0])
  assert.equal(withCustomerExpenditure([{ group: { id: null }, spend: 1, compareSpend: 0, prevMonthSpend: 0, changePct: null }], { supplies: [], adblue: [{ customerId: null, date: "2026-11-02", amount: 7 }] }, { month: "2026-11", prev: "2026-10", day: 10 })[0].spend, 8, "AdBlue without a customer: the Unallocated card")
  assert.equal(fleetExpenditure({ idx: dashboard(data, "2026-11").ix, fills: data.diesel, month: "2026-11", cards: [], supplies: null, adblue: data.adblue }).total, null, "industrial not loaded: no Total Expenditure")
  // Tata Adblue (granted M): its dashboard holds M's figures only, and they add up the same way.
  const t = dashboard(tata, "2026-11")
  assert.deepEqual(t.cards.filter((c) => c.spend > 0).map((c) => c.group.id), [M], "Tata Adblue: only the granted customer's card has figures")
  assert.equal(t.fleet.total, round2(t.cards.reduce((x, c) => x + c.spend, 0)))
  assert.equal(t.fleet.total, nov(M).total, "…= that customer's Total Expenditure, nothing of anyone else's")

  /* ---------------------------------------------------------------- 18. Petrol as its own fuel category */
  const { inQuarter } = await import("@/domain/quarters")
  const { vehiclesByFuel } = await import("@/domain/expenditure")
  const { FUEL_THEME, fuelTheme } = await import("@/lib/fuel-theme")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { createElement } = await import("react")
  const { FuelBadge } = await import("@/components/shared/fuel-badge")
  const fuelOf = (fuels: { fuelType: string }[], t: string) => fuels.find((f) => f.fuelType === t) as (typeof all.fuels)[number] | undefined
  // A second Petrol fill for P's petrol vehicle: its KM Run, KM/L and cost per KM come from its own fills only.
  data = await load()
  const storedBefore = JSON.stringify(data.diesel.filter((e) => e.vehicleId !== pP).map((e) => [e.id, e.litres, e.amount, e.date]))
  const dieselBefore = fuelOf(dashboard(data, "2026-11").fleet.fuels, "DIESEL")!
  const p2 = await fill(pP, P, "2026-11-08", 25, 103) // 400 km after its 3 Nov fill
  data = await load()
  const board = dashboard(data, "2026-11")
  const petrol = fuelOf(board.fleet.fuels, "PETROL")!
  const petrolFills = data.diesel.filter((e) => e.date.startsWith("2026-11") && board.ix.vehicles.get(e.vehicleId)?.fuelType === "PETROL")
  assert.ok(board.fleet.fuels.some((f) => f.fuelType === "PETROL") && board.fleet.fuels.some((f) => f.fuelType === "DIESEL"), "1–2. Petrol and Diesel both on the main page")
  assert.equal(petrol.spend, round2(petrolFills.reduce((t, e) => t + e.amount, 0)), "4. Petrol expenditure = Petrol fills only")
  assert.equal(petrol.vehicles, new Set(petrolFills.map((e) => e.vehicleId)).size, "3. Petrol vehicle count: distinct Petrol vehicles")
  assert.equal(fuelOf(board.fleet.fuels, "DIESEL")!.vehicles, new Set(data.diesel.filter((e) => e.date.startsWith("2026-11") && board.ix.vehicles.get(e.vehicleId)?.fuelType === "DIESEL").map((e) => e.vehicleId)).size, "3. Diesel vehicle count apart")
  assert.deepEqual(fuelOf(board.fleet.fuels, "DIESEL"), dieselBefore, "5, 7. A Petrol fill changes no Diesel figure (spend, litres, KM, KM/L, cost per KM)")
  const pOnly = summary(data, P, "2026-11").fuels
  const pPetrol = fuelOf(pOnly, "PETROL")!
  assert.deepEqual([pPetrol.km, pPetrol.kmpl, pPetrol.fills], [400, round2(400 / 55), 2], "6. Petrol KM/L: 400 km ÷ 55 L of its own Petrol fills")
  assert.equal(pPetrol.avgRate, round2((3063 + 2575) / 55), "…average Petrol price per litre")
  const fleetFuels = vehiclesByFuel(board.cards.flatMap((c) => c.vehicleIds).map((id) => board.ix.vehicles.get(id)!))
  assert.ok(fleetFuels.PETROL >= 4 && fleetFuels.DIESEL > 0 && fleetFuels.EV >= 3, "the fleet's vehicles counted by fuel type")
  // 8–9. Customer level: M runs one Diesel and one Petrol vehicle — each fuel its own figures, nothing duplicated.
  const mFuels = summary(data, M, "2026-11").fuels
  assert.deepEqual(mFuels.map((f) => [f.fuelType, f.spend, f.qty, f.vehicles]), [["DIESEL", 7360, 80, 1], ["PETROL", 2039.8, 20, 1]], "customer: Diesel and Petrol apart")
  // 10. Periods: month, quarter, year, all time — per fuel, each the sum of its months.
  const petrolIn = (pred: (e: Data["diesel"][number]) => boolean) => fuelOf(fuelWise(board.ix, data.diesel.filter(pred)), "PETROL")?.spend ?? 0
  const byMonths = ["2026-10", "2026-11", "2026-12"].map((m) => petrolIn((e) => e.date.startsWith(m)))
  assert.equal(petrolIn(inQuarter("2026", 4) as never), round2(byMonths.reduce((t, x) => t + x, 0)), "Q4 Petrol = Σ its months")
  assert.equal(petrolIn((e) => e.date.startsWith("2026")), petrolIn(() => true), "2026 Petrol = all time (all Petrol fills are in 2026)")
  // 11. Editing and deleting a Petrol entry moves only Petrol figures.
  await api.diesel.update(p2.id, { date: p2.date, vendorId: p2.vendorId, litres: 30, rate: 103, odometerKm: p2.odometerKm, billNo: "", paymentMode: "CREDIT", tankerId: null } as never, "Litres corrected")
  data = await load()
  assert.equal(fuelOf(summary(data, P, "2026-11").fuels, "PETROL")!.spend, round2(3063 + 3090), "edited: Petrol expenditure follows")
  assert.deepEqual(fuelOf(dashboard(data, "2026-11").fleet.fuels, "DIESEL"), dieselBefore, "…Diesel unchanged")
  await api.diesel.remove(p2.id, "Test cleanup")
  data = await load()
  assert.deepEqual([fuelOf(summary(data, P, "2026-11").fuels, "PETROL")!.spend, fuelOf(summary(data, P, "2026-11").fuels, "PETROL")!.km], [3063, 0], "deleted: back to one fill, no KM")
  // 12. Historical entries unchanged: every other stored fill is exactly as before.
  assert.equal(JSON.stringify(data.diesel.filter((e) => e.vehicleId !== pP).map((e) => [e.id, e.litres, e.amount, e.date])), storedBefore, "no other fill touched")
  // 13. Labels and styling: one central mapping; Petrol never reads as Diesel.
  assert.deepEqual([FUEL_THEME.PETROL.label, FUEL_THEME.PETROL.entry, FUEL_THEME.EV.unit, fuelTheme(undefined).label], ["Petrol", "petrol entry", "kWh", "Diesel"])
  assert.ok(FUEL_THEME.PETROL.card !== FUEL_THEME.DIESEL.card && FUEL_THEME.PETROL.badge !== FUEL_THEME.DIESEL.badge, "Petrol has its own styling")
  const badge = renderToStaticMarkup(createElement(FuelBadge, { fuel: "PETROL", count: 3 }))
  assert.ok(badge.includes("Petrol") && badge.includes("emerald") && !badge.includes("Diesel"), "the Petrol badge: its label and colour")

  /* ---------------------------------------------------------------- 19. Vehicle Count: every active vehicle, any fuel */
  const { activeFleetCount } = await import("@/domain/expenditure")
  const fleetNow = async () => activeFleetCount(buildDieselIndex((await load()) as never).vehicles.values())
  const vehiclesNow = await api.vehicles.list()
  const expected = new Set(vehiclesNow.filter((v) => v.status === "ACTIVE").map((v) => v.id)).size
  assert.equal(await fleetNow(), expected, "every distinct ACTIVE vehicle")
  assert.ok(vehiclesNow.some((v) => v.status === "ACTIVE" && !data.diesel.some((e) => e.vehicleId === v.id)), "…including vehicles with no fill at all")
  assert.ok(["DIESEL", "PETROL", "EV"].every((t) => vehiclesNow.some((v) => v.status === "ACTIVE" && v.fuelType === t)), "…of every fuel type")
  const spare = await vehicle(Z, "PETROL") // a new active Petrol vehicle with no fill and no AdBlue
  assert.equal(await fleetNow(), expected + 1, "a new vehicle counts at once — no fill needed")
  await api.vehicles.archive(spare)
  assert.equal(await fleetNow(), expected, "archived: no longer counted")
  await api.vehicles.transfer(dD, M, "2026-11-10", "Moved to M")
  assert.equal(await fleetNow(), expected, "a reassignment (two assignment records) is still one vehicle")
  const one = vehiclesNow.find((v) => v.status === "ACTIVE")!
  assert.equal(activeFleetCount([one, one, { ...one }]), 1, "the same vehicle twice: once")
  assert.equal(activeFleetCount([{ id: "a", status: "ARCHIVED" }, { id: "b", status: "INACTIVE" }, { id: "c", status: "MAINTENANCE" }, { id: "d", status: "ACTIVE" }]), 1, "only Active counts")

  console.log("fuel-wise expenditure: Diesel / Petrol / EV / Industrial / AdBlue per customer and vehicle, only the fuel types present, Total Expenditure, reassignment, month boundaries, delete / restore, Tata Adblue scope, reconciliation: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
