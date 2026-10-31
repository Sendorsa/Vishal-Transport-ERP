/**
 * Clean test import (isolated): runs the real app API on in-memory browser storage — never the user's browser.
 *
 *   npm run import:test        (after build.ts with VT_EMIT_FROM, see import/test-sep-oct-2026)
 *
 * 1. The test environment starts with existing business data (the app's demo data) — backed up and re-read.
 * 2. Clear + import = Settings → Restore from file (Owner): replaces every business collection, keeps the audit log,
 *    the session and nothing else; must not be re-seeded by a reload or a data-format change.
 * 3. Restoring the same file again must not duplicate anything.
 * 4. Everything is checked against the build's own reconciliation and the period's rules.
 */
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setRole, storage } from "../../src/lib/api/test-browser"

const DIR = join(__dirname, "..", "..", "..", "import", "test-sep-oct-2026")
const FILE = join(DIR, "vishal-fuel-test-import.json")

async function main() {
  const { api } = await import("@/lib/api")
  const { parseBackup, ensureSeeded } = await import("@/lib/api/bootstrap")
  const { readMeta, writeMeta } = await import("@/lib/storage/local-store")
  const { valueTankers, tankerLedger, tankerMoves, tankerPeriod, loadsAsStationPurchases, fillAmount } = await import("@/domain/tanker")
  const { stationLedger, openingOf, ledgerFor } = await import("@/domain/station-ledger")
  const { round2 } = await import("@/lib/format")
  const rec = JSON.parse(readFileSync(join(DIR, "reconciliation.json"), "utf8"))
  const file = parseBackup(JSON.parse(readFileSync(FILE, "utf8")))
  const count = (c: Record<string, unknown[] | undefined>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (v ?? []).length]))
  const out: Record<string, unknown> = {}

  // 1. Existing data in the isolated environment, and its backup.
  setRole("OWNER")
  ensureSeeded()
  const before = await api.admin.exportBackup()
  writeFileSync(join(DIR, "test-environment-backup-before-import.json"), JSON.stringify(before))
  const reread = parseBackup(JSON.parse(readFileSync(join(DIR, "test-environment-backup-before-import.json"), "utf8")))
  assert.deepEqual(count(reread.collections), count(before.collections), "the pre-import backup can be read back in full")
  out.before = { counts: count(before.collections), meta: readMeta() }
  const auditBefore = (await api.audit.list()).length

  // 2. Clear + import (one transaction; the audit log and session stay).
  await api.admin.restoreBackup(file, "vishal-fuel-test-import.json")
  const after = await api.admin.exportBackup()
  assert.deepEqual(count(after.collections), count(file.collections), "the import holds exactly the file's records — nothing left from before")
  assert.equal(storage.getItem("vt:ui:role"), "OWNER", "the session is kept")
  assert.equal((await api.audit.list()).length, auditBefore + 1, "the audit log is kept and records the import (DATA_RESET)")
  assert.equal(readMeta()!.source, "RESTORED")
  // A reload, and a data-format change, must not bring demo data back.
  ensureSeeded()
  writeMeta({ ...readMeta()!, version: readMeta()!.version - 1 })
  ensureSeeded()
  assert.deepEqual(count((await api.admin.exportBackup()).collections), count(file.collections), "no re-seeding after a reload or a data-format change")

  // 3. Same file again: no duplicates.
  await api.admin.restoreBackup(file, "vishal-fuel-test-import.json")
  assert.deepEqual(count((await api.admin.exportBackup()).collections), count(file.collections), "restoring twice does not duplicate")
  out.after = count(file.collections)

  // 4. Period rules.
  const diesel = await api.diesel.list()
  const loads = await api.tankerLoads.list()
  const payments = await api.payments.list()
  const stations = await api.fuelStations.list()
  const tankers = await api.tankers.list()
  const external = await api.tankerDispenses.list()
  const from = rec.from as string
  const to = rec.latestSourceDate as string
  for (const x of [...diesel, ...loads.filter((l) => !l.opening), ...payments, ...external]) assert.ok(x.date >= from && x.date <= to, `${x.id} is dated inside ${from} … ${to}`)
  assert.ok(loads.filter((l) => l.opening).every((l) => l.date === from && l.stationId === "" && l.amount === 0), "the only opening record is the explicit unallocated opening stock on the first day")
  assert.equal((await api.adblue.list()).length + (await api.adbluePurchases.list()).length, 0, "no AdBlue records (all quarantined)")
  // Tankers: JIO, Office, Mini exactly; every record names an existing tanker; no tanker below zero.
  const want = [["JIO", "TN70AX9480"], ["Office", "KA53C0538"], ["Mini", "KA51AF1429"]]
  for (const [name, reg] of want) assert.equal(tankers.filter((t) => t.regNo === reg && t.name === name).length, 1, `tanker ${name} ${reg}`)
  assert.equal(new Set(tankers.filter((t) => t.regNo).map((t) => t.regNo)).size, tankers.filter((t) => t.regNo).length, "no duplicate registrations")
  const ids = new Set(tankers.map((t) => t.id))
  for (const x of [...loads, ...external, ...diesel.filter((d) => d.vendorId === "dv_tanker")]) assert.ok(x.tankerId && ids.has(x.tankerId), `${x.id} names an existing tanker`)
  const recs = { loads, fills: diesel, external, transfers: await api.tankerTransfers.list(), adjustments: await api.tankerAdjustments.list() }
  const v = valueTankers(recs)
  assert.equal(v.shortfall, null, "no tanker's stock goes below zero")
  // Tank fills at the rate on the fill (answer 23); the opening stock is never a purchase.
  for (const d of diesel.filter((x) => x.vendorId === "dv_tanker")) assert.equal(d.amount, fillAmount(d, v.costOf))
  const moves = tankerMoves(recs)
  const tankerOut = (rec.months as string[]).map((m) => {
    const p = tankerPeriod(tankerLedger(moves, null, to.slice(0, 7)), [m])
    return { month: m, opening: round2(p.opening + p.openingStock), loaded: p.loaded, loadedCost: p.loadedCost, dispensed: p.dispensed, closing: p.closing }
  })
  for (const [i, t] of tankerOut.entries()) {
    const r = rec.tanker[i]
    assert.deepEqual([t.opening, t.loaded, t.loadedCost, t.dispensed, t.closing], [r.opening, r.loaded, r.loadedCost, r.dispensed, r.closing], `tanker ${t.month} matches the preview`)
    if (i) assert.equal(t.opening, tankerOut[i - 1].closing, `${t.month} opens at the previous closing (carried once)`)
  }
  assert.ok(loads.filter((l) => l.opening).every((l) => !loadsAsStationPurchases([l]).length), "opening stock is owed to no station")
  // S-03: the opening stock is the uncle's 4,094 + 142 + 0 L (whether split by tanker or kept combined).
  if (rec.tankerOpening.answered) assert.equal(round2(loads.filter((l) => l.opening).reduce((t, l) => t + l.litres, 0)), 4236, "opening stock = JIO 4,094 + Office 142 + Mini 0 (S-03)")
  // S-01 / S-02: each station opens 1 September at the answered figure (Vishal ₹12,78,000; Raghuveer ₹9,455.49 + ₹1,50,000; others 0).
  for (const o of rec.stationOpening.filter((x: { stationId: string }) => stations.some((s) => s.id === x.stationId)))
    assert.equal(stations.find((s) => s.id === o.stationId)!.openingBalance ?? 0, o.used ?? 0, `${o.station} opens at ₹${o.used}`)
  assert.equal(stations.find((s) => s.id === "dv_vishal")?.openingBalance, 1278000, "Vishal Gasoline owed ₹12,78,000 on 1 Sep (S-02)")
  assert.ok(payments.some((p) => p.vendorId === "dv_vishal" && p.date === "2026-09-04" && p.amount === 1278000), "the ₹12,78,000 keeps its payment date, 4 Sep")
  // Stations: ledger chains month to month; the app's figures equal the preview.
  const purchases = [...diesel, ...loadsAsStationPurchases(loads, tankers)]
  const stationOut = stations.filter((s) => !s.isTanker).map((s) => {
    const rows = stationLedger(s.id, purchases, payments, to.slice(0, 7), openingOf(s))
    rows.forEach((r, i) => i && assert.equal(r.opening, rows[i - 1].closing, `${s.name} ${r.month} opens at the previous closing`))
    const exp = rec.stationLedger.find((x: { station: string }) => x.station === s.name)
    for (const m of rec.months as string[]) {
      const l = ledgerFor(rows, [m])
      const e = exp.months.find((x: { month: string }) => x.month === m)
      assert.deepEqual([l.opening, l.purchased, l.paid, l.closing], [e.opening, e.purchased, e.paid, e.closing], `${s.name} ${m} matches the preview`)
    }
    return { station: s.name, opening: s.openingBalance ?? null, closing: ledgerFor(rows).closing }
  })
  // Cash at pump is derived from the fill, never stored as a voucher, so it is counted once.
  assert.ok(!payments.some((p) => p.reference.startsWith("AUTO-CASH")), "no cash-at-pump voucher stored")
  // Monthly diesel totals equal the preview.
  for (const m of rec.months as string[]) {
    const e = diesel.filter((d) => d.date.startsWith(m))
    const expect = rec.customers.filter((c: { month: string }) => c.month === m)
    assert.equal(round2(e.reduce((t, d) => t + d.litres, 0)), round2(expect.reduce((t: number, c: { litres: number }) => t + c.litres, 0)), `${m} litres match the preview`)
    assert.equal(round2(e.reduce((t, d) => t + d.amount, 0)), round2(expect.reduce((t: number, c: { amount: number }) => t + c.amount, 0)), `${m} amount matches the preview`)
  }
  out.tanker = tankerOut
  out.stations = stationOut
  out.diesel = { fills: diesel.length, litres: round2(diesel.reduce((t, d) => t + d.litres, 0)), amount: round2(diesel.reduce((t, d) => t + d.amount, 0)) }
  writeFileSync(join(DIR, "test-import-result.json"), JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  console.log("clean test import: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
