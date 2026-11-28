/**
 * Operations → Drivers (owner, 27 Nov 2026):  npm run check:drivers
 * Real API on in-memory demo data (browser backend), clock fixed at 27 Nov 2026 IST.
 *   1. The driver master: details, validation, DL unique (case / spaces ignored), search by name / DL, audit.
 *   2. A vehicle's dated company: changed with an effective date (back-dated, never future, never before the last
 *      change); earlier dates keep their company; audited.
 *   3. Company deployment: from dated driver periods × vehicle company — reassignment, a vehicle moving company, a change
 *      of vehicle within one company (one deployment), two companies at once (flagged), Unassigned, default driver.
 *   4. Permissions: Owner / Employee / Dev add and edit drivers; the AdBlue profiles can't.
 */
import assert from "node:assert/strict"
import { setRole, loadCheckDemoData } from "./test-browser"

const FIXED = new Date("2026-11-27T04:30:00.000Z").getTime()
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
  loadCheckDemoData()
  const { api } = await import("./index")
  const { readCollection, readAuditEvents } = await import("@/lib/storage/local-store")
  const { companyOn, currentDeployment, driverDeployments, driverMatches, driverVehicleHistory } = await import("@/domain/drivers")
  setRole("DEV")
  const drivers = () => readCollection("drivers")
  const vehicles = () => readCollection("vehicles")
  const today = "2026-11-27"

  /* 1. the driver master */
  const blank = { phone: "", licenseNo: "", licenseValidTill: "", companyCode: null, status: "ACTIVE" as const }
  await assert.rejects(api.drivers.create({ ...blank, name: "   " }), /driver's name/)
  await assert.rejects(api.drivers.create({ ...blank, name: "X", dateOfBirth: "2030-01-01" }), /can't be in the future/)
  await assert.rejects(api.drivers.create({ ...blank, name: "X", dateOfBirth: "1990-02-30" }), /valid date of birth/)
  await assert.rejects(api.drivers.create({ ...blank, name: "X", phone: "call me" }), /valid phone/)
  const ravi = await api.drivers.create({ ...blank, name: "  Ravi   Kumar ", fatherName: " Shankar ", dateOfBirth: "1988-06-15", address: " 12, Hosur Road ", licenseNo: " ka01 2020  0001234 ", licenseValidTill: "2030-06-14", phone: "98765 43210" })
  assert.deepEqual(
    [ravi.name, ravi.fatherName, ravi.dateOfBirth, ravi.address, ravi.licenseNo, ravi.licenseValidTill, ravi.phone, ravi.companyCode],
    ["Ravi Kumar", "Shankar", "1988-06-15", "12, Hosur Road", "KA01 2020 0001234", "2030-06-14", "98765 43210", null],
    "stored tidied; no company typed on a new driver"
  )
  await assert.rejects(api.drivers.create({ ...blank, name: "Another Ravi", licenseNo: "KA01 2020 0001234" }), /already recorded for Ravi Kumar/, "one DL number, one driver")
  const ravi2 = await api.drivers.create({ ...blank, name: "Ravi Kumar", licenseNo: "TN70 2019 0000009" })
  assert.notEqual(ravi2.id, ravi.id, "the same name is a different driver — never merged by name")
  const edited = await api.drivers.update(ravi.id, { phone: "99999 11111", address: "New address" })
  assert.deepEqual([edited.id, edited.name, edited.phone], [ravi.id, "Ravi Kumar", "99999 11111"], "an edit keeps the id")
  await assert.rejects(api.drivers.update(ravi2.id, { licenseNo: "ka012020 0001234".replace("012020", "01 2020") }), /already recorded/)
  assert.ok(driverMatches(ravi, "ravi") && driverMatches(ravi, "ka0120200001234") && driverMatches(ravi, "KA01-2020") && !driverMatches(ravi2, "ka01"), "search by name or DL, case / spaces / dashes ignored")
  const ev = (readAuditEvents() as { action: string; recordId: string; module: string }[]).filter((e) => e.recordId === ravi.id).map((e) => e.action)
  assert.deepEqual(ev, ["CREATED", "UPDATED"], "audited")

  /* 2. a vehicle's dated company */
  const [vA, vB, vC, vD] = vehicles().filter((v) => v.status === "ACTIVE" && !(v.companyPeriods ?? []).length)
  const co = vA.companyCode
  const other = co === "VT" ? "VTHPL" : "VT"
  await assert.rejects(api.vehicles.changeCompany(vA.id, other, "2026-12-01"), /future/)
  const movedA = await api.vehicles.changeCompany(vA.id, other, "2026-10-01")
  assert.equal(movedA.companyCode, other, "the current company follows the change")
  assert.deepEqual(movedA.companyPeriods!.map((p) => [p.companyCode, p.endDate]), [[co, "2026-09-30"], [other, null]], "the earlier company kept until the day before")
  assert.deepEqual([companyOn(movedA, "2026-04-01"), companyOn(movedA, "2026-09-30"), companyOn(movedA, "2026-10-01"), companyOn(movedA, today)], [co, co, other, other])
  await assert.rejects(api.vehicles.changeCompany(vA.id, co, "2026-09-15"), /can't take effect before that/, "history is appended, never rewritten")
  await assert.rejects(api.vehicles.changeCompany(vA.id, other, "2026-11-01"), /already with/, "no change to the company it already has")
  assert.equal(vehicles().find((v) => v.id === vA.id)!.companyCode, other, "a refused change leaves the company as it was")
  const vEvent = (readAuditEvents() as { action: string; recordId: string; after?: { companyPeriods?: unknown[] } }[]).filter((e) => e.recordId === vA.id).at(-1)
  assert.equal(vEvent?.after?.companyPeriods?.length, 2, "audited with the history")
  // The vehicle form path (update with a new company) is the same change, effective today.
  const viaForm = await api.vehicles.update(vD.id, { companyCode: vD.companyCode === "VT" ? "VTHPL" : "VT" })
  assert.deepEqual(viaForm.companyPeriods!.map((p) => p.endDate), ["2026-11-26", null], "a plain edit of the company is dated today")
  // A caller can't write the history itself.
  const forged = await api.vehicles.update(vB.id, { notes: "x", companyPeriods: [{ id: "x", companyCode: other, startDate: "2020-01-01", endDate: null }] })
  assert.equal(forged.companyPeriods?.length ?? 0, 0, "companyPeriods from the caller are ignored")

  /* 3. company deployment */
  // Ravi on vA from 1 Apr: vA moved company on 1 Oct → two deployments, split at that date.
  await api.vehicles.addDriver(vA.id, ravi.id, "2026-04-01")
  assert.deepEqual(driverDeployments(ravi.id, vehicles(), today).map((d) => [d.companyCode, d.startDate, d.endDate]), [[co, "2026-04-01", "2026-09-30"], [other, "2026-10-01", null]])
  // Reassigned: last day on vA 31 Oct, on vB (company `co`) from 1 Nov.
  await api.vehicles.removeDriver(vA.id, ravi.id, "2026-10-31")
  await api.vehicles.addDriver(vB.id, ravi.id, "2026-11-01")
  const vBco = companyOn(vehicles().find((v) => v.id === vB.id)!, today)
  const dep = driverDeployments(ravi.id, vehicles(), today)
  assert.deepEqual(dep.map((d) => [d.companyCode, d.startDate, d.endDate]), [[co, "2026-04-01", "2026-09-30"], [other, "2026-10-01", "2026-10-31"], [vBco, "2026-11-01", null]].reduce<[string, string, string | null][]>((out, d) => {
    // consecutive spans of one company are one deployment (if vB is the same company as vA had in October)
    const last = out.at(-1)
    if (last && last[0] === d[0]) last[2] = d[2] as string | null
    else out.push(d as [string, string, string | null])
    return out
  }, []), "no overlap, previous deployments kept")
  assert.ok(dep.every((d) => !d.overlaps))
  assert.deepEqual(driverVehicleHistory(ravi.id, vehicles()).map((h) => [h.vehicle.id, h.startDate, h.endDate]), [[vB.id, "2026-11-01", null], [vA.id, "2026-04-01", "2026-10-31"]], "vehicle history kept, newest first")
  const now = currentDeployment(ravi.id, vehicles(), today)
  assert.deepEqual([now.companies, now.vehicles.map((v) => v.id)], [[vBco], [vB.id]], "current company from the current vehicle")
  // A change of vehicle within one company is one deployment.
  const sam = await api.drivers.create({ ...blank, name: "Sam Same Company" })
  const sameCo = vehicles().filter((v) => v.status === "ACTIVE" && !(v.companyPeriods ?? []).length && v.companyCode === vBco && v.id !== vB.id).slice(0, 2)
  await api.vehicles.addDriver(sameCo[0].id, sam.id, "2026-05-01")
  await api.vehicles.removeDriver(sameCo[0].id, sam.id, "2026-06-30")
  await api.vehicles.addDriver(sameCo[1].id, sam.id, "2026-07-01")
  assert.deepEqual(driverDeployments(sam.id, vehicles(), today).map((d) => [d.companyCode, d.startDate, d.endDate, d.vehicles.length]), [[vBco, "2026-05-01", null, 2]], "one deployment across both vehicles")
  // Two companies at once: kept and flagged.
  const twin = await api.drivers.create({ ...blank, name: "Two Companies" })
  await api.vehicles.addDriver(vA.id, twin.id, "2026-11-01") // vA is `other` now
  await api.vehicles.addDriver(vC.id, twin.id, "2026-11-10")
  const vCco = companyOn(vehicles().find((v) => v.id === vC.id)!, today)
  if (vCco !== other) {
    const t = driverDeployments(twin.id, vehicles(), today)
    assert.ok(t.length === 2 && t.every((d) => d.overlaps), "both flagged")
    assert.equal(currentDeployment(twin.id, vehicles(), today).label, [other, vCco].sort().join(" + "))
  }
  // Unassigned; the default driver of a vehicle with no dated period counts as current (no history dates).
  const idle = await api.drivers.create({ ...blank, name: "Idle Driver" })
  assert.equal(currentDeployment(idle.id, vehicles(), today).label, "Unassigned")
  await api.vehicles.update(vC.id, { defaultDriverId: idle.id })
  assert.deepEqual([currentDeployment(idle.id, vehicles(), today).vehicles.map((v) => v.id), driverDeployments(idle.id, vehicles(), today).length], [[vC.id], 0])
  // Archived drivers can't be assigned.
  await api.drivers.update(idle.id, { status: "ARCHIVED" })
  await assert.rejects(api.vehicles.addDriver(vB.id, idle.id, today), /archived/)
  assert.equal(drivers().filter((d) => d.id === idle.id).length, 1, "archived, never deleted")

  /* 4. permissions */
  for (const r of ["OWNER", "EMPLOYEE"] as const) {
    setRole(r)
    const d = await api.drivers.create({ ...blank, name: `By ${r}` })
    assert.equal((await api.drivers.update(d.id, { phone: "12345 67890" })).phone, "12345 67890", `${r} adds and edits drivers`)
  }
  for (const r of ["TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(r)
    await assert.rejects(api.drivers.create({ ...blank, name: "No" }), /can't|not allowed|permission/i, `${r} can't add drivers`)
  }
  setRole("EMPLOYEE")
  await assert.rejects(api.vehicles.changeCompany(vB.id, other, today).then(() => api.vehicles.changeCompany(vB.id, co, "2026-01-01")), /can't take effect before that/, "the Employee changes a vehicle's company as any vehicle edit — history still append-only")

  console.log("drivers: master, dated vehicle company, deployment history, permissions: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
