/**
 * Runnable check for dated assignment changes — Edit Assignment (correcting a start date) and back-dated transfers:
 * npm run check:assignments.
 * Real API on in-memory demo data (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST
 * (September and October are closed for the Employee).
 *
 *   1. Six vehicles entered "since 07-11-2026" are corrected to 01-11-2026: same assignment, customer, end, status.
 *   2–4. Invalid dates, a start after the end date, overlapping another assignment — refused with the reason.
 *   5, 6, 10. One UPDATED event (before / after start date, reason, actor) written with the change, or neither.
 *   7. Diesel / AdBlue entries and trips never move to another customer; stored records never change.
 *   8, 9. UI Preview Mode blocks the call; the Monthly Sheet Lock applies to every month whose days change.
 *   T1–T14. Transfers: today (no reason) or back-dated (reason required); the previous assignment ends the day before,
 *   the new one starts on the effective date, atomically; diesel / AdBlue / trips keep their customer (a transfer that
 *   would move one is refused, naming it); correcting a saved transfer date moves both sides; audit, rollback, locks.
 */
import assert from "node:assert/strict"
import { failure, setRole } from "./test-browser"

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
  const { todayISO } = await import("@/lib/format")
  const { readCollection, writeCollection, AUDIT_KEY } = await import("@/lib/storage/local-store")
  const { isReadMethod } = await import("./reads")
  const { startDateProblem } = await import("@/domain/assignments")
  assert.equal(todayISO(), "2026-11-10")
  setRole("OWNER")

  /* ---------------------------------------------------------------- set-up */
  const customers = (await api.customers.list()).filter((c) => c.status === "ACTIVE")
  const [A, B] = customers
  const template = (await api.vehicles.list()).find((v) => v.fuelType === "DIESEL" && v.status === "ACTIVE")!
  const { id: _i, createdAt: _c, updatedAt: _u, statusHistory: _s, ...base } = template
  void [_i, _c, _u, _s]
  let n = 0
  const vehicle = async (customerId: string, since: string) => api.vehicles.create({ ...base, regNo: `TN70ZZ${String(++n).padStart(4, "0")}`, assignedCustomerId: customerId, assignedSince: since, odometerKm: 1000, defaultDriverId: null })
  const assignmentOf = (vehicleId: string, customerId = A.id) => readCollection("vehicle_assignments").filter((a) => a.vehicleId === vehicleId && a.customerId === customerId).at(-1)!
  const correct = (id: string, startDate: string, reason = "Correction of incorrectly entered assignment start date") => api.assignments.correctStartDate(id, { startDate, reason })
  const fill = (vehicleId: string, customerId: string, date: string, odometerKm: number) => ({ date, vehicleId, customerId, vendorId: "dv_vishal", litres: 50, rate: 95, odometerKm, billNo: "", paymentMode: "CREDIT" as const })
  const assignmentCount = () => readCollection("vehicle_assignments").length
  const log = async () => (await api.audit.list()).length

  /* ---------------------------------------------------------------- 1. the six vehicles: 07-11-2026 → 01-11-2026 */
  const six = await Promise.all([1, 2, 3, 4, 5, 6].map(() => vehicle(A.id, "2026-11-07")))
  await api.diesel.create(fill(six[0].id, A.id, "2026-11-08", 1500)) // a fill already recorded under the assignment
  const others = readCollection("vehicle_assignments").filter((a) => !six.some((v) => v.id === a.vehicleId))
  const dieselBefore = readCollection("diesel_entries")
  const reportedBefore = await api.diesel.list()
  const tripsBefore = readCollection("trips")
  const invoicesBefore = readCollection("invoices")
  const paymentsBefore = readCollection("payments")
  const count = assignmentCount()
  for (const v of six) {
    const before = assignmentOf(v.id)
    const after = await correct(before.id, "2026-11-01")
    assert.deepEqual([after.id, after.vehicleId, after.customerId, after.startDate, after.endDate, after.status], [before.id, v.id, A.id, "2026-11-01", null, "ACTIVE"])
    assert.equal((await api.vehicles.get(v.id))!.assignedCustomerId, A.id) // the vehicle record is untouched
  }
  assert.equal(assignmentCount(), count) // no duplicate, nothing deleted
  assert.deepEqual(readCollection("vehicle_assignments").filter((a) => !six.some((v) => v.id === a.vehicleId)), others) // other vehicles untouched
  assert.deepEqual(readCollection("diesel_entries"), dieselBefore) // no stored entry rewritten…
  assert.deepEqual(await api.diesel.list(), reportedBefore) // …and none reported under another customer
  assert.deepEqual([readCollection("trips"), readCollection("invoices"), readCollection("payments")], [tripsBefore, invoicesBefore, paymentsBefore])
  // From now on 01–06 Nov belong to the assignment: an entry there under another customer is refused, as for any date it covers.
  await assert.rejects(api.diesel.create(fill(six[1].id, B.id, "2026-11-03", 1200)), /is assigned to .* on 2026-11-03/)
  await api.diesel.create(fill(six[1].id, A.id, "2026-11-03", 1200))

  /* ---------------------------------------------------------------- 5. the audit event */
  const ev = (await api.audit.list()).find((e) => e.recordId === six[0].id && e.action === "UPDATED" && e.recordType === "Vehicle assignment")!
  assert.ok(ev, "one UPDATED event per correction, on the vehicle")
  assert.deepEqual([ev.module, ev.actor.role, ev.reason, ev.recordDate], ["Vehicles", "OWNER", "Correction of incorrectly entered assignment start date", "2026-11-01"])
  assert.deepEqual(ev.changes.map((c) => [c.field, c.before, c.after]), [["startDate", "2026-11-07", "2026-11-01"]])
  assert.match(ev.label, new RegExp(`^${six[0].regNo} · .+ · assignment start 07-11-2026 → 01-11-2026$`))
  assert.equal((ev.before as { id: string }).id, (ev.after as { id: string }).id) // the same assignment id

  /* ---------------------------------------------------------------- 2. invalid dates and reasons */
  const one = assignmentOf(six[2].id)
  const c2 = await log()
  for (const bad of ["", "   ", "abc", "2026-02-30", "2026-13-01", "01-11-2026"]) await assert.rejects(correct(one.id, bad), /Enter the new start date/)
  await assert.rejects(correct(one.id, "2026-11-01"), /already starts on 01-11-2026/)
  await assert.rejects(correct(one.id, "2026-11-11"), /can't be in the future/)
  await assert.rejects(correct(one.id, "2026-11-02", ""), /Enter the reason for correcting this record/)
  await assert.rejects(correct(one.id, "2026-11-02", "  "), /Enter the reason/)
  await assert.rejects(correct(one.id, "2026-11-02", "ab"), /at least 3 characters/)
  await assert.rejects(correct("vas_missing", "2026-11-02"), /not found/i)
  assert.equal(await log(), c2) // refused: nothing audited
  assert.equal(assignmentOf(six[2].id).startDate, "2026-11-01")

  /* ---------------------------------------------------------------- 3 & 4. after the end date; overlap */
  const moved = await vehicle(A.id, "2026-10-01")
  await api.vehicles.transfer(moved.id, B.id, "2026-10-20", "Moved to B")
  const withA = assignmentOf(moved.id, A.id)
  const withB = assignmentOf(moved.id, B.id)
  assert.deepEqual([withA.startDate, withA.endDate, withB.startDate, withB.endDate], ["2026-10-01", "2026-10-19", "2026-10-20", null])
  await assert.rejects(correct(withA.id, "2026-10-25"), /can't be after the assignment's end date \(19-10-2026\)/)
  // Correcting a transfer date moves the previous assignment's end with it (more in T10); never before its start.
  await assert.rejects(correct(withB.id, "2026-10-01"), new RegExp(`was assigned to ${A.shortName} from 01-10-2026 until this assignment began\\. The start date must be after 01-10-2026`))
  await correct(withB.id, "2026-10-15")
  assert.deepEqual([assignmentOf(moved.id, A.id).endDate, assignmentOf(moved.id, B.id).startDate], ["2026-10-14", "2026-10-15"])
  await correct(withB.id, "2026-10-20")
  // A real overlap (a gap before the assignment, so nothing is handed over) is refused in the pure function.
  const gap = [
    { id: "g1", vehicleId: "v", customerId: "A", startDate: "2026-10-01", endDate: "2026-10-10", status: "ENDED" as const },
    { id: "g2", vehicleId: "v", customerId: "B", startDate: "2026-10-15", endDate: null, status: "ACTIVE" as const },
  ]
  assert.equal(startDateProblem(gap, "g2", "2026-10-05", { entries: [], trips: [] }, "2026-11-10")?.kind, "OVERLAP")
  assert.equal(startDateProblem(gap, "g2", "2026-10-12", { entries: [], trips: [] }, "2026-11-10"), null) // inside the gap
  await correct(withA.id, "2026-09-28") // the first assignment may start earlier: nothing before it
  await correct(withA.id, "2026-10-01") // and back

  /* ---------------------------------------------------------------- 7. entries and trips never move silently */
  const v7 = await vehicle(A.id, "2026-11-07")
  await api.diesel.create(fill(v7.id, A.id, "2026-11-08", 1500))
  // 04-11, before any assignment covered it, a fill was recorded under customer B (allowed then).
  const early = await api.diesel.create(fill(v7.id, B.id, "2026-11-04", 1200))
  const c7 = { log: await log(), diesel: readCollection("diesel_entries") }
  await assert.rejects(correct(assignmentOf(v7.id).id, "2026-11-01"), new RegExp(`has a diesel entry on 04-11-2026 \\(50 L\\) reported under ${B.shortName}\\. This start date would move it to ${A.shortName}`))
  assert.deepEqual([await log(), readCollection("diesel_entries")], [c7.log, c7.diesel])
  assert.equal((await api.diesel.list()).find((e) => e.id === early.id)!.customerId, B.id)
  await correct(assignmentOf(v7.id).id, "2026-11-05") // a date that leaves the 04-11 fill where it is
  assert.equal((await api.diesel.list()).find((e) => e.id === early.id)!.customerId, B.id)
  // A trip billed to B on 03-11 for a vehicle starting with A on 07-11: moving A's start to 02-11 would hide it from B's page.
  const v8 = await vehicle(A.id, "2026-11-07")
  const trip = { ...readCollection("trips")[0], id: "trp_check_v8", tripNo: "CHK-V8", vehicleId: v8.id, customerId: B.id, date: "2026-11-03", invoiceId: null }
  writeCollection("trips", [...readCollection("trips"), trip]) // test set-up: a trip recorded before the assignment existed
  await assert.rejects(correct(assignmentOf(v8.id).id, "2026-11-02"), new RegExp(`has a trip CHK-V8 on 03-11-2026 billed to ${B.shortName}\\. This start date would change where that trip is shown`))
  await correct(assignmentOf(v8.id).id, "2026-11-04")
  assert.deepEqual(readCollection("trips").find((t) => t.id === trip.id), trip) // the trip itself is never changed
  // The same rule for AdBlue, and for moving a start later (days leaving the assignment), in the pure function.
  const periods = [{ id: "a1", vehicleId: "v", customerId: "A", startDate: "2026-11-07", endDate: null, status: "ACTIVE" as const }]
  const adblue = { entries: [{ kind: "AdBlue" as const, vehicleId: "v", customerId: "B", date: "2026-11-05" }], trips: [] }
  assert.deepEqual(startDateProblem(periods, "a1", "2026-11-01", adblue, "2026-11-10"), { kind: "MOVES_ENTRY", record: "AdBlue", date: "2026-11-05", litres: undefined, from: "B", to: "A", more: 0 })
  const later = { entries: [{ kind: "diesel" as const, vehicleId: "v", customerId: "B", date: "2026-11-08" }], trips: [] }
  assert.deepEqual(startDateProblem(periods, "a1", "2026-11-09", later, "2026-11-10"), { kind: "MOVES_ENTRY", record: "diesel", date: "2026-11-08", litres: undefined, from: "A", to: "B", more: 0 }) // reported under A today; would fall back to B
  assert.equal(startDateProblem(periods, "a1", "2026-11-09", { entries: [{ ...later.entries[0], customerId: "A" }], trips: [] }, "2026-11-10"), null) // stored under A: stays A

  /* ---------------------------------------------------------------- 6 & 10. one transaction: a failed audit write leaves neither */
  const target = assignmentOf(six[3].id)
  const c10 = await log()
  failure.key = AUDIT_KEY
  failure.once = true
  await assert.rejects(correct(target.id, "2026-11-02"), /simulated storage failure/)
  assert.deepEqual(assignmentOf(six[3].id), target) // the assignment change was rolled back with the event
  assert.equal(await log(), c10)
  await correct(target.id, "2026-11-02") // a retry succeeds once storage works
  assert.equal(await log(), c10 + 1)

  /* ---------------------------------------------------------------- 8. who may correct */
  assert.equal(isReadMethod("assignments", "correctStartDate"), false) // a write: refused in UI Preview Mode, takes the server's write lock
  assert.equal(isReadMethod("assignments", "list"), true)

  /* ---------------------------------------------------------------- 9. the Monthly Sheet Lock */
  setRole("EMPLOYEE")
  await assert.rejects(correct(assignmentOf(six[4].id).id, "2026-10-30"), /October 2026 is locked/) // 30–31 Oct would join the assignment
  await assert.rejects(correct(withA.id, "2026-09-28"), /September 2026 is locked/)
  await correct(assignmentOf(six[4].id).id, "2026-11-03") // November is open for the Employee
  const empEvent = (await api.audit.list()).find((e) => e.recordId === six[4].id && e.recordType === "Vehicle assignment")!
  assert.equal(empEvent.actor.role, "EMPLOYEE")
  setRole("OWNER")
  await correct(assignmentOf(six[4].id).id, "2026-10-30") // the Owner may change a locked month
  assert.equal(assignmentOf(six[4].id).startDate, "2026-10-30")

  /* ================================================================ back-dated transfers */
  const today = todayISO()
  const assignmentsOf = (vehicleId: string) => readCollection("vehicle_assignments").filter((a) => a.vehicleId === vehicleId).sort((a, b) => a.startDate.localeCompare(b.startDate))
  const span = (vehicleId: string) => assignmentsOf(vehicleId).map((a) => [a.customerId, a.startDate, a.endDate, a.status])
  const transfer = (vehicleId: string, customerId: string, date: string, reason?: string) => api.vehicles.transfer(vehicleId, customerId, date, reason)
  const why = "Vehicle started working for the new customer on this date; transfer entered late"

  /* ---------------------------------------------------------------- T1. effective today: no reason needed */
  const t1 = await vehicle(A.id, "2026-11-01")
  const today1 = await api.diesel.create(fill(t1.id, A.id, today, 1200))
  await transfer(t1.id, B.id, today)
  assert.equal((await api.diesel.list()).find((e) => e.id === today1.id)!.customerId, B.id) // effective today: today's entries follow (rule 6)
  assert.deepEqual(span(t1.id), [[A.id, "2026-11-01", "2026-11-09", "ENDED"], [B.id, "2026-11-10", null, "ACTIVE"]])
  assert.equal((await api.vehicles.get(t1.id))!.assignedCustomerId, B.id)

  /* ---------------------------------------------------------------- T2. back-dated one day: reason required */
  const t2 = await vehicle(A.id, "2026-11-01")
  const cT2 = await log()
  await assert.rejects(transfer(t2.id, B.id, "2026-11-09"), /Enter the reason for back-dating/)
  await assert.rejects(transfer(t2.id, B.id, "2026-11-09", "  "), /Enter the reason/)
  assert.deepEqual([await log(), span(t2.id)], [cT2, [[A.id, "2026-11-01", null, "ACTIVE"]]])
  await transfer(t2.id, B.id, "2026-11-09", why)
  assert.deepEqual(span(t2.id), [[A.id, "2026-11-01", "2026-11-08", "ENDED"], [B.id, "2026-11-09", null, "ACTIVE"]])

  /* ---------------------------------------------------------------- T3–T7. several days (started with B on 07-11, entered 10-11) */
  const t3 = await vehicle(A.id, "2026-11-01")
  const blue = (date: string, customerId: string, closingKm: number) =>
    api.adblue.create({ vehicleId: t3.id, customerId, date, closingKm, quantityLitres: 10, invoiceNo: "", notes: "", source: "DIRECT", vendorName: "Rajaram Automobiles", rate: 95, paymentMode: "CASH" })
  const early3 = await api.diesel.create(fill(t3.id, A.id, "2026-11-03", 1200))
  const blue4 = await blue("2026-11-04", A.id, 1250)
  await assert.rejects(api.diesel.create(fill(t3.id, B.id, "2026-11-07", 1300)), /is assigned to .* on 2026-11-07/) // the problem: B refused before the transfer
  const prev3 = assignmentOf(t3.id)
  const n3 = assignmentCount()
  const stored3 = [readCollection("diesel_entries"), readCollection("adblue_entries"), readCollection("trips"), readCollection("invoices"), readCollection("payments")]
  await transfer(t3.id, B.id, "2026-11-07", why)
  assert.equal(assignmentCount(), n3 + 1) // T4/T5: one new assignment; nothing duplicated or deleted
  const [a3, b3] = assignmentsOf(t3.id)
  assert.deepEqual([a3.id, a3.customerId, a3.startDate, a3.endDate, a3.status], [prev3.id, A.id, "2026-11-01", "2026-11-06", "ENDED"]) // same record, original start kept
  assert.deepEqual([b3.customerId, b3.startDate, b3.endDate, b3.status], [B.id, "2026-11-07", null, "ACTIVE"])
  assert.deepEqual([readCollection("diesel_entries"), readCollection("adblue_entries"), readCollection("trips"), readCollection("invoices"), readCollection("payments")], stored3) // nothing rewritten
  // T6. Diesel: 07-11 and 08-11 now belong to B (A refused there); 03-11 stays with A.
  await assert.rejects(api.diesel.create(fill(t3.id, A.id, "2026-11-07", 1300)), /is assigned to .* on 2026-11-07/)
  const d7 = await api.diesel.create(fill(t3.id, B.id, "2026-11-07", 1300))
  const d8 = await api.diesel.create(fill(t3.id, B.id, "2026-11-08", 1400))
  const reported = await api.diesel.list()
  assert.deepEqual([early3, d7, d8].map((e) => reported.find((r) => r.id === e.id)!.customerId), [A.id, B.id, B.id])
  // T7. AdBlue follows the same dates.
  await assert.rejects(blue("2026-11-08", A.id, 1410), /is assigned to .* on 2026-11-08/)
  const blue8 = await blue("2026-11-08", B.id, 1410)
  const reportedBlue = await api.adblue.list()
  assert.deepEqual([blue4, blue8].map((e) => reportedBlue.find((r) => r.id === e.id)!.customerId), [A.id, B.id])

  /* ---------------------------------------------------------------- T8. trips, and entries a back-dated transfer would move */
  const t4 = await vehicle(A.id, "2026-11-01")
  const trip4 = { ...readCollection("trips")[0], id: "trp_check_t4", tripNo: "CHK-T4", vehicleId: t4.id, customerId: A.id, date: "2026-11-08", invoiceId: null }
  writeCollection("trips", [...readCollection("trips"), trip4]) // set-up: a trip billed to A on 08-11
  const cT8 = await log()
  await assert.rejects(transfer(t4.id, B.id, "2026-11-07", why), new RegExp(`has a trip CHK-T4 on 08-11-2026 billed to ${A.shortName}\\. This effective date would change where that trip is shown`))
  assert.deepEqual([await log(), span(t4.id)], [cT8, [[A.id, "2026-11-01", null, "ACTIVE"]]])
  await transfer(t4.id, B.id, "2026-11-09", why) // after the trip: it stays on A's page
  assert.deepEqual(readCollection("trips").find((t) => t.id === trip4.id), trip4)
  const t5 = await vehicle(A.id, "2026-11-01")
  await api.diesel.create(fill(t5.id, A.id, "2026-11-07", 1200))
  await api.diesel.create(fill(t5.id, A.id, "2026-11-08", 1300))
  await assert.rejects(transfer(t5.id, B.id, "2026-11-07", why), new RegExp(`has a diesel entry on 07-11-2026 \\(.+\\) reported under ${A.shortName}\\. This effective date would move it to ${B.shortName}.* 1 more record would move too\\.$`))
  assert.deepEqual(span(t5.id), [[A.id, "2026-11-01", null, "ACTIVE"]])
  await transfer(t5.id, B.id, "2026-11-09", why)

  /* ---------------------------------------------------------------- T9. invalid and overlapping transfers */
  await assert.rejects(transfer(t2.id, A.id, "2026-11-09", why), /Effective date must be after 2026-11-09/) // would overlap B's assignment
  await assert.rejects(transfer(t2.id, A.id, "2026-11-05", why), /Effective date must be after/) // into A's own past
  await assert.rejects(transfer(t2.id, B.id, today), /already assigned to that customer/)
  for (const bad of ["", "2026-02-30", "10-11-2026"]) await assert.rejects(transfer(t2.id, A.id, bad, why), /Enter the effective date/)
  await assert.rejects(transfer(t2.id, A.id, "2026-11-11", why), /can't be in the future/)
  assert.equal(assignmentsOf(t2.id).length, 2)

  /* ---------------------------------------------------------------- T10. correcting the saved transfer date moves both sides */
  const bOf3 = () => assignmentOf(t3.id, B.id)
  const cT10 = await log()
  await assert.rejects(correct(bOf3().id, "2026-11-08"), new RegExp(`has a diesel entry on 07-11-2026 \\(.+\\) reported under ${B.shortName}\\. This start date would move it to ${A.shortName}`)) // later: 07-11 would fall back to A
  await assert.rejects(correct(bOf3().id, "2026-11-03"), new RegExp(`has a diesel entry on 03-11-2026 \\(.+\\) reported under ${A.shortName}.* 1 more record would move too`)) // the 04-11 AdBlue too
  await assert.rejects(correct(bOf3().id, "2026-11-01"), /must be after 01-11-2026/)
  assert.equal(await log(), cT10)
  await correct(bOf3().id, "2026-11-05", "Correction of incorrectly entered transfer date") // earlier
  assert.deepEqual(assignmentsOf(t3.id).map((a) => [a.id, a.customerId, a.startDate, a.endDate, a.status]), [
    [a3.id, A.id, "2026-11-01", "2026-11-04", "ENDED"],
    [b3.id, B.id, "2026-11-05", null, "ACTIVE"],
  ])
  // T11. One UPDATED event per assignment changed, both with the reason.
  const corr = (await api.audit.list()).filter((e) => e.recordId === t3.id && e.action === "UPDATED" && e.recordType === "Vehicle assignment")
  assert.equal(corr.length, 2)
  assert.deepEqual(corr.map((e) => e.changes.map((c) => [c.field, c.before, c.after])).sort(), [[["endDate", "2026-11-06", "2026-11-04"]], [["startDate", "2026-11-07", "2026-11-05"]]])
  assert.ok(corr.every((e) => e.reason === "Correction of incorrectly entered transfer date" && e.actor.role === "OWNER"))
  await correct(bOf3().id, "2026-11-07", "Correction of incorrectly entered transfer date") // later again: A gets 05–06 back
  assert.deepEqual(span(t3.id), [[A.id, "2026-11-01", "2026-11-06", "ENDED"], [B.id, "2026-11-07", null, "ACTIVE"]])
  assert.equal(await log(), cT10 + 4)

  /* ---------------------------------------------------------------- T11. the transfer's audit event */
  const tev = (await api.audit.list()).find((e) => e.recordId === t3.id && e.action === "TRANSFERRED")!
  assert.deepEqual([tev.module, tev.recordType, tev.recordDate, tev.reason, tev.actor.role], ["Vehicles", "Vehicle assignment", "2026-11-07", why, "OWNER"])
  assert.match(tev.note ?? "", /^Back-dated transfer: effective 07-11-2026, recorded 10-11-2026\.$/)
  assert.equal(tev.at, "2026-11-10T04:30:00.000Z") // when it was really done
  const tb = tev.before as { previousAssignment: { id: string; endDate: string | null } }
  const ta = tev.after as { effectiveDate: string; previousAssignment: { id: string; startDate: string; endDate: string }; newAssignment: { customerId: string; startDate: string; endDate: null } }
  assert.deepEqual([tb.previousAssignment.id, tb.previousAssignment.endDate], [a3.id, null])
  assert.deepEqual([ta.effectiveDate, ta.previousAssignment.id, ta.previousAssignment.startDate, ta.previousAssignment.endDate], ["2026-11-07", a3.id, "2026-11-01", "2026-11-06"])
  assert.deepEqual([ta.newAssignment.customerId, ta.newAssignment.startDate, ta.newAssignment.endDate], [B.id, "2026-11-07", null])
  assert.equal((await api.audit.list()).find((e) => e.recordId === t1.id && e.action === "TRANSFERRED")!.note ?? null, null) // today: not back-dated

  /* ---------------------------------------------------------------- T12. one transaction: any failed write leaves nothing */
  const t6 = await vehicle(A.id, "2026-11-01")
  for (const key of [AUDIT_KEY, "vt:vehicles"]) {
    const cT12 = await log()
    failure.key = key
    failure.once = true
    await assert.rejects(transfer(t6.id, B.id, "2026-11-07", why), /simulated storage failure/)
    assert.deepEqual([span(t6.id), (await api.vehicles.get(t6.id))!.assignedCustomerId, await log()], [[[A.id, "2026-11-01", null, "ACTIVE"]], A.id, cT12])
  }
  await transfer(t6.id, B.id, "2026-11-07", why) // a retry succeeds
  const both = assignmentsOf(t6.id)
  failure.key = AUDIT_KEY
  failure.once = true
  await assert.rejects(correct(both[1].id, "2026-11-05"), /simulated storage failure/)
  assert.deepEqual(assignmentsOf(t6.id), both) // neither side moved
  assert.equal(isReadMethod("vehicles", "transfer"), false)

  /* ---------------------------------------------------------------- T13–T14. month lock, Employee and Owner */
  const t7 = await vehicle(A.id, "2026-10-01")
  const t8 = await vehicle(A.id, "2026-10-01")
  setRole("EMPLOYEE")
  await assert.rejects(transfer(t7.id, B.id, "2026-10-30", why), /October 2026 is locked/) // 30–31 Oct would move to B
  assert.deepEqual(span(t7.id), [[A.id, "2026-10-01", null, "ACTIVE"]])
  await transfer(t8.id, B.id, "2026-11-02", why) // November is open for the Employee
  assert.equal((await api.audit.list()).find((e) => e.recordId === t8.id && e.action === "TRANSFERRED")!.actor.role, "EMPLOYEE")
  await assert.rejects(correct(assignmentOf(t8.id, B.id).id, "2026-10-31"), /October 2026 is locked/) // its correction too
  setRole("OWNER")
  await transfer(t7.id, B.id, "2026-10-30", why) // the Owner may back-date into a locked month
  assert.deepEqual(span(t7.id), [[A.id, "2026-10-01", "2026-10-29", "ENDED"], [B.id, "2026-10-30", null, "ACTIVE"]])

  console.log("dated assignments (start-date corrections, back-dated transfers): all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
