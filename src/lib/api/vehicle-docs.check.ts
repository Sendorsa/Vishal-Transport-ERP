/**
 * Vehicle PUC and drivers' DL numbers (owner, 21 Nov 2026):  npm run check:vehicle-docs
 * Real API on in-memory demo data, clock fixed at 21 Nov 2026 IST.
 *   1. Expiry: not recorded / expired / expiring (≤ 30 days) / valid — PUC like every other document; dashboard alerts
 *      include PUC and skip dates never entered.
 *   2. Drivers, dated: none, several, the default always listed first; add (today or back-dated) / remove (last day) audited
 *      on the vehicle and kept as history (who drove it on a date); same-day undo; overlaps, future dates, unknown or
 *      archived drivers refused with nothing saved; removing the default clears it.
 *   3. DL numbers live on the driver: cleaned, one per driver, editable by the Employee, refused to the AdBlue profiles.
 *   4. Tyres tab: the vehicle's own tyre invoice lines from the Tyre module (filteredLines by vehicleId) — none, several,
 *      a replacement chain (tyre fitted / removed), never another vehicle's, edits and deletes reflected; the tab is shown
 *      exactly to the roles with Tyre access.
 *   5. Header cards: KM Run and mileage for the current FY from the vehicle's own fills (the Diesel module's statsOf) —
 *      FY boundary, missing odometers, other vehicles' fills, no data, Diesel / Petrol / EV kept apart; Documents summary
 *      (all valid, expiring, expired, not recorded — never "All valid" with a date missing).
 *   6. Tyre form's odometer reference (currentOdometer): the vehicle's own odometer and the date of the fill holding it;
 *      none recorded; a value only on the vehicle record; the go-live opening; raised by a fuel entry; per vehicle;
 *      a tyre invoice's KM and the vehicle's odometer untouched by saving one.
 */
import assert from "node:assert/strict"
import { setRole } from "./test-browser"

const FIXED = new Date("2026-11-21T04:30:00.000Z").getTime()
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
  const { todayISO } = await import("@/lib/format")
  const { readCollection, readAuditEvents } = await import("@/lib/storage/local-store")
  const { driverIdsOn, expiryOf, pastDriverPeriods, vehicleDrivers, withDriverAdded, withDriverRemoved } = await import("@/domain/compliance")
  const { activeDocumentAlerts } = await import("@/domain/compliance")
  const complianceAlerts = (ds: { vehicles: never[] }, t: string) => activeDocumentAlerts(ds.vehicles, t)
  const today = todayISO()
  assert.equal(today, "2026-11-21")
  const events = () => readAuditEvents() as unknown as { action: string; recordId: string; changes: { field: string }[] }[]

  /* 1. expiry */
  assert.deepEqual(expiryOf("", today), { state: "MISSING", days: null })
  assert.deepEqual(expiryOf(undefined, today), { state: "MISSING", days: null })
  assert.deepEqual(expiryOf("2026-11-20", today), { state: "EXPIRED", days: -1 })
  assert.deepEqual(expiryOf("2026-11-21", today), { state: "EXPIRING", days: 0 })
  assert.deepEqual(expiryOf("2026-12-21", today), { state: "EXPIRING", days: 30 })
  assert.deepEqual(expiryOf("2026-12-22", today), { state: "VALID", days: 31 })

  setRole("OWNER")
  const v0 = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.defaultDriverId)!
  assert.equal(v0.pucValidTill, undefined, "older vehicles have no PUC recorded")
  const ds = () => ({ vehicles: readCollection("vehicles").filter((v) => v.id === v0.id) }) as never
  assert.ok(!complianceAlerts(ds(), today).some((a) => a.document === "PUC"), "a PUC date never entered is not an alert")
  await api.vehicles.update(v0.id, { pucValidTill: "2026-11-25" })
  assert.equal((await api.vehicles.get(v0.id))!.pucValidTill, "2026-11-25", "PUC saved")
  assert.deepEqual(complianceAlerts(ds(), today).filter((a) => a.document === "PUC").map((a) => a.daysLeft), [4], "an expiring PUC is on the dashboard alerts")
  await api.vehicles.update(v0.id, { pucValidTill: "2026-10-01" })
  assert.equal(complianceAlerts(ds(), today).find((a) => a.document === "PUC")!.daysLeft, -51, "…and an expired one")

  /* 2. drivers, dated */
  const drivers = () => readCollection("drivers")
  const def = v0.defaultDriverId!
  const [a, b] = drivers().filter((d) => d.id !== def && d.status === "ACTIVE" && d.companyCode === v0.companyCode)
  assert.deepEqual(vehicleDrivers({ ...v0, defaultDriverId: null, driverPeriods: [] }, drivers()), [], "a vehicle with no drivers lists none")
  assert.deepEqual(vehicleDrivers(v0, drivers()).map((x) => [x.driver.id, x.isDefault, x.since]), [[def, true, null]], "an older vehicle lists its default driver, no dates (no backfill)")

  const n0 = events().length
  await api.vehicles.addDriver(v0.id, a.id, "2026-10-01") // back-dated (go-live)
  const ev = events().at(-1)!
  assert.deepEqual([events().length - n0, ev.action, ev.recordId, ev.changes.map((c) => c.field)], [1, "UPDATED", v0.id, ["driverPeriods"]], "one UPDATED event on the vehicle")
  await api.vehicles.addDriver(v0.id, b.id, today)
  await api.vehicles.addDriver(v0.id, def, "2026-09-15") // the default driver gets dates too
  let v = (await api.vehicles.get(v0.id))!
  const listed = vehicleDrivers(v, drivers())
  assert.deepEqual(listed.map((x) => [x.driver.id, x.since]), [[def, "2026-09-15"], ...[[a.id, "2026-10-01"], [b.id, today]].sort((x, y) => drivers().find((d) => d.id === x[0])!.name.localeCompare(drivers().find((d) => d.id === y[0])!.name))], "several drivers: the default first, then by name, each with its start")

  const n1 = events().length
  await assert.rejects(api.vehicles.addDriver(v0.id, a.id, today), /already drives this vehicle/)
  await assert.rejects(api.vehicles.addDriver(v0.id, "drv_nope", today), /Driver drv_nope not found/)
  const other = drivers().find((d) => ![a.id, b.id, def].includes(d.id) && d.companyCode === v0.companyCode)!
  await assert.rejects(api.vehicles.addDriver(v0.id, other.id, "2026-11-22"), /can't be in the future/)
  await api.drivers.archive(other.id)
  const n2 = events().length
  await assert.rejects(api.vehicles.addDriver(v0.id, other.id, today), /archived — restore the driver first/)
  assert.equal(n2, n1 + 1, "refused calls save nothing and record no event (only the archive did)")
  assert.equal(events().length, n2)

  // Removing: a's period closes on their last day and stays as history.
  await assert.rejects(api.vehicles.removeDriver(v0.id, a.id, "2026-09-30"), /before the driver started/)
  await assert.rejects(api.vehicles.removeDriver(v0.id, a.id, "2026-11-22"), /future/)
  await api.vehicles.removeDriver(v0.id, a.id, "2026-11-10")
  v = (await api.vehicles.get(v0.id))!
  assert.deepEqual(pastDriverPeriods(v).map((p) => [p.driverId, p.startDate, p.endDate]), [[a.id, "2026-10-01", "2026-11-10"]], "history kept")
  assert.deepEqual([driverIdsOn(v, "2026-10-20").sort(), driverIdsOn(v, "2026-11-15").sort()], [[a.id, def].sort(), [def].sort()], "who drove it on a date")
  await assert.rejects(api.vehicles.addDriver(v0.id, a.id, "2026-11-05"), /drove this vehicle until 10-11-2026/, "a new period never overlaps the old one")
  await api.vehicles.addDriver(v0.id, a.id, "2026-11-18")
  v = (await api.vehicles.get(v0.id))!
  assert.equal(v.driverPeriods!.filter((p) => p.driverId === a.id).length, 2, "re-assigned later: a second period")

  // Same-day undo: b was added today — removing deletes the period; a removal today then re-added today reopens it.
  await api.vehicles.removeDriver(v0.id, b.id, today)
  v = (await api.vehicles.get(v0.id))!
  assert.ok(!v.driverPeriods!.some((p) => p.driverId === b.id), "an add undone the same day leaves no history")
  await api.vehicles.removeDriver(v0.id, a.id, today)
  await api.vehicles.addDriver(v0.id, a.id, today)
  v = (await api.vehicles.get(v0.id))!
  assert.deepEqual(v.driverPeriods!.filter((p) => p.driverId === a.id).map((p) => [p.startDate, p.endDate]), [["2026-10-01", "2026-11-10"], ["2026-11-18", null]], "a removal undone the same day reopens the period")

  // The default driver: removing clears the default; their period closes.
  await api.vehicles.removeDriver(v0.id, def, today)
  v = (await api.vehicles.get(v0.id))!
  assert.deepEqual([v.defaultDriverId, v.driverPeriods!.find((p) => p.driverId === def)!.endDate], [null, today], "removing the default driver clears the default and closes their period")
  assert.ok(drivers().some((d) => d.id === def), "the driver record itself is untouched")
  await assert.rejects(api.vehicles.removeDriver(v0.id, def, today), /isn't on this vehicle now/)

  // Pure rules directly (the database applies the same periods).
  assert.throws(() => withDriverAdded([], "d", "2026-13-01x", today, () => "x"), /Enter the date/)
  assert.throws(() => withDriverRemoved([], "d", today, today), /isn't on this vehicle now/)

  /* 3. DL numbers on the driver */
  const ra = await api.drivers.update(a.id, { licenseNo: "  tn70   2011 0001234 " })
  assert.equal(ra.licenseNo, "TN70 2011 0001234", "DL cleaned: trimmed, single spaces, upper case")
  await assert.rejects(api.drivers.update(b.id, { licenseNo: "tn70 2011 0001234" }), /already recorded for/, "one DL number, one driver")
  await assert.rejects(api.drivers.update(b.id, { licenseNo: "X".repeat(31) }), /at most 30/)
  const rb = await api.drivers.update(b.id, { licenseNo: "" })
  assert.equal(rb.licenseNo, "", "a DL number can be left blank (not recorded)")
  const created = await api.drivers.create({ name: "New Driver", phone: "", licenseNo: " ka05 1 ", licenseValidTill: "", companyCode: v0.companyCode, status: "ACTIVE" })
  assert.equal(created.licenseNo, "KA05 1")

  setRole("EMPLOYEE")
  await api.drivers.update(b.id, { licenseNo: "KA05 20190004321" })
  await api.vehicles.addDriver(v0.id, b.id, "2026-11-01")
  await api.vehicles.removeDriver(v0.id, b.id, "2026-11-20")
  assert.deepEqual(pastDriverPeriods((await api.vehicles.get(v0.id))!).filter((p) => p.driverId === b.id).map((p) => p.endDate), ["2026-11-20"], "the Employee adds and removes drivers (vehicles:edit)")

  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(role)
    await assert.rejects(api.vehicles.addDriver(v0.id, b.id, today), /can't|permission/i, `${role} can't add a vehicle's drivers`)
    await assert.rejects(api.vehicles.removeDriver(v0.id, a.id, today), /can't|permission/i, `${role} can't remove them`)
    await assert.rejects(api.drivers.update(a.id, { licenseNo: "" }), /can't change drivers/, `${role} can't change DL numbers`)
  }
  /* 4. Tyres tab (the Tyre module's own records, filtered by vehicle) */
  setRole("OWNER")
  const { filteredLines, NO_FILTERS, tyreTotals } = await import("@/domain/tyre")
  const { can } = await import("@/lib/permissions")
  const open = readCollection("vehicle_assignments").filter((x) => x.endDate === null && x.customerId && x.startDate <= "2026-11-01")
  const vehicleIds = [...new Set(open.map((x) => x.vehicleId))].filter((id) => readCollection("vehicles").find((x) => x.id === id)?.status === "ACTIVE")
  const [tA, tB, tC] = vehicleIds
  const masters = await api.tyreMasters.list()
  const rt = (n: string) => masters.find((m) => m.kind === "REPAIR_TYPE" && m.name === n)!.id
  const sup = await api.tyreMasters.create({ kind: "SUPPLIER", name: "Vehicle Tab Tyres" })
  const line = (repairTypeId: string, x: Record<string, unknown> = {}) => ({ repairTypeId, quantity: 1, rate: 1000, gstRate: 18, taxType: "CGST_SGST" as const, ...x })
  const inv = (vehicleId: string, date: string, items: ReturnType<typeof line>[]) => ({ date, vehicleId, supplierId: sup.id, billNo: "", items }) as never
  const views = async () => (await api.tyreInvoices.list()).map((x) => ({ ...x, totals: tyreTotals(x.items), regNo: "", vehicleType: "", vehicleTypeCode: "", company: "", supplier: "" }))
  const tabOf = async (vehicleId: string, search = "") => filteredLines(await views(), { ...NO_FILTERS, vehicleId, search })
  assert.deepEqual(await tabOf(tC), [], "a vehicle with no tyre records shows none")
  const first = await api.tyreInvoices.create(inv(tA, "2026-11-05", [line(rt("New Tyre Purchased"), { tyreNumber: "T-100", removingNumber: "T-050", openingKm: 1000, closingKm: 1000 }), line(rt("Tyre Fitting"))]))
  await api.tyreInvoices.create(inv(tA, "2026-11-15", [line(rt("New Tyre Purchased"), { tyreNumber: "T-200", removingNumber: "T-100" })]))
  await api.tyreInvoices.create(inv(tB, "2026-11-10", [line(rt("Wheel Alignment"), { tyreNumber: "T-900" })]))
  const linesA = await tabOf(tA)
  assert.deepEqual([linesA.length, new Set(linesA.map((r) => r.invoice.vehicleId))], [3, new Set([tA])], "several invoices, every line, only this vehicle's")
  assert.ok(!(await tabOf(tA, "T-900")).length, "another vehicle's tyre never appears, even by search")
  assert.deepEqual((await tabOf(tA, "T-100")).map((r) => [r.item.tyreNumber, r.item.removingNumber]).sort(), [["T-100", "T-050"], ["T-200", "T-100"]], "replacement history: T-100 fitted, later removed when T-200 went on")
  assert.equal(tyreTotals(linesA.map((r) => r.item)).grandTotal, 3540, "spend = Σ the vehicle's lines incl. GST (3 × ₹1,180)")
  await api.tyreInvoices.update(first.id, inv(tA, "2026-11-05", [line(rt("New Tyre Purchased"), { tyreNumber: "T-101", removingNumber: "T-050" })]), "Tyre number corrected")
  assert.deepEqual((await tabOf(tA)).map((r) => r.item.tyreNumber).sort(), ["T-101", "T-200"], "an edit in the Tyre module shows here (the fitting line removed, the number corrected)")
  await api.tyreInvoices.remove(first.id, "Entered twice")
  assert.deepEqual((await tabOf(tA)).map((r) => r.item.tyreNumber), ["T-200"], "…and a delete")
  for (const [role, sees] of [["OWNER", true], ["DEV", true], ["EMPLOYEE", true], ["TATA_ADBLUE", false], ["ADBLUE", false]] as const)
    assert.equal(can(role, "tyres", "view"), sees, `${role}: Tyres tab ${sees ? "shown" : "hidden"} (the Tyre module's own permission)`)

  /* 5. header cards */
  const { vehicleFyFuel } = await import("@/domain/vehicle-summary")
  const { complianceSummary } = await import("@/domain/compliance")
  const base = readCollection("vehicles")[0]
  const veh = (id: string, fuelType: "DIESEL" | "PETROL" | "EV") => ({ ...base, id, fuelType, openingOdometerKm: null, openingOdometerDate: null })
  let n = 0
  const fill = (vehicleId: string, date: string, odometerKm: number | null, litres: number) =>
    ({ id: `f_${++n}`, vehicleId, date, odometerKm, litres, rate: 90, amount: litres * 90, customerId: null, vendorId: "x", companyCode: "VT", billNo: "", paymentMode: "CREDIT", notes: "", createdAt: "", updatedAt: "" }) as never
  const dsl = veh("veh_d", "DIESEL")
  const fills = [
    fill("veh_d", "2026-03-25", 1000, 80), // last FY: its litres and km are last FY's
    fill("veh_d", "2026-04-10", 1500, 100), // its gap (1000 → 1500) closes in this FY (the Diesel module's convention)
    fill("veh_d", "2026-05-01", 2000, 100),
    fill("veh_other", "2026-05-02", 99999, 500), // another vehicle: never counted
  ]
  let r = vehicleFyFuel(dsl, fills, today)
  assert.deepEqual([r.fyLabel, r.km, r.fills, r.mileage, r.unit, r.lastReading && (r.lastReading as { odometerKm: number }).odometerKm], ["FY 2026–27", 1000, 2, 5, "km/L", 2000], "FY KM Run 1,000 km over 200 L = 5.00 km/L; last reading 2,000 km")
  assert.deepEqual([r.quantity, r.incomplete], [200, { noEarlier: { fills: 0, quantity: 0 }, uncovered: { fills: 0, quantity: 0 }, repeated: { fills: 0, quantity: 0 }, lower: { fills: 0, quantity: 0 } }], "every FY fill has a usable gap: measured (the April fill's gap from the March fill counts)")
  r = vehicleFyFuel(dsl, [...fills, fill("veh_d", "2026-05-10", null, 50)], today)
  assert.deepEqual([r.km, r.mileage], [1000, 4], "a fill without an odometer adds litres but no km (the Diesel module's statsOf: 1,000 ÷ 250)")
  assert.deepEqual([r.incomplete.uncovered, r.covered.fills], [{ fills: 1, quantity: 50 }, 0], "…the latest fill has no reading and nothing measures past it yet: flagged")
  r = vehicleFyFuel(dsl, [...fills, fill("veh_d", "2026-06-01", 1800, 40)], today)
  assert.equal(r.km, 1000, "a lower reading (data error) counts 0 km, never negative")
  assert.deepEqual(r.incomplete.lower, { fills: 1, quantity: 40 }, "…and is flagged as a lower reading")
  r = vehicleFyFuel(dsl, [fill("veh_d", "2026-03-25", 1000, 80)], today)
  assert.deepEqual([r.km, r.fills, r.mileage], [0, 0, null], "no fills this FY: 0 km, not enough data for mileage")
  r = vehicleFyFuel(dsl, [fill("veh_d", "2026-06-01", 5000, 60)], today)
  assert.deepEqual([r.km, r.mileage, r.incomplete.noEarlier], [0, null, { fills: 1, quantity: 60 }], "a single first-ever fill: no KM Run, not enough data, flagged as first on record")
  r = vehicleFyFuel(dsl, [fill("veh_d", "2026-06-01", 5000, 60), fill("veh_d", "2026-06-20", 5450, 90)], today)
  assert.deepEqual([r.km, r.mileage, r.incomplete.noEarlier.fills], [450, 3, 1], "first fill's 60 L counted without KM: 450 ÷ 150 = 3.00, flagged incomplete (never presented as measured)")

  // The five warning cases (formula unchanged: KM Run ÷ every fill's litres).
  const quality = (list: ReturnType<typeof fill>[]) => {
    const q = vehicleFyFuel(dsl, list, today)
    return { km: q.km, mileage: q.mileage, covered: q.covered.fills, ...(Object.fromEntries(Object.entries(q.incomplete).map(([k, x]) => [k, x.fills])) as Record<keyof typeof q.incomplete, number>) }
  }
  const prior = fill("veh_d", "2026-03-20", 9500, 90) // an earlier reading (last FY), so the FY's first fill has a gap
  // 1. Missing odometer between two valid readings — the example: 10,000 → (no reading, 80 L) → 10,500.
  assert.deepEqual(quality([fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-10", null, 80), fill("veh_d", "2026-06-20", 10500, 100)]),
    { km: 500, mileage: 1.79, covered: 1, noEarlier: 1, uncovered: 0, repeated: 0, lower: 0 },
    "1. the middle fill is covered by the 10,500 reading (not flagged); only the first-ever fill is (500 ÷ 280 L)")
  assert.deepEqual(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-10", null, 80), fill("veh_d", "2026-06-20", 10500, 100)]),
    { km: 1000, mileage: 3.57, covered: 1, noEarlier: 0, uncovered: 0, repeated: 0, lower: 0 },
    "1b. with an earlier reading nothing is flagged: measured (1,000 ÷ 280 L)")
  // 2. First-ever fill without a previous reading (and a no-reading fill before any reading).
  assert.deepEqual(quality([fill("veh_d", "2026-05-01", null, 40), fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-20", 10500, 100)]),
    { km: 500, mileage: 2.08, covered: 0, noEarlier: 2, uncovered: 0, repeated: 0, lower: 0 }, "2. fuel before the first reading is unresolved")
  // 3. Missing odometer on the latest fill.
  assert.deepEqual(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-20", null, 60)]),
    { km: 500, mileage: 3.13, covered: 0, noEarlier: 0, uncovered: 1, repeated: 0, lower: 0 }, "3. nothing measures past the latest fill yet")
  // 4. Repeated and lower readings.
  assert.deepEqual(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-05", 10000, 20), fill("veh_d", "2026-06-20", 10500, 100)]),
    { km: 1000, mileage: 4.55, covered: 0, noEarlier: 0, uncovered: 0, repeated: 1, lower: 0 }, "4a. a repeated reading: 0 km for its fuel, flagged")
  assert.deepEqual(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-05", 9000, 50), fill("veh_d", "2026-06-20", 10500, 100)]),
    { km: 2000, mileage: 8, covered: 0, noEarlier: 0, uncovered: 0, repeated: 0, lower: 1 }, "4b. a lower reading: flagged; the next gap is inflated (9,000 → 10,500), so the figure can read high")
  assert.equal(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-05", null, 50), fill("veh_d", "2026-06-20", 9800, 100)]).uncovered, 1, "4c. a no-reading fill before a lower reading isn't covered by it")
  // 5. Several consecutive fills without readings: covered between readings, unresolved at the end.
  assert.deepEqual(quality([prior, fill("veh_d", "2026-06-01", 10000, 100), fill("veh_d", "2026-06-05", null, 30), fill("veh_d", "2026-06-08", null, 30), fill("veh_d", "2026-06-20", 10600, 100), fill("veh_d", "2026-07-01", null, 20), fill("veh_d", "2026-07-05", null, 20)]),
    { km: 1100, mileage: 3.67, covered: 2, noEarlier: 0, uncovered: 2, repeated: 0, lower: 0 }, "5. two covered by the 10,600 reading, the two trailing ones flagged")
  r = vehicleFyFuel(veh("veh_p", "PETROL"), [fill("veh_p", "2026-06-01", 100, 10), fill("veh_p", "2026-06-15", 550, 30)], today)
  assert.deepEqual([r.km, r.mileage, r.unit], [450, 11.25, "km/L"], "Petrol: km/L from its own fills (450 ÷ 40 L)")
  r = vehicleFyFuel(veh("veh_e", "EV"), [fill("veh_e", "2026-06-01", 100, 10), fill("veh_e", "2026-06-10", 400, 20)], today)
  assert.deepEqual([r.km, r.mileage, r.unit], [300, 10, "km/kWh"], "EV: km/kWh from its charges (300 ÷ 30 kWh), never km/L")

  const docsOf = (x: Partial<{ ins: string; tax: string; fit: string; permit: string; puc: string }>) =>
    complianceSummary({ ...base, insurance: { ...base.insurance, validTill: x.ins ?? "" }, roadTax: { ...base.roadTax, validTill: x.tax ?? "" }, fitnessValidTill: x.fit ?? "", permitValidTill: x.permit ?? "", pucValidTill: x.puc ?? "" }, today)
  const allSet = { ins: "2027-05-01", tax: "2027-03-31", fit: "2027-08-01", permit: "2028-01-01", puc: "2027-02-01" }
  let c = docsOf(allSet)
  assert.deepEqual([c.state, c.next!.document, c.missing], ["VALID", "PUC", []], "all valid: next expiry is PUC on 01-02-2027")
  c = docsOf({ ...allSet, puc: "" })
  assert.deepEqual([c.state, c.next!.document, c.missing], ["MISSING", "Road tax", ["PUC"]], "PUC not recorded: never All valid")
  c = docsOf({ ...allSet, tax: "2026-12-01" })
  assert.deepEqual([c.state, c.next!.document, c.next!.days], ["EXPIRING", "Road tax", 10], "road tax expiring in 10 days")
  c = docsOf({ ...allSet, ins: "2026-11-01", tax: "2026-12-01", puc: "" })
  assert.deepEqual([c.state, c.next!.document, c.expired, c.expiring, c.missing], ["EXPIRED", "Insurance", 1, 1, ["PUC"]], "expired first, the rest counted, PUC listed as not recorded")
  c = docsOf({ ...allSet, fit: "2026-11-20" })
  assert.deepEqual([c.state, c.next!.document, c.next!.days], ["EXPIRED", "Fitness", -1], "Fitness counts: expired yesterday")
  c = docsOf({ ...allSet, permit: "" })
  assert.deepEqual([c.state, c.missing], ["MISSING", ["Permit"]], "a missing Permit date: never All valid")
  assert.deepEqual(docsOf(allSet).state, "VALID", "All valid only with all five recorded and valid")
  c = docsOf({})
  assert.deepEqual([c.state, c.next, c.missing.length], ["MISSING", null, 5], "nothing recorded")

  /* 6. tyre form: current vehicle odometer (reference only) */
  {
    setRole("OWNER")
    const { currentOdometer } = await import("@/domain/vehicle-summary")
    const tpl = readCollection("vehicles").find((x) => x.fuelType === "DIESEL" && x.status === "ACTIVE")!
    const { id: _i, createdAt: _c, updatedAt: _u, statusHistory: _s, driverPeriods: _p, ...vb } = tpl
    void [_i, _c, _u, _s, _p]
    const cust = (await api.customers.list()).find((x) => x.status === "ACTIVE")!.id
    const mk = (regNo: string, odometerKm: number) => api.vehicles.create({ ...vb, regNo, assignedCustomerId: cust, assignedSince: "2026-11-01", odometerKm, defaultDriverId: null, openingOdometerKm: null, openingOdometerDate: null } as never)
    const [o1, o2] = [await mk("TN70OD0001", 0), await mk("TN70OD0002", 5000)]
    const now = async (id: string) => currentOdometer(readCollection("vehicles").find((x) => x.id === id)!, readCollection("diesel_entries"))
    assert.equal(await now(o1.id), null, "no reading recorded → \"No odometer reading recorded\"")
    assert.deepEqual(await now(o2.id), { km: 5000, date: null }, "a value entered only on the vehicle record: shown, no date")
    const station = (await api.fuelStations.list()).find((x) => !x.isTanker && x.status === "ACTIVE")!.id
    const fuel = (vehicleId: string, date: string, odometerKm: number) => api.diesel.create({ date, vehicleId, customerId: cust, vendorId: station, litres: 40, rate: 90, odometerKm, billNo: "", paymentMode: "CREDIT" })
    await fuel(o1.id, "2026-11-10", 5400)
    assert.deepEqual(await now(o1.id), { km: 5400, date: "2026-11-10" }, "a fuel entry raises the vehicle's odometer; dated by that fill")
    await fuel(o1.id, "2026-11-18", 5900)
    assert.deepEqual(await now(o1.id), { km: 5900, date: "2026-11-18" }, "…the latest fill's reading and date")
    assert.deepEqual(await now(o2.id), { km: 5000, date: null }, "switching vehicles: each shows its own reading, never another's")
    await api.vehicles.setOpeningOdometer(o2.id, { km: 6000, date: "2026-10-31" })
    assert.deepEqual(await now(o2.id), { km: 6000, date: "2026-10-31" }, "the go-live opening odometer, with its date")
    const masters = await api.tyreMasters.list()
    const sup = masters.find((m) => m.kind === "SUPPLIER" && m.status === "ACTIVE")!
    const fit = masters.find((m) => m.kind === "REPAIR_TYPE" && m.name === "Tyre Fitting")!
    const t = await api.tyreInvoices.create({ date: "2026-11-19", vehicleId: o1.id, supplierId: sup.id, billNo: "", items: [{ repairTypeId: fit.id, quantity: 1, rate: 100, gstRate: 18, taxType: "CGST_SGST", openingKm: 1200, closingKm: 4800 }] } as never)
    assert.deepEqual([t.items[0].openingKm, t.items[0].closingKm], [1200, 4800], "a tyre line keeps the KM typed — the reference never fills or changes them")
    assert.deepEqual(await now(o1.id), { km: 5900, date: "2026-11-18" }, "saving a tyre invoice never changes the vehicle's odometer")
  }

  console.log("vehicle PUC, driver DL numbers, the Tyres tab, the header cards and the tyre odometer reference: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
