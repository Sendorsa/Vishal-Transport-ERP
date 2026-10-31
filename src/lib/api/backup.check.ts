/**
 * Runnable check for backups, restore / import files and the import-era model rules:  npm run check:backup
 * Real API on in-memory data. With `IMPORT_FILE=path` it also restores that prepared import file and checks it.
 *
 *   - export → restore round trip; restoring twice never duplicates; all-or-nothing on a bad file or a full store
 *   - Owner and Dev only, audited as DATA_RESET; a data-format change never replaces restored data with demo data
 *   - station opening balances, tanker opening stock, fills without an odometer
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { failure, setRole, storage } from "./test-browser"

async function main() {
  const { api } = await import("./index")
  const { ensureSeeded, parseBackup } = await import("./bootstrap")
  const { readMeta, writeMeta, readCollection, SCHEMA_VERSION } = await import("@/lib/storage/local-store")
  const { stationLedger, ledgerFor, openingOf } = await import("@/domain/station-ledger")
  const { buildDieselIndex, fillRow, statsOf } = await import("@/domain/diesel")
  const { loadsAsStationPurchases } = await import("@/domain/tanker")
  setRole("OWNER")

  /* ---------------------------------------------------------------- export → restore round trip */
  const count = (f: { collections: object }) => Object.fromEntries(Object.entries(f.collections).map(([k, v]) => [k, (v as unknown[]).length]))
  const demo = await api.admin.exportBackup()
  assert.ok((demo.collections.diesel_entries ?? []).length > 100)
  assert.ok("tanker_loads" in demo.collections && "tanker_dispenses" in demo.collections, "backups include the tanker collections")
  // A restore runs the storage migrations (e.g. inferring vehicle assignments), so compare from the first restore on.
  await api.admin.restoreBackup(structuredClone(demo), "round-trip.json")
  const before = await api.admin.exportBackup()
  assert.deepEqual({ ...count(before), vehicle_assignments: 0 }, { ...count(demo), vehicle_assignments: 0 })
  await api.admin.restoreBackup(structuredClone(before), "round-trip.json") // again: replaces, never adds
  assert.deepEqual(count(await api.admin.exportBackup()), count(before))
  assert.equal(readMeta()!.source, "RESTORED")
  const resets = (await api.audit.list()).filter((e) => e.action === "DATA_RESET" && e.label.includes("round-trip.json"))
  assert.equal(resets.length, 2)
  assert.equal(resets[0].actor.role, "OWNER")

  /* ---------------------------------------------------------------- refusals leave everything as it was */
  const snapshot = JSON.stringify(storage)
  for (const r of ["ACCOUNTANT", "OPS_MANAGER", "EMPLOYEE"] as const) {
    setRole(r)
    await assert.rejects(api.admin.restoreBackup(before, "x.json"), /Only the Owner or Dev/)
  }
  setRole("DEV")
  const bad = structuredClone(before)
  bad.collections.diesel_entries![0].vehicleId = "veh_missing"
  await assert.rejects(api.admin.restoreBackup(bad, "bad.json"), /points to a missing record veh_missing/)
  const dup = structuredClone(before)
  dup.collections.payments!.push(dup.collections.payments![0])
  await assert.rejects(api.admin.restoreBackup(dup, "dup.json"), /duplicate id/)
  await assert.rejects(api.admin.restoreBackup({ ...before, version: SCHEMA_VERSION + 1 }, "new.json"), /newer app version/)
  failure.key = "vt:fuelEntries" // storage full half-way through
  failure.once = true
  await assert.rejects(api.admin.restoreBackup(before, "full.json"))
  const was = JSON.parse(snapshot) as Record<string, string>
  const changed = [...new Set([...Object.keys(was), ...Object.keys(storage)])].filter((k) => k !== "vt:ui:role" && was[k] !== (storage as unknown as Record<string, string>)[k]) // the role is the test switching users
  assert.deepEqual(changed, [], "a refused or failed restore changes nothing")
  setRole("OWNER")

  /* ---------------------------------------------------------------- restored data survives a data-format change */
  writeMeta({ ...readMeta()!, version: SCHEMA_VERSION - 1 })
  ensureSeeded()
  assert.equal(readMeta()!.version, SCHEMA_VERSION)
  assert.deepEqual(count(await api.admin.exportBackup()), count(before), "never re-seeded over restored data")

  /* ---------------------------------------------------------------- opening balances, opening stock, no odometer */
  const purchases = [{ vendorId: "s1", date: "2026-04-10", amount: 1000 }, { vendorId: "s1", date: "2026-05-03", amount: 500 }]
  const pays = [{ vendorId: "s1", date: "2026-04-20", amount: 300, direction: "OUT" as const, categoryCode: "DIESEL_SETTLEMENT" }]
  const rows = stationLedger("s1", purchases, pays, "2026-05", openingOf({ openingBalance: 200, openingBalanceDate: "2026-04-01" }))
  assert.deepEqual(rows.map((r) => [r.month, r.opening, r.closing]), [["2026-04", 200, 900], ["2026-05", 900, 1400]])
  assert.equal(ledgerFor(rows).opening, 200) // all time opens at the opening balance
  assert.equal(ledgerFor(rows, ["2026-04"]).opening, 200)
  assert.equal(ledgerFor(rows, ["2026-03"]).opening, 0) // before the ledger began
  assert.equal(stationLedger("s1", purchases, pays)[0].opening, 0) // no opening balance: as before
  const opening = { id: "tkl_open", date: "2026-04-01", stationId: "", opening: true, invoiceNo: "", litres: 100, rate: 90, amount: 9000, notes: "", createdAt: "", updatedAt: "" }
  assert.equal(loadsAsStationPurchases([opening]).length, 0, "opening stock is owed to no station")

  const vehicles = readCollection("vehicles")
  const v = vehicles[0]
  const mk = (id: string, date: string, odometerKm: number | null) => ({ id, date, vehicleId: v.id, customerId: null, vendorId: "dv_vishal", litres: 50, rate: 100, amount: 5000, odometerKm, billNo: "", paymentMode: "CREDIT" as const, companyCode: "VT" as const, createdAt: "", updatedAt: "" })
  const diesel = [mk("a", "2026-04-01", 1000), mk("b", "2026-04-05", null), mk("c", "2026-04-09", 1600)]
  const idx = buildDieselIndex({ settings: (await api.settings.get()), customers: [], vehicles, drivers: [], trips: [], diesel, invoices: [], payments: [], fuelStations: [] })
  assert.deepEqual(diesel.map((e) => fillRow(idx, e).kmSince), [null, null, 600], "a fill without an odometer has no KM and is skipped as the previous reading")
  assert.equal(statsOf(idx, diesel).km, 600)

  /* ---------------------------------------------------------------- optional: a prepared import file */
  const file = process.env.IMPORT_FILE
  if (file) {
    const data = parseBackup(JSON.parse(readFileSync(file, "utf8")))
    await api.admin.restoreBackup(data, file.split("/").at(-1)!)
    await api.admin.restoreBackup(data, file.split("/").at(-1)!)
    const after = await api.admin.exportBackup()
    assert.deepEqual(count(after), count(data), "import restores exactly the file's records, twice without duplicates")
    const chars = Object.entries(storage).filter(([k]) => k.startsWith("vt:")).reduce((s, [, val]) => s + String(val).length, 0)
    assert.ok(chars < 4_500_000, `fits browser storage (${chars.toLocaleString()} chars)`)
    const ds = { diesel: await api.diesel.list(), stations: await api.fuelStations.list(), loads: await api.tankerLoads.list(), pay: await api.payments.list() }
    const all = [...ds.diesel, ...loadsAsStationPurchases(ds.loads)]
    for (const s of ds.stations.filter((x) => !x.isTanker)) {
      const led = stationLedger(s.id, all, ds.pay, "2026-10", openingOf(s))
      led.forEach((r, i) => i && assert.equal(r.opening, led[i - 1].closing, `${s.name} ${r.month} opens at the previous closing`))
    }
    const stock = await api.tankerLoads.list()
    assert.ok(stock.some((l) => l.opening), "tanker opening stock imported")
    assert.ok(ds.diesel.filter((d) => d.vendorId === "dv_tanker").every((d) => d.amount > 0), "every tanker fill is costed (its own rate, else the loads' average)")
    // Tankers: every tanker record names an existing tanker; no tanker's stock ever goes below zero.
    const { valueTankers, tankerOf } = await import("@/domain/tanker")
    const tankers = new Set((await api.tankers.list()).map((t) => t.id))
    const tr = { loads: ds.loads, fills: ds.diesel, external: await api.tankerDispenses.list(), transfers: await api.tankerTransfers.list(), adjustments: await api.tankerAdjustments.list() }
    for (const x of [...tr.loads, ...tr.external, ...ds.diesel.filter((d) => d.vendorId === "dv_tanker")]) assert.ok(tankers.has(tankerOf(x)), `${x.id} names an existing tanker`)
    assert.equal(valueTankers(tr).shortfall, null, "no tanker's stock goes below zero")
    // FY 2026-27 only: every transaction dated 1 Apr 2026 – 31 Mar 2027 and not after the import's cutoff.
    const dates = [...ds.diesel, ...tr.loads, ...tr.external, ...ds.pay].map((x) => x.date)
    assert.ok(dates.every((d) => d >= "2026-04-01" && d <= "2027-03-31" && d <= "2026-10-14"), "every record is inside FY 2026-27 and the import cutoff")
    // TDS entries (answer 14): dated a month's last day, ₹0 to the bank.
    for (const p of ds.pay.filter((x) => x.tdsAmount > 0 && x.direction === "OUT")) assert.ok(p.amount === 0 && p.date.endsWith(String(new Date(Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7), 0)).getUTCDate())), `${p.paymentNo} TDS on the month's last day`)
    console.log(`import file: ${count(data).diesel_entries} diesel entries, ${chars.toLocaleString()} chars in storage`)
  }
  console.log("backup / restore: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
