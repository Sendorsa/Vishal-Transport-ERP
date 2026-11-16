/**
 * AdBlue vendor cutover report (offline, read-only):  npm run adblue:cutover -- <export.json>
 *
 * Reads a JSON export (Dev: Settings → Data → the read-only shared-database export, or a browser backup) and prints,
 * with the app's own calculation (src/domain/adblue-inventory.ts), what the AdBlue vendors section will show once
 * 20261116000000_adblue_vendors_owner_dev_delete.sql is applied: per vendor and for unattributed stock — purchased,
 * used, became unattributed, stock now — and, for every draw recorded before vendor tracking, where its litres came
 * from or why that is unknown. It links unlinked purchases by name exactly as the migration does. Writes nothing.
 * The export holds business data: keep it on this computer, never in the repository.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { inventoryLedger, NO_VENDOR, NO_VENDOR_LABEL, stockDraws, stockFor, valueInventory, vendorLedger } from "../src/domain/adblue-inventory"
import { formatINR, round2 } from "../src/lib/format"
import type { AdBlueEntry, AdBluePurchase, AdBlueVendor } from "../src/lib/types"

const path = process.argv[2]
if (!path) throw new Error("Usage: npm run adblue:cutover -- <export.json>")
const file = JSON.parse(readFileSync(path, "utf8"))
const c = (file.collections ?? file) as { adblue_purchases?: AdBluePurchase[]; adblue_entries?: AdBlueEntry[]; adblue_vendors?: AdBlueVendor[] }

const key = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase() // the migration's and the app's vendor key
const names = new Map<string, string>((c.adblue_vendors ?? []).map((v) => [v.id, v.name]))
const order = (a: AdBluePurchase, b: AdBluePurchase) => a.date.localeCompare(b.date) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)
const purchases = [...(c.adblue_purchases ?? [])].sort(order).map((p) => {
  if (p.opening || p.adblueVendorId) return p
  const k = key(p.vendorName ?? "")
  if (!k) throw new Error(`Purchase ${p.id} (${p.date}) has no vendor name: the migration stops until it is entered.`)
  const id = `name:${k}`
  if (!names.has(id)) names.set(id, p.vendorName.trim().replace(/\s+/g, " ")) // the earliest spelling names the vendor
  return { ...p, adblueVendorId: id }
})
const draws = stockDraws(c.adblue_entries ?? []).map((e) => ({ ...e, beforeVendorTracking: e.beforeVendorTracking ?? true }))
const nameOf = (k: string) => (k === NO_VENDOR ? NO_VENDOR_LABEL : (names.get(k) ?? k))

const v = valueInventory(purchases, draws)
if (v.shortfall) console.warn(`! The records already go below zero: ${v.shortfall.needed} L needed on ${v.shortfall.date}, ${v.shortfall.available} L available (entry ${v.shortfall.consumptionId}). Inspect before migrating.`)

const keys = [NO_VENDOR, ...names.keys()]
const rows = keys.map((k) => {
  const p = stockFor(vendorLedger(purchases, draws, k))
  const s = v.vendorStock.get(k) ?? { litres: 0, value: 0 }
  return { source: nameOf(k), purchased: round2(p.purchased + p.openingStock), used: p.consumed, unattributed: p.unattributed, stock: s.litres, value: s.value }
})
console.log(`\nAdBlue after the vendor cutover — ${purchases.length} purchases, ${draws.length} stock draws (${draws.filter((d) => d.beforeVendorTracking).length} recorded before vendor tracking)\n`)
console.table(rows.map((r) => ({ Source: r.source, "Purchased (L)": r.purchased, "Used (L)": r.used, "Became unattributed (L)": r.unattributed, "Stock now (L)": r.stock, "Stock value": formatINR(r.value) })))

// Reconciliation: Σ sources = company; every litre used once; relabelling nets to zero.
const sum = (f: (r: (typeof rows)[number]) => number) => round2(rows.reduce((t, r) => t + f(r), 0))
const company = stockFor(inventoryLedger(purchases, draws))
const purchasedTotal = round2(purchases.reduce((t, p) => t + p.totalLitres, 0))
const usedTotal = round2(draws.reduce((t, d) => t + d.quantityLitres, 0))
assert.equal(sum((r) => r.purchased), purchasedTotal, "Σ sources' purchases = company purchases")
assert.equal(sum((r) => r.unattributed), 0, "relabelled stock nets to zero")
if (!v.shortfall) {
  assert.equal(sum((r) => r.used), usedTotal, "every litre drawn is counted once")
  assert.equal(sum((r) => r.stock), v.stockLitres, "Σ sources' stock = company stock")
  assert.equal(v.stockLitres, round2(purchasedTotal - usedTotal), "company stock = purchased − used")
  assert.equal(company.closing, v.stockLitres, "the company ledger's closing = company stock")
  assert.equal(sum((r) => r.purchased), round2(company.purchased + company.openingStock), "Σ sources = the company ledger")
}
console.log(`Company stock: ${v.stockLitres} L worth ${formatINR(v.stockValue)} = Σ the rows above (reconciled).\n`)

// Each old draw: the source the records leave, or why it is unknown.
const old = draws.filter((d) => d.beforeVendorTracking && !d.adblueVendorId)
if (old.length) {
  console.log("Draws recorded before vendor tracking (no vendor recorded; never guessed):")
  console.table(
    old.map((d) => {
      const moved = v.moves.filter((m) => m.consumptionId === d.id)
      const took = [...new Set(v.takes.filter((t) => t.consumptionId === d.id).map((t) => nameOf(t.vendor)))]
      return {
        Date: d.date,
        Entry: d.id,
        Litres: d.quantityLitres,
        "Came from": moved.length ? NO_VENDOR_LABEL : took.join(", "),
        Why: moved.length ? `unknown: ${[...new Set(moved.map((m) => nameOf(m.vendor)))].join(", ")} held stock (and any unattributed stock) — all of it became unattributed` : "the only stock on hand then",
      }
    })
  )
}
