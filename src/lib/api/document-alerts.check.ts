/**
 * Vehicle document expiry alerts (owner, 22 Nov 2026):  npm run check:document-alerts
 * Real API on in-memory demo data, with a clock moved day by day in India time.
 *   1. Warning periods: Insurance 7, Road tax 5, PUC 30, Fitness 30 days before expiry, exactly; none the day before;
 *      the expiry day; every day after; Permit never (not confirmed); a date never entered never.
 *   2. IST midnight, month / year / financial-year ends and leap years.
 *   3. Calculated, never generated: repeated and skipped evaluations give the same single alert (no duplicates, nothing missed).
 *   4. Lifecycle through the API: viewing and unrelated edits resolve nothing; updating the date resolves the alert into
 *      history (old date, alert date, new date, time); a new date in its window raises a new alert; outside it none;
 *      changed back to the original date = a new cycle, history kept; date removed = Not recorded + resolved; the caller
 *      can't write or wipe history; one audited edit; Inactive / Archived vehicles raise none.
 *   5. Roles: the Owner, Dev and Employee resolve and read; the AdBlue profiles can't edit, and never receive history.
 */
import assert from "node:assert/strict"
import { setRole } from "./test-browser"

const RealDate = Date
let NOW = RealDate.parse("2026-12-13T04:30:00.000Z") // 10:00 IST
class MovableDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(NOW)
  }
  static now() {
    return NOW
  }
}
globalThis.Date = MovableDate as DateConstructor
/** Move the clock to 10:00 IST on `day`. */
const on = (day: string) => void (NOW = RealDate.parse(`${day}T04:30:00.000Z`))

async function main() {
  const { api } = await import("./index")
  const { todayISO } = await import("@/lib/format")
  const { readCollection, readAuditEvents } = await import("@/lib/storage/local-store")
  const { ALERT_LEAD_DAYS, activeDocumentAlerts, alertFor, expiryOf } = await import("@/domain/compliance")
  const { profileCall } = await import("@/lib/server/erp/profiles")
  const { can } = await import("@/lib/permissions")
  type V = import("@/lib/types").Vehicle

  /* 1. warning periods */
  assert.deepEqual(ALERT_LEAD_DAYS, { Insurance: 7, "Road tax": 5, PUC: 30, Fitness: 30, Permit: null })
  // The database stores history for exactly the documents that raise alerts (Permit: none until confirmed).
  const { readFileSync } = await import("node:fs")
  const migration = readFileSync(new URL("../../../supabase/migrations/20261122000000_vehicle_document_alerts.sql", import.meta.url), "utf8")
  const dbDocs = [...migration.match(/check \(document in \(([^)]*)\)\)/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(dbDocs, Object.entries(ALERT_LEAD_DAYS).filter(([, d]) => d !== null).map(([k]) => k).sort(), "migration documents = the app's alerting documents")
  // …and the lifecycle trigger on core.vehicles (vehicle_document_alert_lifecycle) uses the app's warning periods.
  const dbLead = Object.fromEntries([...migration.matchAll(/\('([^']+)', old\.\w+, new\.\w+, (\d+)\)/g)].map((m) => [m[1], Number(m[2])]))
  assert.deepEqual(dbLead, Object.fromEntries(Object.entries(ALERT_LEAD_DAYS).filter(([, d]) => d !== null)), "migration warning periods = ALERT_LEAD_DAYS")
  const at = (doc: Parameters<typeof alertFor>[0], expiry: string, today: string) => alertFor(doc, expiry, today)
  assert.equal(at("Insurance", "2026-12-20", "2026-12-12"), null, "Insurance: nothing 8 days before")
  assert.deepEqual(at("Insurance", "2026-12-20", "2026-12-13"), { alertDate: "2026-12-13", daysLeft: 7 }, "Insurance: begins exactly 7 days before")
  assert.deepEqual(at("Insurance", "2026-12-20", "2026-12-14"), { alertDate: "2026-12-13", daysLeft: 6 }, "…and stays")
  assert.deepEqual(at("Insurance", "2026-12-20", "2026-12-20"), { alertDate: "2026-12-13", daysLeft: 0 }, "expires today")
  assert.deepEqual(at("Insurance", "2026-12-20", "2026-12-21"), { alertDate: "2026-12-13", daysLeft: -1 }, "expired yesterday: still active")
  assert.deepEqual(at("Insurance", "2026-12-20", "2027-06-01"), { alertDate: "2026-12-13", daysLeft: -163 }, "months later: still active until the date is updated")
  assert.equal(at("Road tax", "2026-12-20", "2026-12-14"), null, "Road tax: nothing 6 days before")
  assert.deepEqual(at("Road tax", "2026-12-20", "2026-12-15"), { alertDate: "2026-12-15", daysLeft: 5 }, "Road tax: begins exactly 5 days before")
  for (const doc of ["PUC", "Fitness"] as const) {
    assert.equal(at(doc, "2026-12-20", "2026-11-19"), null, `${doc}: nothing 31 days before`)
    assert.deepEqual(at(doc, "2026-12-20", "2026-11-20"), { alertDate: "2026-11-20", daysLeft: 30 }, `${doc}: begins exactly 30 days before`)
    assert.deepEqual(at(doc, "2026-12-20", "2026-12-25"), { alertDate: "2026-11-20", daysLeft: -5 }, `${doc}: expired, still active`)
  }
  for (const today of ["2026-12-13", "2026-12-20", "2027-12-20"]) assert.equal(at("Permit", "2026-12-20", today), null, "Permit: no alert until its warning period is confirmed")
  assert.equal(at("Insurance", "", "2026-12-20"), null, "a date never entered: no alert")

  /* 2. IST and calendar edges */
  assert.deepEqual(at("Insurance", "2027-01-03", "2026-12-27"), { alertDate: "2026-12-27", daysLeft: 7 }, "across the year end")
  assert.deepEqual(at("Road tax", "2027-04-02", "2027-03-28"), { alertDate: "2027-03-28", daysLeft: 5 }, "across the financial-year end (31 Mar → 1 Apr)")
  assert.deepEqual(at("Road tax", "2027-04-02", "2027-03-31"), { alertDate: "2027-03-28", daysLeft: 2 })
  assert.deepEqual(at("Insurance", "2028-03-01", "2028-02-23"), { alertDate: "2028-02-23", daysLeft: 7 }, "leap year: 29 Feb 2028 counted")
  assert.equal(at("Insurance", "2028-03-01", "2028-02-22"), null)
  assert.deepEqual(at("PUC", "2028-03-01", "2028-01-31"), { alertDate: "2028-01-31", daysLeft: 30 }, "leap year, 30 days back across February")
  assert.deepEqual(at("Insurance", "2027-03-01", "2027-02-22"), { alertDate: "2027-02-22", daysLeft: 7 }, "non-leap February")
  assert.deepEqual(at("Fitness", "2026-03-31", "2026-03-01"), { alertDate: "2026-03-01", daysLeft: 30 }, "month of 31 days")
  NOW = RealDate.parse("2026-12-12T18:29:59.000Z") // 23:59:59 IST, 12 Dec
  assert.equal(todayISO(), "2026-12-12")
  assert.equal(at("Insurance", "2026-12-20", todayISO()), null, "23:59 IST the day before: none")
  NOW = RealDate.parse("2026-12-12T18:30:00.000Z") // 00:00 IST, 13 Dec (still 12 Dec in UTC)
  assert.equal(todayISO(), "2026-12-13")
  assert.equal(at("Insurance", "2026-12-20", todayISO())!.daysLeft, 7, "the alert begins at 00:00 IST, whatever the device's time zone")

  /* 4. lifecycle through the API */
  on("2026-12-13")
  setRole("OWNER")
  const tpl = readCollection("vehicles").find((x) => x.status === "ACTIVE")!
  const { id: _i, createdAt: _c, updatedAt: _u, statusHistory: _s, driverPeriods: _p, ...vb } = tpl
  void [_i, _c, _u, _s, _p]
  const create = (regNo: string, extra: Partial<V> = {}) =>
    api.vehicles.create({ ...vb, regNo, assignedCustomerId: null, defaultDriverId: null, openingOdometerKm: null, openingOdometerDate: null, insurance: { ...vb.insurance, validTill: "" }, roadTax: { ...vb.roadTax, validTill: "" }, fitnessValidTill: "", permitValidTill: "", pucValidTill: "", ...extra } as never)
  const v = await create("TN70DA0001", { insurance: { ...vb.insurance, validTill: "2026-12-20" } })
  const get = async () => (await api.vehicles.get(v.id))!
  const mine = async () => activeDocumentAlerts([await get()], todayISO())
  const brief = async () => (await mine()).map((a) => [a.document, a.expiryDate, a.alertDate, a.daysLeft])
  const history = async () => ((await get()).documentAlertHistory ?? []).map((r) => [r.document, r.expiryDate, r.alertDate, r.newExpiryDate])
  const ins = (validTill: string) => ({ insurance: { ...vb.insurance, validTill } })

  assert.deepEqual(await brief(), [["Insurance", "2026-12-20", "2026-12-13", 7]], "13 Dec: the alert is active")
  // 3. evaluated again and again — and on days nobody opened the ERP — it is the same single alert.
  const keys = new Set<string>()
  for (let i = 0; i < 50; i++) for (const a of activeDocumentAlerts(readCollection("vehicles"), todayISO())) keys.add(a.key)
  assert.equal([...keys].filter((k) => k.startsWith(v.id)).length, 1, "50 evaluations: one alert, one identity")
  on("2026-12-25") // 12 days later, never evaluated in between
  assert.deepEqual(await brief(), [["Insurance", "2026-12-20", "2026-12-13", -5]], "a missed fortnight: the same alert, 5 days overdue")
  on("2026-12-16")
  for (let i = 0; i < 3; i++) await api.vehicles.list() // viewing
  await api.vehicles.update(v.id, { notes: "checked the insurance papers" }) // an unrelated edit
  await api.vehicles.update(v.id, ins("2026-12-20")) // saving the same date
  assert.deepEqual([await history(), (await brief()).length], [[], 1], "viewing, unrelated edits and the same date resolve nothing")

  const n0 = readAuditEvents().length
  await api.vehicles.update(v.id, ins("2026-12-22")) // renewed to a date still inside its window
  assert.deepEqual(await history(), [["Insurance", "2026-12-20", "2026-12-13", "2026-12-22"]], "updating the date resolves the old alert, kept with its dates")
  assert.ok(/T.*Z$/.test((await get()).documentAlertHistory![0].resolvedAt), "…and when")
  assert.deepEqual(await brief(), [["Insurance", "2026-12-22", "2026-12-15", 6]], "the new date is inside its window: a new alert for it")
  const ev = readAuditEvents().slice(n0) as unknown as { action: string; recordId: string; changes: { field: string }[]; after: V }[]
  assert.deepEqual(ev.map((e) => [e.action, e.recordId, e.changes.map((c) => c.field)]), [["UPDATED", v.id, ["insurance"]]], "one audited edit; the change shown is the date")
  assert.equal(ev[0].after.documentAlertHistory!.length, 1, "the snapshot holds the history")

  await api.vehicles.update(v.id, ins("2027-12-20")) // renewed for a year
  assert.deepEqual([(await history()).length, await brief()], [2, []], "a date outside its window: resolved, no new alert")
  await api.vehicles.update(v.id, ins("2026-12-20")) // changed back to the original date
  assert.deepEqual(await brief(), [["Insurance", "2026-12-20", "2026-12-13", 4]], "changed back: a new cycle for the original date")
  assert.equal((await history()).length, 2, "the 2027 date never alerted, so nothing to resolve; history kept")
  await api.vehicles.update(v.id, ins("2026-12-23")) // exactly 7 days ahead: active
  assert.deepEqual((await history()).map((h) => h[1]), ["2026-12-20", "2026-12-22", "2026-12-20"], "the same expiry date resolved twice = two cycles, none lost or merged")
  await api.vehicles.update(v.id, ins(""))
  assert.deepEqual((await history()).at(-1), ["Insurance", "2026-12-23", "2026-12-16", null], "date removed: resolved, new date Not recorded")
  assert.deepEqual([await brief(), expiryOf((await get()).insurance.validTill, todayISO()).state], [[], "MISSING"], "…no alert; the document shows Not recorded")
  assert.equal(new Set((await get()).documentAlertHistory!.map((r) => r.id)).size, 4, "every record has its own id")

  // The caller never writes history.
  await api.vehicles.update(v.id, { documentAlertHistory: [] } as never)
  assert.equal((await history()).length, 4, "a patch can't wipe history")
  const forged = await create("TN70DA0002", { documentAlertHistory: [{ id: "vda_x", document: "PUC", regNo: "X", expiryDate: "2026-01-01", alertDate: "2025-12-02", newExpiryDate: null, resolvedAt: "2026-01-01T00:00:00.000Z" }] })
  assert.equal(forged.documentAlertHistory, undefined, "a new vehicle starts with no history, whatever is sent")

  // Several documents in one edit; Permit changes resolve nothing.
  await api.vehicles.update(v.id, { pucValidTill: "2027-01-10", fitnessValidTill: "2026-12-01", permitValidTill: "2026-12-01" })
  assert.deepEqual((await mine()).map((a) => a.document), ["Fitness", "PUC"], "PUC and Fitness active; the expired Permit raises none")
  await api.vehicles.update(v.id, { pucValidTill: "2027-06-10", fitnessValidTill: "2027-06-01", permitValidTill: "2027-06-01" })
  assert.deepEqual((await history()).slice(4).map((h) => h[0]).sort(), ["Fitness", "PUC"], "one record per document resolved by the same save; none for Permit")

  // Inactive / Archived vehicles raise none, and editing their dates records nothing.
  await api.vehicles.update(v.id, ins("2026-12-18"))
  assert.equal((await mine()).length, 1)
  await api.vehicles.archive(v.id)
  assert.equal((await mine()).length, 0, "an archived vehicle raises no alert")
  await api.vehicles.update(v.id, ins("2027-12-18"))
  assert.equal((await history()).length, 6, "…and editing it records nothing")
  await api.vehicles.restore(v.id)

  /* 5. roles */
  setRole("EMPLOYEE")
  await api.vehicles.update(v.id, ins("2026-12-19"))
  await api.vehicles.update(v.id, ins("2027-12-19"))
  assert.equal((await history()).length, 7, "the Employee resolves an alert by updating the date (vehicles:edit)")
  setRole("DEV")
  await api.vehicles.update(v.id, ins("2026-12-17"))
  await api.vehicles.update(v.id, ins("2027-12-17"))
  assert.equal((await history()).length, 8, "Dev too")
  for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) assert.ok(can(role, "vehicles", "view"), `${role} sees the alerts (vehicles:view)`)
  await api.vehicles.update(v.id, ins("2026-12-18"))
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    assert.ok(!can(role, "vehicles", "view"), `${role} has no vehicles:view`)
    setRole(role)
    await assert.rejects(api.vehicles.update(v.id, ins("2027-12-18")), /can't|permission/i, `${role} can't update a document date`)
    const shaped = (await profileCall(role, "vehicles.list", async () => readCollection("vehicles"), role === "ADBLUE" ? null : new Set(readCollection("customers").map((c) => c.id)))!()) as V[]
    assert.ok(shaped.length > 0 && shaped.every((x) => !("documentAlertHistory" in x)), `${role}: vehicles never carry alert history`)
    assert.equal(profileCall(role, "audit.list", async () => []), null, `${role}: no audit trail either`)
  }
  setRole("OWNER")
  assert.equal((await history()).length, 8, "refused edits record nothing")

  /* 6. Vehicles → Dues: every active alert, upcoming and overdue (owner, 22 Nov 2026) */
  {
    on("2026-12-16")
    setRole("OWNER")
    // Insurance 7 d, Road tax 5 d, PUC 30 d, Fitness 30 d ahead (each the first day of its window), plus overdue ones,
    // a PUC due today, a Permit long expired (no alert) and a vehicle with no dates at all.
    const d1 = await create("TN70DU0001", { insurance: { ...vb.insurance, validTill: "2026-12-23" }, roadTax: { ...vb.roadTax, validTill: "2026-12-21" }, pucValidTill: "2027-01-15", fitnessValidTill: "2027-01-15", permitValidTill: "2026-11-01" })
    const d2 = await create("TN70DU0002", { insurance: { ...vb.insurance, validTill: "2026-12-10" }, pucValidTill: "2026-12-16", fitnessValidTill: "2026-11-30" })
    const d3 = await create("TN70DU0003")
    const mineIds = new Set([d1.id, d2.id, d3.id])
    const dues = () => activeDocumentAlerts(readCollection("vehicles"), todayISO()).filter((a) => mineIds.has(a.vehicle.id))
    const rows = () => dues().map((a) => [a.vehicle.regNo, a.document, a.expiryDate, a.daysLeft, a.daysLeft < 0 ? "Overdue" : "Upcoming"])
    assert.deepEqual(rows(), [
      ["TN70DU0002", "Fitness", "2026-11-30", -16, "Overdue"],
      ["TN70DU0002", "Insurance", "2026-12-10", -6, "Overdue"],
      ["TN70DU0002", "PUC", "2026-12-16", 0, "Upcoming"],
      ["TN70DU0001", "Road tax", "2026-12-21", 5, "Upcoming"],
      ["TN70DU0001", "Insurance", "2026-12-23", 7, "Upcoming"],
      ["TN70DU0001", "Fitness", "2027-01-15", 30, "Upcoming"],
      ["TN70DU0001", "PUC", "2027-01-15", 30, "Upcoming"],
    ], "upcoming (each threshold) and overdue, one row per document, most urgent first; no Permit; no row for dates never entered")
    assert.equal(dues().length, 7, "the Dues badge counts documents, upcoming + overdue")
    for (let i = 0; i < 3; i++) await api.vehicles.list() // viewing changes nothing
    assert.equal(dues().length, 7)
    await api.vehicles.update(d2.id, { insurance: { ...vb.insurance, validTill: "2027-12-10" } })
    assert.equal(dues().length, 6, "an updated date resolves its alert: it leaves the list and the count")
    assert.deepEqual(((await api.vehicles.get(d2.id))!.documentAlertHistory ?? []).map((h) => [h.document, h.expiryDate, h.newExpiryDate]), [["Insurance", "2026-12-10", "2027-12-10"]], "…into the resolved history")
    on("2026-12-17") // the next IST day: the PUC due yesterday is now overdue
    assert.deepEqual(rows().find((r) => r[1] === "PUC" && r[0] === "TN70DU0002"), ["TN70DU0002", "PUC", "2026-12-16", -1, "Overdue"])
    setRole("EMPLOYEE") // vehicles:edit — updates dates like the Owner
    await api.vehicles.update(d1.id, { insurance: { ...vb.insurance, validTill: "2027-12-23" }, roadTax: { ...vb.roadTax, validTill: "2027-12-21" }, pucValidTill: "2027-12-15", fitnessValidTill: "2027-12-15" })
    await api.vehicles.update(d2.id, { pucValidTill: "2027-12-16", fitnessValidTill: "2027-11-30" })
    setRole("OWNER")
    assert.deepEqual(dues(), [], "all updated: nothing due")
    // The vehicle page no longer shows expiry alerts or the expiry summary (they live in Vehicles → Dues).
    const { readFileSync } = await import("node:fs")
    const detail = readFileSync(new URL("../../features/vehicles/vehicle-detail.tsx", import.meta.url), "utf8")
    assert.ok(!/complianceSummary|expiryOf|activeDocumentAlerts|DocumentAlertsCard/.test(detail), "Vehicle Detail: no document expiry alerts")
  }

  console.log("vehicle document expiry alerts: warning periods, IST and calendar edges, no duplicates, lifecycle, history and roles: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
