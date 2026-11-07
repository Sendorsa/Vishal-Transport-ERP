/**
 * Runnable check for tanker stock after reloads: npm run check:tanker-stock. Real API on in-memory demo data
 * (nothing touches real browser data), clock fixed at 10 Nov 2026, 10:00 IST, as the Owner.
 *
 * Regression for "a new load is in Load History, but the next fill says insufficient tanker inventory":
 *   A. The dialog showed the stock after the LAST record; the API checks the stock on the fill's OWN date. Both now
 *      use `tankerAvailability`, and the refusal says when a later-dated load is why.
 *   B. A shortfall anywhere in one tanker's history blocked every other tanker. The API now checks only the tankers a
 *      change touches — as the database's stock trigger does.
 */
import assert from "node:assert/strict"
import { setRole, tankerRecordsOf } from "./test-browser"

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
  const { valueTankers, tankerAvailability, fitsTanker, tankerLedger, tankerMoves } = await import("@/domain/tanker")
  const { readCollection, writeCollection } = await import("@/lib/storage/local-store")
  assert.equal(todayISO(), "2026-11-10")
  setRole("OWNER")

  /* ---------------------------------------------------------------- set-up: two tankers, one diesel vehicle with no fills */
  const t = { vehicleId: null, notes: "" }
  const A = (await api.tankers.create({ ...t, name: "Reload A", regNo: "KA99RA0001", capacityLitres: 6000 })).id
  const B = (await api.tankers.create({ ...t, name: "Reload B", regNo: "KA99RB0002", capacityLitres: 3000 })).id
  const tankerVehicles = new Set(readCollection("tankers").map((x) => x.vehicleId))
  const assignments = await api.assignments.list()
  const vehicle = (await api.vehicles.list()).find(
    (v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && !tankerVehicles.has(v.id) && assignments.some((a) => a.vehicleId === v.id && a.customerId && a.startDate <= "2026-09-01" && a.endDate === null)
  )!
  assert.ok(vehicle, "a diesel vehicle assigned since before September")
  writeCollection("diesel_entries", readCollection("diesel_entries").filter((e) => e.vehicleId !== vehicle.id)) // test set-up: its odometer chain starts empty
  // Odometer readings rise with the date (and with each fill on a day), so a back-dated fill always fits its neighbours.
  const base = vehicle.odometerKm + 100_000
  let seq = 0
  const odo = (date: string) => base + Math.round((Date.parse(date) - Date.parse("2026-01-01")) / 86_400_000) * 1000 + ++seq
  const fill = (tankerId: string, date: string, litres: number) => ({
    date, vehicleId: vehicle.id, customerId: null, vendorId: "dv_tanker", tankerId, litres, rate: 95, odometerKm: odo(date), billNo: "", paymentMode: "CREDIT" as const,
  })
  const load = (tankerId: string, date: string, litres: number) => api.tankerLoads.create({ tankerId, date, stationId: "dv_lakshmitha", invoiceNo: "", litres, rate: 95, notes: "" })
  const stock = async (id: string) => valueTankers(await tankerRecordsOf()).stock.get(id)?.litres ?? 0
  /** What the Add Diesel Entry dialog shows (and checks) for a new fill on `date`. */
  const shown = async (id: string, date: string) => tankerAvailability(await tankerRecordsOf(), { id: "new", date, createdAt: new Date().toISOString(), tankerId: id })
  const counts = async () => ({ fills: (await api.diesel.list()).length, loads: (await api.tankerLoads.list()).length, log: (await api.audit.list()).length })

  /* ---------------------------------------------------------------- 1. Load → dispense → reload → dispense */
  await load(A, "2026-11-01", 6000)
  await api.diesel.create(fill(A, "2026-11-02", 5500))
  assert.equal((await shown(A, "2026-11-03")).available, 500)
  await load(A, "2026-11-05", 5000) // more than the 6,000 L capacity in total: capacity never limits loading
  assert.equal(await stock(A), 5500) // 6,000 − 5,500 + 5,000
  assert.equal((await shown(A, "2026-11-06")).available, 5500)
  await api.diesel.create(fill(A, "2026-11-06", 1000))
  assert.equal(await stock(A), 4500)
  assert.equal((await api.tankers.list()).find((x) => x.id === A)!.capacityLitres, 6000) // capacity unchanged

  /* ---------------------------------------------------------------- 2. Reload dated after the new dispense */
  const before = await counts()
  const early = await shown(A, "2026-11-04")
  assert.deepEqual([early.available, early.limitedOn, early.nextIn], [500, "2026-11-04", { date: "2026-11-05", litres: 5000, kind: "LOAD" }])
  assert.equal(fitsTanker(early, 1000), false) // the dialog refuses it too — it no longer shows 4,500 L for 04-11
  await assert.rejects(
    api.diesel.create(fill(A, "2026-11-04", 1000)),
    (e: Error) => e.message.startsWith("Insufficient tanker inventory in Reload A. Available: 500 L on 04-11-2026.") && /next load into Reload A \(5,000 L\) is dated 05-11-2026/.test(e.message)
  )
  assert.deepEqual(await counts(), before) // refused: nothing saved, nothing audited, no date changed
  await api.diesel.create(fill(A, "2026-11-04", 500)) // what was really there on 04-11 is accepted
  assert.equal(await stock(A), 4000)

  /* ---------------------------------------------------------------- 3. Reload and dispense on the same date */
  assert.equal((await shown(A, "2026-11-05")).available, 4000) // the same-day load comes first; 06-11's 1,000 L stays covered
  await api.diesel.create(fill(A, "2026-11-05", 1000))
  assert.equal(await stock(A), 3000)

  /* ---------------------------------------------------------------- 4. Several loads and dispenses across months */
  await load(B, "2026-09-10", 2000)
  await api.diesel.create(fill(B, "2026-09-15", 800))
  await load(B, "2026-10-03", 1500)
  await api.diesel.create(fill(B, "2026-10-20", 2000))
  await api.diesel.create(fill(B, "2026-11-03", 500))
  await load(B, "2026-11-04", 1000)
  await api.diesel.create(fill(B, "2026-11-07", 700))
  const ledger = tankerLedger(tankerMoves(await tankerRecordsOf()), B, "2026-11")
  assert.deepEqual(ledger.map((r) => [r.month, r.opening, r.loaded, r.dispensed, r.closing]), [
    ["2026-09", 0, 2000, 800, 1200],
    ["2026-10", 1200, 1500, 2000, 700], // October opens with September's closing
    ["2026-11", 700, 1000, 1200, 500],
  ])
  assert.equal(await stock(B), 500) // Σ loads 4,500 − Σ fills 4,000: each counted once
  assert.equal((await shown(B, "2026-10-21")).available, 200) // 700 on 21-10, but 03-11's 500 L needs it before 04-11's load
  await assert.rejects(api.diesel.create(fill(B, "2026-10-21", 300)), /Available: 200 L on 21-10-2026\. Later records of Reload B \(up to 03-11-2026\) already use the rest\./)

  /* ---------------------------------------------------------------- 5. Another tanker's historical shortfall doesn't block */
  // Records saved before the stock rule (an old import or a restored file), never loaded: a pool fill with no tanker id
  // (it belongs to the default pool, tankerOf) and a fill on a real tanker D.
  const D = (await api.tankers.create({ ...t, name: "Reload D", regNo: "KA99RD0004", capacityLitres: null })).id
  const planted = (id: string, tankerId: string | undefined, date: string) => ({ ...fill(A, date, 100), id, tankerId, createdAt: `${date}T05:00:00.000Z`, updatedAt: `${date}T05:00:00.000Z`, amount: 9500 })
  const broken = [planted("dsl_broken_pool", undefined, "2026-08-20"), planted("dsl_broken_d", D, "2026-08-21")]
  writeCollection("diesel_entries", [...readCollection("diesel_entries"), ...(broken as never[])])
  assert.equal(valueTankers(await tankerRecordsOf()).shortfall?.tankerId, "tnk_default") // before the fix this refused every tanker's writes
  await api.diesel.create(fill(A, "2026-11-08", 100)) // A is unaffected…
  await load(B, "2026-11-08", 300) // …and B
  await api.tankerAdjustments.create({ date: "2026-11-08", tankerId: A, litres: -10, reason: "Dip reading" })
  // The broken tanker itself stays guarded: anything touching it is refused, and the dialog says why.
  assert.equal((await shown("tnk_default", "2026-11-08")).existing?.date, "2026-08-20")
  const dShown = await shown(D, "2026-11-08")
  assert.deepEqual([dShown.available, dShown.existing?.date], [0, "2026-08-21"])
  await assert.rejects(api.tankerTransfers.create({ date: "2026-11-08", fromTankerId: A, toTankerId: D, litres: 10, notes: "" }), /Insufficient tanker inventory in Reload D\. Available: 0 L on 21-08-2026/)
  await assert.rejects(api.diesel.create(fill(D, "2026-11-08", 1)), /Reload D's records already go below zero on 21-08-2026 \(0 L in stock, 100 L drawn\) — correct that record first\./)
  await load(D, "2026-11-08", 500) // a load is never refused (it only adds); the old shortfall on 21-08 is still there
  writeCollection("diesel_entries", readCollection("diesel_entries").filter((e) => !broken.some((b) => b.id === e.id))) // remove the planted records
  assert.equal(valueTankers(await tankerRecordsOf()).shortfall, null)

  /* ---------------------------------------------------------------- 6 & 7. Genuine negative; exact quantity */
  assert.equal(await stock(A), 2890) // 3,000 − 100 − 10
  const c6 = await counts()
  await assert.rejects(api.diesel.create(fill(A, "2026-11-09", 2890.01)), /Insufficient tanker inventory in Reload A\. Available: 2,890 L on 09-11-2026\.$/) // no later load to mention
  assert.deepEqual(await counts(), c6)
  await api.diesel.create(fill(A, "2026-11-09", 2890)) // exactly what's there
  assert.equal(await stock(A), 0)
  await assert.rejects(api.diesel.create(fill(A, "2026-11-09", 0.01)), /Available: 0 L on 09-11-2026/)
  await load(A, "2026-11-09", 2000)

  /* ---------------------------------------------------------------- 8. Editing / deleting loads and fills that later draws depend on */
  const loads = await api.tankerLoads.list()
  const reload = loads.find((l) => l.tankerId === A && l.date === "2026-11-05")!
  const c8 = await counts()
  await assert.rejects(api.tankerLoads.remove(reload.id, "Entered twice"), /Insufficient tanker inventory in Reload A\. Available: 0 L on 05-11-2026\. The next load into Reload A \(2,000 L\) is dated 09-11-2026/) // 04-11 takes the last 500 L; 05-11 is the first fill short
  await assert.rejects(api.tankerLoads.update(reload.id, { tankerId: A, date: "2026-11-07", stationId: reload.stationId, invoiceNo: "", litres: 5000, rate: 95, notes: "" }), /Insufficient tanker inventory in Reload A/)
  await assert.rejects(api.tankerLoads.update(reload.id, { tankerId: A, date: "2026-11-05", stationId: reload.stationId, invoiceNo: "", litres: 2999, rate: 95, notes: "" }), /Insufficient tanker inventory in Reload A/)
  assert.deepEqual(await counts(), c8)
  await api.tankerLoads.update(reload.id, { tankerId: A, date: "2026-11-05", stationId: reload.stationId, invoiceNo: "", litres: 3000, rate: 95, notes: "" }, "Invoice corrected") // the least that still covers every later fill
  assert.equal(await stock(A), 0)
  await api.tankerLoads.update(reload.id, { tankerId: A, date: "2026-11-05", stationId: reload.stationId, invoiceNo: "", litres: 5000, rate: 95, notes: "" }, "Back to the invoice")
  const first = (await api.diesel.list()).find((e) => e.vehicleId === vehicle.id && e.date === "2026-11-02")!
  const edit = (litres: number) => api.diesel.update(first.id, { date: first.date, vendorId: first.vendorId, litres, rate: first.rate, odometerKm: first.odometerKm, billNo: first.billNo, paymentMode: first.paymentMode, tankerId: A }, "Bill corrected")
  // The edited fill itself is left out: 6,000 L on 02-11, but 04-11's 500 L must still be covered before the reload.
  assert.equal(tankerAvailability(await tankerRecordsOf(), { ...first, tankerId: A }).available, 5500)
  await assert.rejects(edit(5500.01), /Available: 5,500 L on 02-11-2026\. Later records of Reload A \(up to 04-11-2026\) already use the rest\. The next load into Reload A \(5,000 L\) is dated 05-11-2026/)
  await edit(5400)
  await edit(5500)
  await api.diesel.remove(first.id, "Test: deleting a draw only returns litres")
  assert.equal(await stock(A), 2000 + 5500)

  /* ---------------------------------------------------------------- 9. The dialog's rule and the API's backstop agree */
  // For every date and quantity: fitsTanker(tankerAvailability) ⇔ the stock run with that fill added has no shortfall
  // for that tanker (valueTankers, which the API and — per tanker — the database trigger apply).
  const recs = await tankerRecordsOf()
  for (const id of [A, B])
    for (const date of ["2026-09-12", "2026-10-02", "2026-10-21", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-09", "2026-11-10"])
      for (const litres of [1, 199.99, 200, 200.01, 500, 1000, 1999.99, 2000, 5000, 7500, 7500.01]) {
        const at = { id: "probe", date, createdAt: new Date().toISOString(), tankerId: id }
        const fits = fitsTanker(tankerAvailability(recs, at), litres)
        const run = valueTankers({ ...recs, fills: [...recs.fills, { ...at, litres, vendorId: "dv_tanker" }] })
        assert.equal(fits, !run.shortfalls.has(id), `${id} ${date} ${litres} L`)
      }

  /* ---------------------------------------------------------------- 10. Transfers, adjustments, opening stock, external dispenses */
  const dialogTransfer = tankerAvailability(await tankerRecordsOf(), { id: "new", date: "2026-11-09", createdAt: new Date().toISOString(), tankerId: B, kind: "TRANSFER_OUT" })
  assert.equal(dialogTransfer.available, 800) // B: 500 + 300 loaded on 08-11 — the hint on the Transfer dialog
  await assert.rejects(api.tankerTransfers.create({ date: "2026-11-09", fromTankerId: B, toTankerId: A, litres: 800.01, notes: "" }), /Insufficient tanker inventory in Reload B/)
  await api.tankerTransfers.create({ date: "2026-11-09", fromTankerId: B, toTankerId: A, litres: 800, notes: "" })
  assert.deepEqual([await stock(A), await stock(B)], [8300, 0]) // never a purchase: the total is unchanged
  await assert.rejects(api.tankerAdjustments.create({ date: "2026-11-09", tankerId: B, litres: -1, reason: "Dip reading" }), /Insufficient tanker inventory in Reload B\. Available: 0 L on 09-11-2026/)
  await api.tankerAdjustments.create({ date: "2026-11-09", tankerId: B, litres: 25, reason: "Dip reading" })
  await api.tankerDispenses.create({ tankerId: A, date: "2026-11-10", vehicleNo: "KA01EXT0001", litres: 300, notes: "Hired JCB" })
  const C = (await api.tankers.create({ ...t, name: "Reload C", regNo: "KA99RC0003", capacityLitres: null })).id
  await api.tankerLoads.createOpening({ tankerId: C, date: "2026-10-31", litres: 400, value: 38000, notes: "Dip reading" })
  assert.equal((await shown(C, "2026-11-01")).available, 400) // opening stock counts as stock…
  await api.diesel.create(fill(C, "2026-11-01", 400))
  assert.deepEqual([await stock(A), await stock(B), await stock(C)], [8000, 25, 0])
  const novC = tankerLedger(tankerMoves(await tankerRecordsOf()), C, "2026-11").at(-1)!
  assert.deepEqual([novC.opening, novC.loaded, novC.dispensed, novC.closing], [400, 0, 400, 0]) // …but is never "Loaded"

  console.log("tanker stock after reloads (date-aware availability, per-tanker validation): all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
