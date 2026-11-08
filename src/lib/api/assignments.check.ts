/**
 * Runnable check for Edit Assignment — correcting an assignment's start date: npm run check:assignments.
 * Real API on in-memory demo data (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST
 * (September and October are closed for the Employee).
 *
 *   1. Six vehicles entered "since 07-11-2026" are corrected to 01-11-2026: same assignment, customer, end, status.
 *   2–4. Invalid dates, a start after the end date, overlapping another assignment — refused with the reason.
 *   5, 6, 10. One UPDATED event (before / after start date, reason, actor) written with the change, or neither.
 *   7. Diesel / AdBlue entries and trips never move to another customer; stored records never change.
 *   8, 9. UI Preview Mode blocks the call; the Monthly Sheet Lock applies to every month whose days change.
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
  await assert.rejects(correct(withB.id, "2026-10-15"), new RegExp(`is assigned to ${A.shortName} from 01-10-2026 to 19-10-2026\\. An assignment can't overlap`))
  await correct(withA.id, "2026-09-28") // the first assignment may start earlier: nothing before it
  await correct(withA.id, "2026-10-01") // and back

  /* ---------------------------------------------------------------- 7. entries and trips never move silently */
  const v7 = await vehicle(A.id, "2026-11-07")
  await api.diesel.create(fill(v7.id, A.id, "2026-11-08", 1500))
  // 04-11, before any assignment covered it, a fill was recorded under customer B (allowed then).
  const early = await api.diesel.create(fill(v7.id, B.id, "2026-11-04", 1200))
  const c7 = { log: await log(), diesel: readCollection("diesel_entries") }
  await assert.rejects(correct(assignmentOf(v7.id).id, "2026-11-01"), new RegExp(`has a diesel entry on 04-11-2026 reported under ${B.shortName}\\. This start date would move it to ${A.shortName}`))
  assert.deepEqual([await log(), readCollection("diesel_entries")], [c7.log, c7.diesel])
  assert.equal((await api.diesel.list()).find((e) => e.id === early.id)!.customerId, B.id)
  await correct(assignmentOf(v7.id).id, "2026-11-05") // a date that leaves the 04-11 fill where it is
  assert.equal((await api.diesel.list()).find((e) => e.id === early.id)!.customerId, B.id)
  // A trip billed to B on 03-11 for a vehicle starting with A on 07-11: moving A's start to 02-11 would hide it from B's page.
  const v8 = await vehicle(A.id, "2026-11-07")
  const trip = { ...readCollection("trips")[0], id: "trp_check_v8", tripNo: "CHK-V8", vehicleId: v8.id, customerId: B.id, date: "2026-11-03", invoiceId: null }
  writeCollection("trips", [...readCollection("trips"), trip]) // test set-up: a trip recorded before the assignment existed
  await assert.rejects(correct(assignmentOf(v8.id).id, "2026-11-02"), new RegExp(`has a trip on 03-11-2026 billed to ${B.shortName}\\. This start date would change where that trip is shown`))
  await correct(assignmentOf(v8.id).id, "2026-11-04")
  assert.deepEqual(readCollection("trips").find((t) => t.id === trip.id), trip) // the trip itself is never changed
  // The same rule for AdBlue, and for moving a start later (days leaving the assignment), in the pure function.
  const periods = [{ id: "a1", vehicleId: "v", customerId: "A", startDate: "2026-11-07", endDate: null, status: "ACTIVE" as const }]
  const adblue = { entries: [{ kind: "AdBlue" as const, vehicleId: "v", customerId: "B", date: "2026-11-05" }], trips: [] }
  assert.deepEqual(startDateProblem(periods, "a1", "2026-11-01", adblue, "2026-11-10"), { kind: "MOVES_ENTRY", record: "AdBlue", date: "2026-11-05", from: "B", to: "A" })
  const later = { entries: [{ kind: "diesel" as const, vehicleId: "v", customerId: "B", date: "2026-11-08" }], trips: [] }
  assert.deepEqual(startDateProblem(periods, "a1", "2026-11-09", later, "2026-11-10"), { kind: "MOVES_ENTRY", record: "diesel", date: "2026-11-08", from: "A", to: "B" }) // reported under A today; would fall back to B
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

  console.log("edit assignment (start-date correction): all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
