/**
 * Fuel import, step 2: turn the extracted source (import/fy2026-27/source/*.json, from extract.py) into ERP
 * records, validate them with the app's own business rules, reconcile them against the source totals, and
 * write a restorable file (Settings → Data → Restore from file).
 *
 *   npx tsx scripts/fuel-import/build.ts            # from prototype/
 *
 * Deterministic: the same source always gives the same ids and records, so re-importing never duplicates.
 * Nothing here writes to the browser or the source workbooks.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import "../../src/lib/api/test-browser"
import { inferAssignments, resolveCustomers } from "@/domain/assignments"
import { buildDieselIndex, statsOf } from "@/domain/diesel"
import { fyLabel } from "@/domain/pricing"
import { STATION_PAYMENT_CATEGORY, ledgerFor, openingOf, stationLedger } from "@/domain/station-ledger"
import { TANKER_SOURCE_ID, fillAmount, loadsAsStationPurchases, tankerLedger, tankerMoves, tankerPeriod, valueTankers } from "@/domain/tanker"
import { tdsDue } from "@/domain/station-ledger"
import { round2 } from "@/lib/format"
import { DEFAULT_FUEL_STATIONS, DEFAULT_SETTINGS } from "@/lib/storage/seed"
import { SCHEMA_VERSION } from "@/lib/storage/local-store"
import type { BackupFile } from "@/lib/api/bootstrap"
import type { BusinessUnit, Customer, DieselEntry, FuelStation, Payment, PaymentMode, Tanker, TankerDispense, TankerLoad, Vehicle, VehicleAssignment } from "@/lib/types"

const ROOT = join(__dirname, "..", "..", "..")
/** Extracted source (extract.py output): the FY import's by default, or VT_SRC_DIR (e.g. import/test-sep-oct-2026/source). */
const SRC = join(ROOT, process.env.VT_SRC_DIR ?? join("import", "fy2026-27", "source"))
/** Output folder: the published import (default), or a dry run elsewhere (`--out=<dir>`) so nothing published changes. */
const OUT_ARG = (process.argv.find((a) => a.startsWith("--out=")) ?? "").split("=")[1]
const DIR = OUT_ARG ? OUT_ARG : join(ROOT, "import", "fy2026-27")
/**
 * Test import window (VT_EMIT_FROM, e.g. 2026-09-01): the whole FY is still read and checked, so the months before
 * the window can be used to *calculate* opening balances — but only records dated from VT_EMIT_FROM are written.
 */
const EMIT_FROM = process.env.VT_EMIT_FROM ?? null
const FY_FROM = "2026-04-01"
const FY_TO = "2027-03-31"
/** The day this import was prepared; source rows dated after it are typos (quarantined). The import's actual cutoff is the latest real source date (computed below). */
const RUN_DATE = process.env.VT_RUN_DATE ?? "2026-10-14"
const TODAY = RUN_DATE
/** Undated money rows (TDS, a few payments): "month-end" (owner's decision: dated the last day of their sheet's month, flagged) or "exclude". */
const UNDATED = (process.argv.find((a) => a.startsWith("--undated-payments=")) ?? "").split("=")[1] === "exclude" ? "exclude" : "month-end"

const load = <T>(f: string): T => JSON.parse(readFileSync(join(SRC, f), "utf8"))
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12)
const isReg = (s: string) => /^(KA|TN)\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(s)
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0)
const monthEnd = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10)

/* ------------------------------------------------------------------ source shapes (extract.py) */
interface Fill {
  src: string; file: string; sheet: string; row: number; block: string | null; customer: string | null; indent: unknown; dateRaw: string | null; date: string | null
  vehicleRaw: unknown; vehicle: string; driver: unknown; slot: unknown; litres: number; amount: number | null; amountFormula: string | null; rate: number | null
  openKm: number | null; closeKm: number | null
}
interface BookRow {
  month: string; station: string; src: string; row: number; kind: "ROW" | "TOTAL"; indent?: unknown; dateRaw?: string | null; date?: string | null; vehicleRaw?: unknown; vehicle?: string
  qty: number | null; rate?: number | null; amt: number | null; pay: number | null; payDateRaw?: string | null; payDate?: string | null; note?: unknown; excluded?: string | null
}
const fills = load<Fill[]>("consumption.json")
const blockTotals = load<{ file: string; sheet: string; row: number; block: string | null; litres: number; amount: number | null }[]>("consumption_totals.json")
const book = load<BookRow[]>("purchase_book.json")
const summaries = load<{ month: string; src: string; label: string; company?: string; bunk?: string; litres?: number; amount?: number; values?: unknown[] }[]>("purchase_summaries.json")
const yearly = load<{ src: string; month: string; litres: number | null; amount: number | null; paid: number | null; outstanding: number | null }[]>("purchase_yearly.json")
const aliases = new Map(load<{ from: string; to: string; src: string }[]>("aliases.json").map((a) => [a.from, a]))
// extract.py reads each purchase-book block only down to its TOTAL row. Every Sep/Oct date on the JULY–OCT sheets was
// checked cell by cell on 15 Oct 2026: this is the one payment written below a block's TOTAL (AUG 2026 AE36:AG36).
book.push({ month: "AUG 2026", station: "Raghuveer Fuels", src: "Diesel Data/2026-2027/ Total Diesel Value 2026-2027.xlsx › AUG 2026 › Raghuveer Fuels (columns AE…) › row 36", row: 36, kind: "ROW",
  vehicleRaw: "PAYMENT PAID", vehicle: "", qty: null, amt: null, pay: 150000, payDateRaw: "03.09.2026", payDate: "2026-09-03", note: null, excluded: null })

const MONTH_OF: Record<string, string> = { "APRIL 2026": "2026-04", "MAY 2026": "2026-05", "JUNE 2026": "2026-06", "JULY 2026": "2026-07", "AUG 2026": "2026-08", "SEP  2026": "2026-09", "OCT 2026": "2026-10" }

/* ------------------------------------------------------------------ uncle's answers (issues.md, review of 13 Oct 2026) */
// Each rule names the answer it applies and is matched by the row's CONTENT (book, sheet, date, vehicle, litres, indent),
// never by row number: rows move when the Excel is edited (e.g. a deleted duplicate shifts every row below it).
const BOOK = {
  dhoot: "Diesel Data/2026-2027/HOSUR DETAILS/ DHOOT   Buses Diesel details 2026-2027 .xlsx",
  hosurBuses: "Diesel Data/2026-2027/HOSUR DETAILS/ Hosur  Buses Diesel details 2026-2027.xlsx",
  goods: "Diesel Data/2026-2027/GOODS DIESEL DETAILS/HOSUR GOODS Vehicles Diesel details 2026-2027 xlsx.xlsx",
  tata: "Diesel Data/2026-2027/HOSUR DETAILS/ Tata Electronics Diesel 2026-2027.xlsx",
  cabs: "Diesel Data/2026-2027/HOSUR DETAILS/ Vishal  Cabs Diesel details 2026-2027.xlsx",
  jbm: "Diesel Data/2026-2027/BIDADI JBM DETAILS 2027/ JBM P1 2026-2027.xlsx_",
}
/** A fill's content: book, sheet, date, vehicle as written (letters and digits), litres, indent. */
type Sig = [file: string, sheet: string, date: string, vehicle: string, litres: number, indent: string]
const indentText = (x: unknown) => String(x ?? "").replace(/\.0$/, "").replace(/\s+/g, " ").trim().toUpperCase()
/** Vehicle as written, letters and digits only ("TN.70 AX 9480" → TN70AX9480; 5763.0 → 5763). */
const vehText = (v: unknown) => (typeof v === "number" ? String(Math.trunc(v)) : String(v ?? "")).toUpperCase().replace(/[^A-Z0-9]/g, "")
const sigOf = (f: { file: string; sheet: string; date: string | null; vehicleRaw: unknown; litres: number; indent: unknown }) =>
  [f.file, f.sheet, f.date ?? "", vehText(f.vehicleRaw), round2(f.litres), indentText(f.indent)].join("|")
const sig = (...x: Sig) => [x[0], x[1], x[2], vehText(x[3]), round2(x[4]), indentText(x[5])].join("|")
/**
 * Confirmed duplicates — the same real fill written twice (A-3, A-4 pairs 1, 3, 6). `drop` is left out only while `keep` is
 * still in the Excel; when both are the same content, only a second identical row is left out. If the Excel has already
 * been corrected (one copy left), nothing is dropped.
 */
const CONFIRMED_DUPLICATES: { drop: string; keep: string; answer: string }[] = [
  { drop: sig(BOOK.tata, "D100", "2026-08-04", "KA51AM1678", 129.81, "CARD SWIPE"), keep: sig(BOOK.jbm, "KA51AM1678", "2026-08-04", "KA51AM1678", 129.81, "20099"), answer: "A-3: a single fill, operated for JBM" },
  { drop: sig(BOOK.goods, "OUTSIDEVEHICLE", "2026-09-21", "KA51AK8225", 37.64, "5442"), keep: sig(BOOK.goods, "KA51AK8225", "2026-09-21", "KA51AK8225", 37.64, "5442"), answer: "A-4 pair 1: same filling" },
  { drop: sig(BOOK.goods, "OUTSIDEVEHICLE", "2026-05-30", "KA51AM4192", 34.42, "2501"), keep: sig(BOOK.goods, "OUTSIDEVEHICLE", "2026-05-30", "KA51AM4192", 34.42, "2501"), answer: "A-4 pair 3: same filling, a duplicate" },
  { drop: sig(BOOK.cabs, "KA05MV5115", "2026-06-08", "KA04NC5115", 43.57, "CARD SWIPE"), keep: sig(BOOK.cabs, "KA05MV5115", "2026-06-08", "KA04NC5115", 43.57, "CARD SWIPE"), answer: "A-4 pair 6: duplicate entry" },
]
/** Confirmed genuine separate fills (kept, both rows) — A-2 and A-4 pair 2. */
const CONFIRMED_SEPARATE = new Map([
  [sig(BOOK.dhoot, "TN70AM6132", "2026-04-23", "TN70AM6132", 139.65, "MINI TANK"), "A-2: different entries (also in the Hosur Buses book)"],
  [sig(BOOK.hosurBuses, "TN70AM6132", "2026-04-23", "TN70AM6132", 139.65, "MINI TANK"), "A-2: different entries (also in the DHOOT book)"],
  [sig(BOOK.goods, "OUTSIDEVEHICLE", "2026-04-14", "KA51AM4192", 35.12, "2176"), "A-4 pair 2: different filling"],
  [sig(BOOK.goods, "OUTSIDEVEHICLE", "2026-04-14", "KA51AM4192", 35.12, "2214"), "A-4 pair 2: different filling"],
])
/** A-4 pairs 4 and 5: "wrong date" — both fills are real; flagged only while the two rows still carry the same date. */
const WRONG_DATE_PENDING = [
  { sig: sig(BOOK.tata, "D66", "2026-06-23", "TN70AW7408", 100, "NEW TANK"), pair: "A-4 pair 4" },
  { sig: sig(BOOK.tata, "D69", "2026-09-04", "TN70AW7441", 100, "NEW TANK"), pair: "A-4 pair 5" },
]
/** A-5: diesel for the generator, the bunk, cans and MJ Casting construction — Jio Bunk bears the cost (Hosur Goods › OUTSIDEVEHICLE). */
const JIO_BUNK_FILLS = new Set(
  ([["2026-04-02", "CAN", 31.79, "1926"], ["2026-04-12", "NEW BUNK", 5, "MINI TANK"], ["2026-04-21", "JANERATOR", 25.28, "MINI TANK"], ["2026-05-13", "BUNK", 5, "MINI TANK"],
    ["2026-06-14", "JANRETAR", 550.4, "MINI TANK"], ["2026-06-16", "JANRETAR", 550, "MINI TANK"], ["2026-06-17", "BUNK", 29.54, "MINI TANK"],
    ["2026-06-19", "MJ CASTING construction PURPOSE", 5.01, "MNII TANK"], ["2026-07-09", "JIO BUNK", 33.12, "MINI TANK"], ["2026-08-19", "JIO BUNK DG", 10, "MINI TANK"]] as const)
    .map(([d, v, l, i]) => sig(BOOK.goods, "OUTSIDEVEHICLE", d, v, l, i))
)
const JIO_BUNK_VEHICLE = "JIO BUNK (non-vehicle use)"
/** A-6: KA51MW5115 is a personal vehicle used by the owner (purchase book, JULY 2026, Vishal Gasoline block). */
const OWNER_PERSONAL = new Map([["KA51MW5115", "A-6: personal vehicle used by the owner"]])
/** The three diesel tankers (answer 24; names given by the owner on 15 Oct 2026). `V-9480` / `V-0538` / `V-1429` in INDENT NO name them. */
const TANKER_MASTER = [
  { id: "tnk_tn70ax9480", name: "JIO", regNo: "TN70AX9480" },
  { id: "tnk_ka53c0538", name: "Office", regNo: "KA53C0538" },
  { id: "tnk_ka51af1429", name: "Mini", regNo: "KA51AF1429" },
]
/** INDENT NO "V-0538" (also "V - 0538") = the tanker whose registration ends in those 4 digits. */
const tankerFromLabel = (x: unknown) => {
  const m = indentText(x).match(/^V\s*-\s*(\d{4})$/)
  return m ? (TANKER_MASTER.find((t) => t.regNo.endsWith(m[1])) ?? null) : null
}
/** S-04 (uncle, 15 Oct 2026): NEW TANK = JIO, MINI TANK = Mini, OFFICE TANK = Office. No other label is mapped. */
const TANK_LABELS: Record<string, string> = { "NEW TANK": "TN70AX9480", "MINI TANK": "KA51AF1429", "OFFICE TANK": "KA53C0538" }
/** The tanker a tank fill came from, and on what basis: the uncle's answer, or the registration digits in the label (an inference). */
const tankerOfLabel = (x: unknown) => {
  const reg = TANK_LABELS[indentText(x)]
  if (reg) return { ...TANKER_MASTER.find((t) => t.regNo === reg)!, basis: "S-04" }
  const t = tankerFromLabel(x)
  return t ? { ...t, basis: "registration digits in the label (inference)" } : null
}
/** S-03 (uncle, 15 Oct 2026): litres in each tanker on the morning of 1 Sep 2026 (JIO = "TATA TANK" in AUG 2026 R66, Office = R67). */
const OPENING_STOCK = { from: "2026-09-01", litres: { TN70AX9480: 4094, KA53C0538: 142, KA51AF1429: 0 } as Record<string, number> }

/* ------------------------------------------------------------------ report collector */
type Issue = { severity: "excluded" | "unresolved" | "flag" | "discrepancy"; topic: string; src: string; detail: string }
const issues: Issue[] = []
/** Every value the import changed from the source, with the rule (uncle's answer) that changed it. */
const corrections: { src: string; rule: string; field: string; before: unknown; after: unknown }[] = []
const note = (severity: Issue["severity"], topic: string, src: string, detail: string) => issues.push({ severity, topic, src, detail })

/* ------------------------------------------------------------------ masters: stations */
const at = "2026-04-01T00:00:00.000Z"
const STATION_IDS: Record<string, string> = {
  "Vishal Gasoline": "dv_vishal", "Shree Shankara": "dv_shankara", "Mahadeshwara Agencies": "dv_mahadeshwara", "Raghuveer Fuels": "dv_raghuveer",
  "Lakshmitha Fuels": "dv_lakshmitha", "JP Brother Indian Oil": "dv_jpbros", "Shrudu Fuel Station": "dv_shrudu", "Aries Gemini Energy": "dv_aries",
  "Samruddhi Fuels": "dv_samruddhi", "Paravathi Fuels": "dv_paravathi", MRPL: "dv_mrpl", GNM: "dv_gnm",
  "Card / cash (pump not recorded)": "dv_card_cash", "Pump not identified": "dv_unidentified",
}
const stations = new Map<string, FuelStation>()
const station = (name: string) => {
  const id = STATION_IDS[name]
  if (!stations.has(id)) {
    const known = DEFAULT_FUEL_STATIONS.find((s) => s.id === id)
    // Name as written in the source; location not in the fuel books (left blank, not the demo value).
    stations.set(id, { id, name, location: "", isInterCompany: id === "dv_vishal", creditDays: known?.creditDays ?? 30, status: "ACTIVE", createdAt: at, updatedAt: at })
  }
  return id
}
stations.set(TANKER_SOURCE_ID, DEFAULT_FUEL_STATIONS.find((s) => s.id === TANKER_SOURCE_ID)!)

/* ------------------------------------------------------------------ consumption: FY rows, cross-file copies removed */
const inFY = (d: string | null) => !!d && d >= FY_FROM && d <= FY_TO
const fyFills: Fill[] = []
/** Rows dated before 1 April 2026, per workbook — earlier financial years, not part of this import (summarised, not listed one by one). */
const excludedBefore = new Map<string, { rows: number; litres: number }>()
const seen = new Map<string, Fill>()
// Confirmed duplicates still present in the Excel → the rows to leave out (see CONFIRMED_DUPLICATES).
const dropDuplicate = new Map<string, { answer: string; keep: string }>()
const duplicateStatus: { answer: string; status: string }[] = []
{
  const bySig = new Map<string, Fill[]>()
  for (const f of fills) bySig.set(sigOf(f), [...(bySig.get(sigOf(f)) ?? []), f])
  for (const r of CONFIRMED_DUPLICATES) {
    const drops = bySig.get(r.drop) ?? []
    const keeps = bySig.get(r.keep) ?? []
    const out = r.drop === r.keep ? drops.slice(1) : keeps.length ? drops : []
    const kept = r.drop === r.keep ? drops[0] : keeps[0]
    for (const f of out) dropDuplicate.set(f.src, { answer: r.answer, keep: kept.src })
    duplicateStatus.push({ answer: r.answer, status: out.length ? `applied: ${out.map((f) => f.src).join("; ")} left out, ${kept.src} kept` : drops.length || keeps.length ? "already corrected in the Excel — only one copy is there now" : "neither row is in the Excel any more" })
  }
}
const wrongDateCount = new Map(WRONG_DATE_PENDING.map((w) => [w.sig, fills.filter((f) => sigOf(f) === w.sig).length]))
for (const f of fills) {
  if (!f.date) {
    if (/2026|2027/.test(String(f.block)) && /(APR|MAY|JUN|JUL|AUG|SEP|OCT)\S*-2026/.test(String(f.block))) note("unresolved", "Fill without a date", f.src, `${f.litres} L in block ${f.block}; date cell ${JSON.stringify(f.dateRaw)}`)
    continue
  }
  if (!inFY(f.date)) {
    const s = (excludedBefore.get(f.file) ?? { rows: 0, litres: 0 })
    if (f.date < FY_FROM) excludedBefore.set(f.file, { rows: s.rows + 1, litres: round2(s.litres + f.litres) })
    else note("unresolved", "Date after FY 2026-27 (quarantined)", f.src, `dated ${f.date} under heading ${f.block} — a typo; the real date isn't in the source, so the row is held back (${f.litres} L)`)
    continue
  }
  if (f.date > TODAY) {
    note("unresolved", "Future-dated fill (quarantined)", f.src, `dated ${f.date} — a typo; the real date isn't in the source, so the row is held back`)
    continue
  }
  const dup = dropDuplicate.get(f.src)
  if (dup) {
    note("excluded", "Confirmed duplicate (uncle's answer)", f.src, `${dup.answer} — same fill as ${dup.keep}; counted once (${f.litres} L, ₹${f.amount ?? 0} left out)`)
    corrections.push({ src: f.src, rule: dup.answer, field: "row", before: `${f.litres} L on ${f.date}`, after: "not imported (duplicate)" })
    continue
  }
  // A-1: the vehicle column holds only the last digits ("5763") — the sheet name has the full registration.
  const digits = String(f.vehicleRaw ?? "").replace(/\.0$/, "").trim()
  if (/^\d{4}$/.test(digits) && isReg(f.sheet) && f.sheet.endsWith(digits) && f.vehicle !== f.sheet) {
    note("flag", "Short registration mapped to the sheet's vehicle (A-1)", f.src, `"${digits}" → ${f.sheet}; uncle confirmed it ran for ${f.customer}`)
    corrections.push({ src: f.src, rule: "A-1: TN70AU5763 / TN70AU5796 ran for DTPL", field: "vehicle", before: digits, after: f.sheet })
    f.vehicle = f.sheet
  }
  const v = aliases.get(f.vehicle)?.to ?? f.vehicle
  const key = [v, f.date, round2(f.litres), f.openKm, f.closeKm].join("|")
  const twin = seen.get(key)
  // Only copies in a DIFFERENT workbook are duplicates; repeated rows inside one book may be real fills.
  // Kept and flagged, never dropped by guess: only the uncle's confirmed duplicates are left out (CONFIRMED_DUPLICATES).
  if (twin && twin.file !== f.file)
    note("unresolved", "Possible duplicate (same fill in another workbook) — both kept", f.src, `same vehicle, date, litres and both odometers as ${twin.src}; both are imported until the uncle confirms whether it is one fill`)
  seen.set(key, f)
  fyFills.push(f)
}

/* ------------------------------------------------------------------ source kind of each fill (INDENT NO column) */
type Kind = "TANK" | "INDENT" | "NO INDENT" | "CARD SWIPE" | "CASH" | "SHRUDHU" | "LAKSHMITHA" | "RVF" | "MRPL" | "GNM" | "FLEET" | "BLANK" | "OTHER"
const kindOf = (x: unknown): Kind => {
  const s = String(x ?? "").toUpperCase().replace(/\s+/g, " ").trim()
  if (!s) return "BLANK"
  if (/^[\d./ ]+$/.test(s)) return "INDENT"
  if (/TANK/.test(s.replace("TANKAR", "TANK")) || tankerFromLabel(s)) return "TANK"
  if (s === "NO INDENT") return "NO INDENT"
  if (/CARD|SWIPE/.test(s)) return "CARD SWIPE"
  if (/CASH|PHONE ?PE/.test(s)) return "CASH"
  if (["SHRUDHU", "RVF", "MRPL", "GNM", "FLEET"].includes(s)) return s as Kind
  if (s === "LAKSMITHA FUEL") return "LAKSHMITHA"
  return "OTHER"
}

/* ------------------------------------------------------------------ pump identification: (month, rate) → station from the purchase book's bills */
const TANKERS = new Set(["TN70AX9480", "KA53C0538", "KA51AF1429"])
const billRows = book.filter((r) => r.kind === "ROW" && r.qty && !r.excluded && !TANKERS.has(r.vehicle ?? "") && r.rate)
const rateStations = new Map<string, Set<string>>()
for (const r of billRows) {
  const k = `${MONTH_OF[r.month]}|${round2(r.rate!)}`
  rateStations.set(k, new Set([...(rateStations.get(k) ?? []), r.station]))
}
// Paravathi Fuels (Bidadi) has no block, only a summary line (litres, amount) — its rate is amount ÷ litres.
for (const s of summaries) {
  const [litres, amount] = (s.values ?? []) as number[]
  if (s.label === "BUNK" && /^PARAVATHI/.test(s.bunk ?? "") && litres && amount) {
    const k = `${MONTH_OF[s.month]}|${round2(amount / litres)}`
    rateStations.set(k, new Set([...(rateStations.get(k) ?? []), "Paravathi Fuels"]))
  }
}
const prevMonth = (ym: string) => (ym.endsWith("-01") ? `${Number(ym.slice(0, 4)) - 1}-12` : `${ym.slice(0, 5)}${String(Number(ym.slice(5)) - 1).padStart(2, "0")}`)
const vehicleRows = new Map<string, BookRow>() // individual vehicle fills written in the purchase book
for (const r of billRows) if (r.date && r.vehicle && isReg(r.vehicle)) vehicleRows.set(`${r.vehicle}|${r.date}|${round2(r.qty!)}`, r)
const matchedBookRows = new Set<string>()

function pumpOf(f: Fill, kind: Kind, rate: number | null): { stationId: string; mode: "CREDIT" | "CASH"; how: string } {
  const v = aliases.get(f.vehicle)?.to ?? f.vehicle
  const direct = vehicleRows.get(`${v}|${f.date}|${round2(f.litres)}`)
  if (direct) {
    matchedBookRows.add(direct.src)
    return { stationId: station(direct.station), mode: "CREDIT", how: `vehicle row in purchase book (${direct.src})` }
  }
  if (kind === "SHRUDHU") return { stationId: station("Shrudu Fuel Station"), mode: "CREDIT", how: "INDENT column says SHRUDHU" }
  if (kind === "LAKSHMITHA") return { stationId: station("Lakshmitha Fuels"), mode: "CREDIT", how: "INDENT column says LAKSMITHA FUEL" }
  if (kind === "MRPL" || kind === "GNM") return { stationId: station(kind), mode: "CREDIT", how: `INDENT column says ${kind}` }
  const cands = rate ? rateStations.get(`${f.date!.slice(0, 7)}|${round2(rate)}`) : undefined
  if (cands?.size === 1) return { stationId: station([...cands][0]), mode: "CREDIT", how: `rate ₹${rate} matches only ${[...cands][0]}'s bills that month` }
  // October's book has no bills yet for some pumps: the rate the same pump billed the month before.
  const prior = !cands && rate ? rateStations.get(`${prevMonth(f.date!.slice(0, 7))}|${round2(rate)}`) : undefined
  if (prior?.size === 1 && kind !== "CASH") {
    note("flag", "Pump from previous month's rate", f.src, `${f.litres} L @ ₹${rate} → ${[...prior][0]} (no bill at this rate in ${f.date!.slice(0, 7)})`)
    return { stationId: station([...prior][0]), mode: "CREDIT", how: `rate ₹${rate} matches only ${[...prior][0]}'s bills the month before` }
  }
  if (kind === "CASH") return { stationId: station("Card / cash (pump not recorded)"), mode: "CASH", how: "paid in cash / PhonePe; pump not recorded" }
  if (kind === "CARD SWIPE") return { stationId: station("Card / cash (pump not recorded)"), mode: "CASH", how: "card swipe; pump not recorded and no matching bill" }
  return { stationId: station("Pump not identified"), mode: "CREDIT", how: cands ? `rate ₹${rate} matches several stations (${[...cands].join(", ")})` : `no purchase-book bill at ₹${rate ?? "?"} that month` }
}

/* ------------------------------------------------------------------ masters: customers (one per consumption book family) */
const UNIT: Record<string, BusinessUnit> = { "HOSUR GOODS": "GOODS", HAROHALLI: "GOODS", CARS: "TAXI", "TITAN CABS": "TAXI", SCHOOL: "SCHOOL_BUS", "JIO BUNK": "FUEL_RETAIL", "OWNER PERSONAL": "INTERNAL" }
const customerName: Record<string, string> = {
  TEPL: "TEPL (Tata Electronics)", "TEPS (JASMIN)": "TEPS (Jasmine Plant)", "HOSUR GOODS": "Hosur Goods", CARS: "Vishal Cabs", TITAN: "TEAL-2",
  "TITAN CABS": "Titan Cabs", DTPL: "DTPL (Dhoot)", SCHOOL: "School", AVTEC: "AVTEC", "MINDA SEATING": "Minda Seating Division", "MINDA SWITCH": "Minda Switch Division",
  LUMINOUS: "Luminous", "MINDA CASTING": "MJ Casting", JAMNA: "Jamna", "MINDA RINDER": "Minda Rinder", "BIDADI VECHILE": "JBM (Bidadi)", "HOSUR BUSES": "Hosur Buses", HAROHALLI: "Harohalli",
  "JIO BUNK": "Jio Bunk", "OWNER PERSONAL": "Owner (personal use)",
}
const customers = new Map<string, Customer>()
const customerOf = (code: string) => {
  const id = `cus_${hash(code)}`
  if (!customers.has(id))
    customers.set(id, {
      id, code: code.replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""), shortName: customerName[code] ?? code, name: customerName[code] ?? code, legalName: "",
      companyCode: "VT", businessUnit: UNIT[code] ?? "STAFF_BUS", gstin: "", state: "", stateCode: "", city: "", contactName: "", phone: "", email: "", creditDays: 0,
      pricing: { model: "PER_TRIP", rate: 0, includedKm: 0, extraKmRate: 0, driverBata: 0, routes: [] },
      status: "ACTIVE", statusHistory: [{ status: "ACTIVE", startDate: FY_FROM, endDate: null }],
      notes: code === "JIO BUNK" ? "Fuel book: JIO BUNK. Cost bearer for generator / bunk / can / MJ Casting construction diesel taken from Hosur Goods (uncle's answer A-5). Not a transport customer."
        : code === "OWNER PERSONAL" ? "Fuel book: OWNER PERSONAL. Fuel for the owner's personal vehicle KA51MW5115 (uncle's answer A-6). Not a transport customer."
        : `Fuel book: ${code}. Created by the fuel import; customer details are not in the fuel books.`,
      createdAt: at, updatedAt: at,
    })
  return id
}

/* ------------------------------------------------------------------ tankers (answer 24: three diesel tankers) */
// The three tankers (TANKER_MASTER): JIO TN70AX9480, Office KA53C0538, Mini KA51AF1429 — the vehicles diesel is loaded
// into in the purchase book. Most diesel-book fills name their tank only as MINI TANK / NEW TANK / OFFICE TANK, which the
// source does not tie to a tanker (only "V-9480" / "V-0538" / "V-1429" do), so loads and fills stay in one combined stock
// — never guessed onto a tanker. Each record notes its tanker (V-labels; and S-04, see TANK_LABELS). The test window splits
// the stock by tanker only when the split never goes below zero (emitWindow).
// Splitting the stock needs the uncle's mapping and dip readings; it is then a transfer from the combined stock.
const COMBINED = EMIT_FROM ? "tnk_unallocated" : "tnk_combined_fy2627"
const tankerRecords: Tanker[] = [
  { id: COMBINED, name: EMIT_FROM ? "Unallocated stock (JIO + Office + Mini)" : "Combined tank stock (not yet split)", regNo: "", vehicleId: null, capacityLitres: null, status: "ACTIVE", createdAt: at, updatedAt: at,
    notes: "Tanker loads and tank fills whose tanker the books don't establish (MINI / NEW / OFFICE TANK), kept as one stock — never split by guess. Each record notes the tanker the source does name. Split with transfers once the uncle confirms which label is which tanker." },
  ...TANKER_MASTER.map((t): Tanker => ({ id: t.id, name: t.name, regNo: t.regNo, vehicleId: null, capacityLitres: null, status: "ACTIVE", createdAt: at, updatedAt: at,
    notes: `${t.name} — registration ${t.regNo} (owner, 15 Oct 2026). Diesel is loaded into this vehicle in the purchase book. Its own stock starts once the combined stock is split. Capacity not in the source.` })),
]
const tankerByReg = (reg: string) => TANKER_MASTER.find((t) => t.regNo === reg)

/* ------------------------------------------------------------------ build diesel entries + external tanker dispenses */
const vehicleIds = new Map<string, string>()
const vehicleId = (regNo: string) => {
  if (!vehicleIds.has(regNo)) vehicleIds.set(regNo, `veh_${hash(regNo)}`)
  return vehicleIds.get(regNo)!
}
const diesel: (DieselEntry & { __src: Fill; __how: string; __srcAmount: number | null })[] = []
const external: (TankerDispense & { __src: Fill })[] = []
let seq = 0
const created = (date: string) => `${date}T00:00:${String(Math.floor(seq / 1000) % 60).padStart(2, "0")}.${String(seq++ % 1000).padStart(3, "0")}Z`
const driverOf = new Map<string, Map<string, number>>()

for (const f of fyFills) {
  const kind = kindOf(f.indent)
  // A-5: Jio Bunk bears the cost — booked to the Jio Bunk cost bearer, on a placeholder "vehicle" for these uses.
  if (JIO_BUNK_FILLS.has(sigOf(f))) {
    corrections.push({ src: f.src, rule: "A-5: Jio Bunk bears the cost", field: "customer / vehicle", before: `${f.customer} / "${f.vehicleRaw}"`, after: `Jio Bunk / ${JIO_BUNK_VEHICLE}` })
    note("flag", "Charged to Jio Bunk (A-5)", f.src, `"${f.vehicleRaw}" ${f.litres} L from ${String(f.indent)} — moved out of Hosur Goods`)
    f.customer = "JIO BUNK"
    f.vehicle = JIO_BUNK_VEHICLE
  }
  const v = aliases.get(f.vehicle)?.to ?? f.vehicle
  if (aliases.has(f.vehicle)) note("flag", "Re-registered vehicle", f.src, `${f.vehicle} recorded under its new registration ${v} (${aliases.get(f.vehicle)!.src})`)
  if (!isReg(v) && v !== JIO_BUNK_VEHICLE) {
    if (kind === "TANK") {
      external.push({ id: `tkd_${hash(f.src)}`, tankerId: COMBINED, date: f.date!, vehicleNo: String(f.vehicleRaw ?? "").trim(), litres: f.litres, notes: `From ${f.customer} fuel book · ${f.src}`, createdAt: created(f.date!), updatedAt: created(f.date!), __src: f })
      note("flag", "Non-vehicle tank use → external dispense", f.src, `"${f.vehicleRaw}" ${f.litres} L from ${String(f.indent)}`)
    } else note("excluded", "Non-vehicle pump fill", f.src, `"${f.vehicleRaw}" ${f.litres} L (${String(f.indent)}): not a registered vehicle and not from the tanker, so the ERP has no record type for it`)
    continue
  }
  if (!f.customer) {
    note("unresolved", "Workbook without a customer", f.src, "")
    continue
  }
  // A-6: KA51MW5115 is the owner's personal vehicle — its fuel goes under "Owner (personal use)", not the book's customer.
  if (OWNER_PERSONAL.has(v) && f.customer !== "OWNER PERSONAL") {
    corrections.push({ src: f.src, rule: OWNER_PERSONAL.get(v)!, field: "customer", before: f.customer, after: "Owner (personal use)" })
    note("flag", "Owner's personal vehicle (A-6)", f.src, `${v} ${f.litres} L — moved from ${f.customer} to "Owner (personal use)"`)
    f.customer = "OWNER PERSONAL"
  }
  const rate = f.rate ?? (f.amount != null && f.litres ? f.amount / f.litres : null)
  // A-22: a CASH fill whose AMOUNT is a typed 0 (no formula, no rate) — the quantity is set to 0 as instructed.
  let litres = f.litres
  if (kind === "CASH" && f.amount === 0 && !f.amountFormula && f.rate == null) {
    corrections.push({ src: f.src, rule: "Answer 22: zero-amount cash fill → quantity 0", field: "litres", before: f.litres, after: 0 })
    note("flag", "Zero-amount cash fill: quantity set to 0 (answer 22)", f.src, `${f.litres} L recorded, AMOUNT a typed 0 → imported as 0 L, ₹0.00 (original litres kept in mapping.json)`)
    litres = 0
  }
  const wrongDate = WRONG_DATE_PENDING.find((w) => w.sig === sigOf(f))
  if (wrongDate && (wrongDateCount.get(wrongDate.sig) ?? 0) > 1) note("unresolved", "Wrong date — correct date not known (A-4)", f.src, `${wrongDate.pair}: uncle says one of the pair has the wrong date; kept as ${f.date} (both real fills) until the right date is given`)
  if (CONFIRMED_SEPARATE.has(sigOf(f))) note("flag", "Confirmed separate fill", f.src, CONFIRMED_SEPARATE.get(sigOf(f))!)
  if (f.closeKm == null) note("flag", "No odometer", f.src, `CLOSE KM empty (OPEN KM ${f.openKm ?? "empty"}) — stored without an odometer; KM Run skips this gap`)
  const base = {
    id: `dsl_${hash(f.src)}`, createdAt: created(f.date!), updatedAt: created(f.date!), companyCode: "VT" as const, date: f.date!, vehicleId: vehicleId(v), customerId: customerOf(f.customer),
    litres, odometerKm: f.closeKm ?? null, billNo: f.indent == null ? "" : String(f.indent).trim(),
    notes: [f.driver ? `Driver ${String(f.driver).trim()}` : null, aliases.has(f.vehicle) ? `Recorded as ${f.vehicle}` : null].filter(Boolean).join(" · ") || undefined,
  }
  if (f.driver) {
    const m = driverOf.get(v) ?? new Map()
    m.set(String(f.driver).trim(), (m.get(String(f.driver).trim()) ?? 0) + 1)
    driverOf.set(v, m)
  }
  // FLEET: a pump fill when the purchase book bills this vehicle on that day (e.g. KA51MW5115, Vishal Gasoline JULY row 38); otherwise tanker.
  const billed = kind === "FLEET" ? vehicleRows.get(`${v}|${f.date}|${round2(f.litres)}`) : undefined
  if (kind === "TANK" || (kind === "FLEET" && !billed)) {
    if (kind === "FLEET") note("flag", "FLEET fill treated as tanker", f.src, "INDENT column says FLEET (the purchase book uses FLEET for tanker loads)")
    // Answer 23: a tank fill is costed at the rate written in its own AMOUNT formula (=G12*90.99), never at an average.
    const tr = rate ? round2(rate) : 0
    if (!tr) note("unresolved", "Tank fill without a rate", f.src, `${f.litres} L, AMOUNT ${JSON.stringify(f.amount)} — no rate in the source; costed at the tanker's weighted average until the rate is known`)
    const amount = round2(litres * tr)
    if (f.amount != null && tr && Math.abs(amount - round2(f.amount)) > 0.01) note("discrepancy", "Tank fill: litres × rate ≠ saved amount", f.src, `litres × ₹${tr} = ₹${amount}; the workbook shows ₹${round2(f.amount)}`)
    const named = tankerOfLabel(f.indent)
    if (named?.basis !== "S-04" && named) note("flag", `Tank fill names its tanker (${indentText(f.indent)} = ${named.name})`, f.src, `${litres} L from ${named.name} (${named.regNo}) — ${named.basis}`)
    diesel.push({ ...base, notes: [base.notes, named ? `From tanker ${named.name} (${named.regNo}) — INDENT NO ${indentText(f.indent)} (${named.basis === "S-04" ? "uncle's answer S-04" : named.basis})` : null].filter(Boolean).join(" · ") || undefined,
      vendorId: TANKER_SOURCE_ID, tankerId: COMBINED, rate: tr, amount, paymentMode: "CREDIT", __src: f, __how: `company tank (${String(f.indent).trim()}) — rate from the source formula`, __srcAmount: f.amount })
    continue
  }
  if (!rate && litres) note("unresolved", "Fill without a rate or amount", f.src, `${f.litres} L, AMOUNT ${JSON.stringify(f.amount)} — imported at ₹0.00`)
  const p = pumpOf(f, kind, rate)
  if (p.stationId === "dv_unidentified" || p.stationId === "dv_card_cash") {
    // Answer 21: separate cash (a payment mode) from a missing indent number (a data-quality gap) — they are not the same problem.
    const hasIndent = kind === "INDENT" || ["SHRUDHU", "RVF", "MRPL", "GNM"].includes(kind)
    const category = kind === "CASH" ? "Cash — no indent number" : kind === "CARD SWIPE" ? "Card swipe — no indent number" : !hasIndent ? "Missing indent number (not cash)" : "Indent number present — pump still unmatched"
    note("unresolved", `Pump not identified · ${category}`, f.src, `${kind} ${litres} L @ ₹${rate ?? "?"}: ${p.how}`)
  }
  if (kind === "RVF" || kind === "NO INDENT" || kind === "BLANK" || kind === "OTHER") note("flag", `Source code "${String(f.indent ?? "")}"`, f.src, `pump decided by: ${p.how}`)
  diesel.push({ ...base, vendorId: p.stationId, rate: rate ?? 0, amount: round2(litres * (rate ?? 0)), paymentMode: p.mode, __src: f, __how: p.how, __srcAmount: f.amount })
}

/* ------------------------------------------------------------------ vehicles + assignments */
const firstFill = new Map<string, string>()
for (const d of diesel) if (!firstFill.has(d.vehicleId) || d.date < firstFill.get(d.vehicleId)!) firstFill.set(d.vehicleId, d.date)
const vehicles: Vehicle[] = [...vehicleIds].map(([regNo, id]) => {
  const mine = diesel.filter((d) => d.vehicleId === id).sort((a, b) => a.date.localeCompare(b.date))
  const odo = Math.max(0, ...mine.map((d) => d.odometerKm ?? 0))
  return {
    id, regNo, companyCode: "VT", typeCode: "", make: "", model: "", year: 0, seats: null, fuelType: "DIESEL", mileageKmpl: 0, ownership: "OWNED", ownerName: null,
    status: "ACTIVE", statusHistory: [{ status: "ACTIVE", startDate: FY_FROM, endDate: null }], odometerKm: odo, assignedCustomerId: mine.at(-1)?.customerId ?? null, defaultDriverId: null,
    insurance: { provider: "", policyNo: "", validTill: "", premium: 0 }, roadTax: { validTill: "", amount: 0, period: "ANNUAL" }, fitnessValidTill: "", permitValidTill: "", emiAmount: 0,
    notes: regNo === JIO_BUNK_VEHICLE ? "Not a vehicle: generator, bunk, can and MJ Casting construction diesel from the Hosur Goods book, charged to Jio Bunk (uncle's answer A-5)."
      : OWNER_PERSONAL.has(regNo) ? "The owner's personal vehicle (uncle's answer A-6). Billed by Vishal Gasoline; in no diesel book."
      : `Created by the fuel import from the diesel books (FY 2026-27). Vehicle details are not in the fuel books.`,
    createdAt: `${FY_FROM}T00:00:00.000Z`, updatedAt: `${FY_FROM}T00:00:00.000Z`,
  }
})
// Same vehicle under two customers on the same day: the ERP can file a day under one customer only.
const byVehDay = new Map<string, Set<string>>()
for (const d of diesel) byVehDay.set(`${d.vehicleId}|${d.date}`, new Set([...(byVehDay.get(`${d.vehicleId}|${d.date}`) ?? []), d.customerId!]))
for (const [k, cs] of byVehDay) if (cs.size > 1) note("discrepancy", "Vehicle in two customers' books on one day", k, [...cs].map((c) => customers.get(c)!.name).join(" + "))
// Problem 2 (A-2: two separate fills): TN70AM6132 is in the DHOOT book all year; the Hosur Buses book (an older copy) has
// one 2026 row on the same day. A vehicle has one customer per day, so that row doesn't open a one-day Hosur Buses
// assignment — both fills sit under DTPL until the uncle says otherwise (pending question in issues.md).
const NOT_AN_ASSIGNMENT = new Set([sig(BOOK.hosurBuses, "TN70AM6132", "2026-04-23", "TN70AM6132", 139.65, "MINI TANK")])
const assignments: VehicleAssignment[] = vehicles.flatMap((v) =>
  inferAssignments(v, diesel.filter((d) => !NOT_AN_ASSIGNMENT.has(sigOf(d.__src))), TODAY).map((p, i) => ({ ...p, id: `vas_${v.id}_${i}`, createdAt: v.createdAt, updatedAt: v.createdAt }))
)

/* ------------------------------------------------------------------ purchase book → tanker loads, payments, openings */
const loads: (TankerLoad & { __src: string; __tanker?: string })[] = []
const payments: (Payment & { __src: string })[] = []
const openings = new Map<string, { amount: number; src: string }>()
const carry: { month: string; station: string; amount: number; src: string; column: "amount" | "payment" }[] = []
const OPENING = /OPENING/i
const tdsCheck: { src: string; station: string; month: string; sourceTds: number; monthPurchases: number; tdsAt0_1pct: number; difference: number }[] = []
for (let r of book) {
  if (r.kind !== "ROW") continue
  const month = MONTH_OF[r.month]
  const label = String(r.vehicleRaw ?? r.indent ?? "")
  if (r.excluded) {
    note("excluded", r.excluded, r.src, `${r.station}: ${r.qty ?? 0} L, ₹${r.amt ?? 0}, paid ₹${r.pay ?? 0}`)
    continue
  }
  if (OPENING.test(label) || OPENING.test(String(r.vehicleRaw ?? ""))) {
    // Opening in the amount column; an undated figure in the payment column is a credit carried in (− = station owes us).
    const amt = r.amt ?? (r.pay != null && !r.payDate ? -r.pay : null)
    if (amt != null) {
      if (month === "2026-04") openings.set(r.station, { amount: amt, src: r.src })
      else carry.push({ month, station: r.station, amount: amt, src: r.src, column: r.amt != null ? "amount" : "payment" })
    }
    // A dated payment written on the opening row (e.g. July Vishal) is still a payment.
    if (r.pay && r.payDate) payments.push(paymentOf(r))
    else if (r.pay && r.amt != null) undatedPayment(r)
    continue
  }
  const qty = r.qty
  if (qty) {
    const v = r.vehicle ?? ""
    const tag = String(r.payDateRaw ?? "").toUpperCase()
    // A date whose day and month fit the row's sheet but whose year is mistyped ('16.05.206', '17.06.2025'): owner's decision — use the sheet's year, flagged.
    const dm = String(r.dateRaw ?? "").match(/^\s*(\d{1,2})[./-](\d{1,2})[./-]/)
    if (dm && r.date?.slice(0, 7) !== month && Number(dm[2]) === Number(month.slice(5))) {
      const fixed = `${month}-${dm[1].padStart(2, "0")}`
      note("flag", "Year corrected — confirmed (answer 13: both years are 2026)", r.src, `date written '${r.dateRaw}' → ${fixed}`)
      corrections.push({ src: r.src, rule: "Answer 13: both years are 2026", field: "date", before: r.dateRaw, after: fixed })
      r = { ...r, date: fixed }
    }
    if (TANKERS.has(v)) {
      if (!r.date) note("unresolved", "Tanker load without a date", r.src, `${v} ${qty} L`)
      else {
        if (tag === "APJ") {
          // Owner's decision: the load is a real purchase from the station, and its litres left the tanker to APJ (industrial supply).
          note("flag", "APJ industrial load", r.src, `${v} ${qty} L — imported as a load and an external dispense to APJ (industrial)`)
          external.push({ id: `tkd_${hash(r.src)}`, tankerId: COMBINED, date: r.date, vehicleNo: "APJ (industrial)", litres: qty, notes: `Industrial supply, load tagged APJ in ${r.src}`, createdAt: created(r.date), updatedAt: created(r.date), __src: { src: r.src } as Fill })
        }
        if (v === "KA51AF1429") note("flag", "KA51AF1429 treated as a tanker", r.src, `${qty} L load — a load this size can only be a tanker`)
        loads.push({ id: `tkl_${hash(r.src)}`, tankerId: COMBINED, date: r.date, stationId: station(r.station), invoiceNo: r.indent == null ? "" : String(r.indent), litres: qty, rate: r.rate ?? 0, amount: round2(qty * (r.rate ?? 0)),
          notes: [r.note ? String(r.note) : null, `Loaded into ${tankerByReg(v)?.name ?? "tanker"} (${v})`].filter(Boolean).join(" · "), createdAt: created(r.date), updatedAt: created(r.date), __src: r.src, __tanker: v })
        if (r.amt != null && Math.abs(round2(qty * (r.rate ?? 0)) - r.amt) > 0.01) note("discrepancy", "Load amount ≠ litres × rate", r.src, `source ₹${r.amt}, litres × rate ₹${round2(qty * (r.rate ?? 0))}`)
      }
    } else if (/OIL/i.test(label)) note("excluded", "Lubricant (OIL) purchase", r.src, `₹${r.amt}`)
  } else if (r.amt && !r.pay && !/OIL/i.test(label)) note("unresolved", "Amount without litres", r.src, `${r.station}: ₹${r.amt} (${label})`)
  else if (r.amt && /OIL/i.test(label)) note("excluded", "Lubricant (OIL) purchase", r.src, `₹${r.amt}`)
  if (r.pay) {
    if (r.pay < 0) note("excluded", "Negative payment adjustment", r.src, `${r.station}: ₹${r.pay} (industrial consumption netted out of the supplier's payments; a payment can't be negative in the ERP — the ledger shows payments as made)`)
    else if (r.payDate) payments.push(paymentOf(r))
    else undatedPayment(r)
  }
}
function paymentOf(r: BookRow, date = r.payDate!, flagged?: string): Payment & { __src: string } {
  // Answer 14: TDS is a deduction on the station's bills (0.1%), dated the month's last day — it settles the bill but no money is paid to the pump.
  const tds = /TDS/i.test(String(r.payDateRaw ?? ""))
  const noteText = String(r.note ?? "").toUpperCase()
  const mode: PaymentMode = noteText.includes("CASH") ? "CASH" : "NEFT"
  if (!tds && !/ACCOUNT/.test(noteText)) note("flag", "Payment mode not recorded", r.src, `₹${r.pay} to ${r.station} recorded as NEFT (bank)`)
  // S-02: a payment written on an earlier month's sheet was for that month's purchases — kept on its real date.
  if (date.slice(0, 7) > MONTH_OF[r.month]) flagged = [flagged, `Paid ${date} for ${r.month.replace(/\s+/g, " ")} purchases — written on that month's sheet (uncle's answer S-02)`].filter(Boolean).join(" · ")
  return {
    id: `pay_${hash(r.src + "|pay")}`, paymentNo: "", companyCode: "VT", direction: "OUT", date, partyType: "VENDOR", customerId: null, vendorId: station(r.station), vehicleId: null,
    partyName: stations.get(station(r.station))!.name, categoryCode: STATION_PAYMENT_CATEGORY, amount: tds ? 0 : round2(r.pay!), tdsAmount: tds ? round2(r.pay!) : 0, mode: tds ? "TDS" : mode, reference: tds ? `TDS ${date.slice(0, 7)}` : "",
    allocations: [], notes: [tds ? "TDS deducted (source: TDS), dated the month's last day (answer 14)" : null, r.note ? `Source note: ${r.note}` : null, tds ? null : flagged].filter(Boolean).join(" · "), createdAt: created(date), updatedAt: created(date), __src: r.src,
  }
}
function undatedPayment(r: BookRow) {
  const isTds = /TDS/i.test(String(r.payDateRaw ?? ""))
  if (isTds) {
    // Answer 14 — the TDS date is the month's last day (no longer a guess).
    const d = monthEnd(MONTH_OF[r.month])
    const base = round2(sum(book.filter((b) => b.station === r.station && b.month === r.month && b.kind === "ROW" && b.qty && !b.excluded && !OPENING.test(String(b.vehicleRaw ?? b.indent ?? ""))), (b) => b.amt ?? 0))
    const due = tdsDue(base)
    note(Math.abs(due - r.pay!) <= 1 ? "flag" : "unresolved", "TDS dated the month's last day (answer 14)", r.src,
      `₹${r.pay} to ${r.station} dated ${d}; 0.1% of ${r.month}'s purchases (₹${base}) = ₹${due}${Math.abs(due - r.pay!) <= 1 ? " — matches (rounded to the rupee)" : ` — differs by ₹${round2(r.pay! - due)}: which month's bills is this TDS for?`}`)
    tdsCheck.push({ src: r.src, station: r.station, month: MONTH_OF[r.month], sourceTds: r.pay!, monthPurchases: base, tdsAt0_1pct: due, difference: round2(r.pay! - due) })
    payments.push(paymentOf(r, d))
    return
  }
  if (UNDATED === "month-end") {
    const d = monthEnd(MONTH_OF[r.month])
    note("unresolved", "Payment date not recorded (not TDS)", r.src, `₹${r.pay} to ${r.station} (${r.payDateRaw ?? "no date"}) dated ${d}, the last day of its sheet's month — still a guess; the real payment date is needed`)
    payments.push(paymentOf(r, d, "Date not recorded in source; month-end used"))
  } else note("unresolved", "Payment without a date", r.src, `₹${r.pay} to ${r.station} (${r.payDateRaw ?? "no date"}) — not imported`)
}
// Payment numbers as the API would give them: <prefix>-PAY-<FY>-#### in date order.
{
  const counters = new Map<string, number>()
  for (const p of [...payments].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
    const prefix = `VT-PAY-${fyLabel(p.date).replace("-", "")}-`
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)
    p.paymentNo = `${prefix}${String(n).padStart(4, "0")}`
  }
}
for (const [name, o] of openings) {
  const s = stations.get(station(name))!
  s.openingBalance = round2(o.amount)
  s.openingBalanceDate = FY_FROM
}
// Tanker stock carried into April (purchase book, April: "STOCK CARRIED FROM PREVIOUS MONTH" 7,721 L, valued × 90.99).
const aprStock = summaries.find((s) => s.month === "APRIL 2026" && s.label === "STOCK CARRIED FROM PREVIOUS MONTH")!
const openingLitres = Number(aprStock.values![0])
loads.push({ id: "tkl_opening_fy2627", tankerId: COMBINED, date: FY_FROM, stationId: "", opening: true, invoiceNo: "OPENING", litres: openingLitres, rate: 90.99, amount: round2(openingLitres * 90.99),
  notes: `Stock carried into April 2026 (${aprStock.src}, valued × ₹90.99 as in the source)`, createdAt: `${FY_FROM}T00:00:00.000Z`, updatedAt: `${FY_FROM}T00:00:00.000Z`, __src: aprStock.src })
note("flag", "Tanker opening stock", aprStock.src, `${openingLitres} L at ₹90.99 = ₹${round2(openingLitres * 90.99)}; TATA TANK / OFFICE TANK stock is listed separately in the source and not added`)

/* ------------------------------------------------------------------ validate with the app's own rules */
const strip = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith("__"))) as T
const plainDiesel = diesel.map(strip)
const plainLoads = loads.map(strip)
const plainExternal = external.map(strip)
const plainPayments = payments.map(strip)
const tankerRecs = { loads: plainLoads, fills: plainDiesel, external: plainExternal, transfers: [], adjustments: [] }
const tv = valueTankers(tankerRecs)
const moves = tankerMoves(tankerRecs)
const stock = { stockLitres: tv.stock.get(COMBINED)?.litres ?? 0, stockValue: tv.stock.get(COMBINED)?.value ?? 0, shortfall: tv.shortfall, costOf: tv.costOf }
// Every point where a tanker's running stock would go negative (the app refuses the first one).
const negatives: { tankerId: string; date: string; stock: number }[] = []
{
  const order = (m: (typeof moves)[number]) => (m.litres >= 0 ? 0 : 1)
  const ev = [...moves].sort((a, b) => a.date.localeCompare(b.date) || order(a) - order(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const level = new Map<string, number>()
  for (const e of ev) {
    const s = (level.get(e.tankerId) ?? 0) + e.litres
    level.set(e.tankerId, s)
    if (s < -1e-6 && !negatives.some((n) => n.tankerId === e.tankerId && n.date === e.date)) negatives.push({ tankerId: e.tankerId, date: e.date, stock: round2(s) })
  }
}
const resolvedDiesel = resolveCustomers(plainDiesel, assignments)
// As the app reports them (api.diesel.list → tankerValued): tanker fills at the rate on the fill (answer 23); only rate-less ones at the average.
const valued = resolvedDiesel.map((d) => (d.vendorId === TANKER_SOURCE_ID ? { ...d, amount: fillAmount(d, tv.costOf) } : d))
const moved = resolvedDiesel.filter((d, i) => d.customerId !== plainDiesel[i].customerId)
for (const d of moved) note("discrepancy", "Customer moved by assignment history", diesel.find((x) => x.id === d.id)!.__src.src, `book says ${customers.get(plainDiesel.find((x) => x.id === d.id)!.customerId!)!.name}, the vehicle's assignment on ${d.date} says ${d.customerId ? customers.get(d.customerId)!.name : "none"}`)

/* ------------------------------------------------------------------ reconciliation (ERP figures computed by the app's own functions) */
const settings = structuredClone(DEFAULT_SETTINGS)
const stationList = [...stations.values()]
const ds = { settings, customers: [...customers.values()], vehicles, drivers: [], trips: [], diesel: valued, invoices: [], payments: plainPayments, assignments, fuelStations: stationList, tankerLoads: plainLoads, tankers: tankerRecords }
const idx = buildDieselIndex(ds)
const months = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
const custCode = new Map([...customers.values()].map((c) => [c.id, c.notes!.match(/Fuel book: (.*?)\./)![1]]))

// 1. Consumption per customer per month vs the purchase book's own company summary.
const consumptionRec = months.flatMap((m) =>
  [...customers.values()].map((c) => {
    const erp = resolvedDiesel.filter((d) => d.customerId === c.id && d.date.startsWith(m))
    const code = custCode.get(c.id)!
    const srcRow = summaries.find((s) => s.label === "COMPANY" && MONTH_OF[s.month] === m && s.company?.replace(/\s+/g, " ") === code.replace(/\s+/g, " "))
    const book = fyFills.filter((f) => f.customer === code && f.date!.startsWith(m))
    const erpValued = valued.filter((d) => d.customerId === c.id && d.date.startsWith(m))
    return { month: m, customer: c.name, code, erpFills: erp.length, erpLitres: round2(sum(erp, (d) => d.litres)), bookLitres: round2(sum(book, (f) => f.litres)), summaryLitres: srcRow?.litres ?? null, summarySrc: srcRow?.src ?? null,
      bookAmount: round2(sum(book, (f) => f.amount ?? 0)), summaryAmount: srcRow?.amount ?? null, erpAmount: round2(sum(erpValued, (d) => d.amount)) }
  }).filter((r) => r.erpFills || r.summaryLitres)
)
// 2. Each source block's own TOTAL row (per vehicle sheet per month) vs the rows under it.
// Answer 19: a sheet can repeat a month heading (Tata D41 has two "AUG-2026" blocks; the second holds September's
// 389 L) — so a TOTAL covers the rows between the previous TOTAL row and itself, never every row with the same label.
const prevTotalRow = (t: (typeof blockTotals)[number]) => Math.max(0, ...blockTotals.filter((x) => x.file === t.file && x.sheet === t.sheet && x.row < t.row).map((x) => x.row))
const blockRec = blockTotals.filter((t) => /-2026/.test(String(t.block)) && /(APR|MAY|JUN|JUL|AUG|SEP|OCT)/.test(String(t.block))).map((t) => {
  const from = prevTotalRow(t)
  const rows = fills.filter((f) => f.file === t.file && f.sheet === t.sheet && f.row > from && f.row < t.row)
  return { src: `${t.file} › ${t.sheet} › row ${t.row}`, block: t.block, totalLitres: t.litres, rowsLitres: round2(sum(rows, (f) => f.litres)), totalAmount: t.amount, rowsAmount: round2(sum(rows, (f) => f.amount ?? 0)) }
}).filter((r) => Math.abs(r.totalLitres - r.rowsLitres) > 0.005 || (r.totalAmount != null && Math.abs(r.totalAmount - r.rowsAmount) > 0.01))
// 3. Station ledgers: ERP month by month vs the purchase book's blocks.
const purchases = [...resolvedDiesel, ...loadsAsStationPurchases(plainLoads, tankerRecords)]
const stationRec = stationList.filter((s) => !s.isTanker).map((s) => {
  const rows = stationLedger(s.id, purchases, plainPayments, "2026-10", openingOf(s))
  const name = [...Object.entries(STATION_IDS)].find(([, id]) => id === s.id)![0]
  return { station: s.name, months: rows.filter((r) => r.month >= "2026-04").map((r) => {
    const srcRows = book.filter((b) => b.station === name && MONTH_OF[b.month] === r.month)
    const tot = srcRows.find((b) => b.kind === "TOTAL")
    const cf = carry.find((c) => c.station === name && c.month === r.month)
    return { month: r.month, opening: r.opening, purchased: r.purchased, paid: r.paid, closing: r.closing, sourceOpening: cf?.amount ?? (r.month === "2026-04" ? (openings.get(name)?.amount ?? null) : null), sourceOpeningSrc: cf?.src ?? null,
      sourceBlockLitres: tot?.qty ?? null, sourceBlockAmount: tot?.amt ?? null, sourceBlockPaid: tot?.pay ?? null, sourceSrc: tot?.src ?? null }
  }) }
})
// 3b. Whole period per station (Apr–Oct): the source's purchases and payments vs what the ERP holds.
const stationTotals = stationList.filter((s) => !s.isTanker).map((s) => {
  const name = [...Object.entries(STATION_IDS)].find(([, id]) => id === s.id)![0]
  const rows = book.filter((b) => b.station === name && b.kind === "ROW" && !b.excluded)
  const isCarry = (b: BookRow) => OPENING.test(String(b.vehicleRaw ?? b.indent ?? "")) && (b.amt != null || !b.payDate)
  const fillsAt = resolvedDiesel.filter((d) => d.vendorId === s.id)
  const loadsAt = plainLoads.filter((l) => l.stationId === s.id)
  const led = ledgerFor(stationLedger(s.id, purchases, plainPayments, "2026-10", openingOf(s)))
  return {
    station: s.name, sourceOpening: openings.get(name)?.amount ?? 0,
    sourcePurchases: round2(sum(rows.filter((r) => r.qty), (r) => r.amt ?? 0)),
    // Every positive payment cell, including dated payments written on an opening row; not the undated carried-in credits.
    sourcePayments: round2(sum(rows.filter((r) => (r.pay ?? 0) > 0 && !(isCarry(r) && r.amt == null)), (r) => r.pay!)),
    erpOpening: led.opening, erpLoads: round2(sum(loadsAt, (l) => l.amount)), erpFills: round2(sum(fillsAt, (d) => d.amount)), erpPurchases: led.purchased, erpPayments: led.paid, erpClosing: led.closing,
    cashAtPump: led.cashAtPump,
  }
})
// 4. Tanker stock month by month.
// Answer 18: the source's negative "STOCK CARRIED FOR NEXT MONTH" (e.g. −2,354 L) is stock carried forward into the
// next month, written as a deduction from this month — not negative physical stock. Shown here as a positive carry-forward.
const tankerLedgerRows = tankerLedger(moves, COMBINED, "2026-10")
const tankerRec = months.map((m) => {
  const p = tankerPeriod(tankerLedgerRows, [m])
  const srcFrom = summaries.find((s) => MONTH_OF[s.month] === m && s.label === "STOCK CARRIED FROM PREVIOUS MONTH")
  const srcNext = summaries.find((s) => MONTH_OF[s.month] === m && s.label === "STOCK CARRIED FOR NEXT MONTH")
  const num_ = (v: unknown) => (typeof v === "number" ? v : null)
  const out = num_(srcNext?.values?.[0])
  return {
    month: m, opening: round2(p.opening + p.openingStock), loaded: p.loaded, loadedCost: p.loadedCost, dispensed: p.dispensed, closing: p.closing,
    sourceCarriedIn: num_(srcFrom?.values?.[0]), sourceCarriedOutAsWritten: out, sourceCarriedForward: out == null ? null : Math.abs(out),
    tataTank: num_(summaries.find((s) => MONTH_OF[s.month] === m && s.label === "TATA TANK")?.values?.[0]), officeTank: num_(summaries.find((s) => MONTH_OF[s.month] === m && s.label === "OFFICE TANK")?.values?.[0]),
  }
})
// Loads per tanker vehicle (source evidence for splitting the combined stock later).
const loadsByTanker = ["TN70AX9480", "KA53C0538", "KA51AF1429"].map((reg) => {
  const mine = loads.filter((l) => !l.opening && l.notes.includes(reg))
  return { tanker: reg, loads: mine.length, litres: round2(sum(mine, (l) => l.litres)), amount: round2(sum(mine, (l) => l.amount)), byMonth: months.map((m) => ({ month: m, litres: round2(sum(mine.filter((l) => l.date.startsWith(m)), (l) => l.litres)) })) }
})
const fillsByTankLabel = [...new Set(diesel.filter((d) => d.vendorId === TANKER_SOURCE_ID).map((d) => d.billNo.toUpperCase().replace(/\s+/g, " ")))].map((label) => {
  const mine = diesel.filter((d) => d.vendorId === TANKER_SOURCE_ID && d.billNo.toUpperCase().replace(/\s+/g, " ") === label)
  return { label, fills: mine.length, litres: round2(sum(mine, (d) => d.litres)), amount: round2(sum(mine, (d) => d.amount)) }
}).sort((a, b) => b.litres - a.litres)
// Answer 19 follow-up: fills whose date is in a different month from their block heading (the ERP uses the date).
const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" }
const blockMonth = (b: string | null) => {
  const m = String(b ?? "").toUpperCase().match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\s*-?\s*(\d{4})/)
  return m ? `${m[2]}-${MON[m[1]]}` : null
}
const labelMismatch = fyFills.filter((f) => blockMonth(f.block) && blockMonth(f.block) !== f.date!.slice(0, 7)).map((f) => ({ src: f.src, block: f.block, date: f.date, litres: f.litres }))
for (const r of labelMismatch) note("unresolved", "Date month differs from the block heading", r.src, `dated ${r.date} under heading ${r.block} — the ERP files it by its date; confirm the date`)
// 5. Yearly purchase totals (source "Total" sheet) vs everything the import puts in station purchases.
const yearlyRec = yearly.filter((y) => y.litres).map((y) => ({ ...y, erpLoadLitres: round2(sum(plainLoads.filter((l) => !l.opening && l.date.startsWith(y.month)), (l) => l.litres)),
  erpPumpLitres: round2(sum(resolvedDiesel.filter((d) => d.vendorId !== TANKER_SOURCE_ID && d.date.startsWith(y.month)), (d) => d.litres)) }))
// 6. Pump bills (INDENT QUANTITY / DIESEL / PETROL / cab rows) vs the fills assigned to that station, per month.
const pumpRec = months.flatMap((m) => stationList.filter((s) => !s.isTanker).map((s) => {
  const name = [...Object.entries(STATION_IDS)].find(([, id]) => id === s.id)![0]
  const bills = billRows.filter((r) => r.station === name && MONTH_OF[r.month] === m)
  const erp = resolvedDiesel.filter((d) => d.vendorId === s.id && d.date.startsWith(m))
  return { month: m, station: s.name, billLitres: round2(sum(bills, (r) => r.qty ?? 0)), billAmount: round2(sum(bills, (r) => r.amt ?? 0)), erpFills: erp.length, erpLitres: round2(sum(erp, (d) => d.litres)), erpAmount: round2(sum(erp, (d) => d.amount)) }
}).filter((r) => r.billLitres || r.erpFills))
const unmatchedVehicleRows = [...vehicleRows.values()].filter((r) => !matchedBookRows.has(r.src))
const latestSourceDate = [...fyFills.map((f) => f.date!), ...book.filter((b) => b.date && b.date <= TODAY).map((b) => b.date!), ...book.filter((b) => b.payDate && b.payDate <= TODAY).map((b) => b.payDate!)].sort().at(-1)!
for (const r of unmatchedVehicleRows) note("unresolved", "Purchase-book vehicle fill not found in any diesel book", r.src, `${r.vehicle} ${r.qty} L on ${r.date} at ${r.station} — not imported (no odometer or customer)`)
const total = statsOf(idx, valued)

/* ------------------------------------------------------------------ test window (VT_EMIT_FROM): only this period's records are written */
if (EMIT_FROM) {
  emitWindow(EMIT_FROM)
  process.exit(0)
}

/** Where each tanker's running stock goes below zero: the first point and the lowest (app event order: date, additions first, createdAt, id). */
function negativePoints(mv: ReturnType<typeof tankerMoves>) {
  const ev = [...mv].sort((a, b) => a.date.localeCompare(b.date) || Number(a.litres < 0) - Number(b.litres < 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const level = new Map<string, number>()
  const out = new Map<string, { first: { date: string; id: string; stock: number }; lowest: { date: string; id: string; stock: number } }>()
  for (const e of ev) {
    const s = (level.get(e.tankerId) ?? 0) + e.litres
    level.set(e.tankerId, s)
    if (s >= -1e-6) continue
    const at = { date: e.date, id: e.id, stock: round2(s) }
    const o = out.get(e.tankerId)
    if (!o) out.set(e.tankerId, { first: at, lowest: at })
    else if (s < o.lowest.stock) o.lowest = at
  }
  return [...out].map(([tankerId, x]) => ({ tankerId, ...x }))
}

/**
 * Writes a restorable test file with only the records dated from `from` to the run date. Earlier months are used only to
 * CALCULATE the closing balances at the day before `from`; an opening balance is written only when that calculation and
 * the opening written in the Excel agree (stations), or — for the combined tanker stock — as the Excel's own written
 * carry-forward, marked unresolved. Nothing is invented: a balance without evidence is left out and reported.
 */
function emitWindow(from: string) {
  const inWin = (d: string | null | undefined) => !!d && d >= from && d <= TODAY
  const prevMonth_ = prevMonth(from.slice(0, 7))
  const winMonths = months.filter((m) => m >= from.slice(0, 7) && m <= TODAY.slice(0, 7))
  const purchasesAll = [...valued, ...loadsAsStationPurchases(plainLoads, tankerRecords)]
  const bookBySrc = new Map(book.map((b) => [b.src, b]))

  // 1. Stations: calculated closing at the end of the month before the window (date-based, from every earlier record).
  const stationOpening = stationList.filter((x) => !x.isTanker).map((x) => {
    const rows = stationLedger(x.id, purchasesAll, plainPayments, prevMonth_, openingOf(x)).filter((r) => r.month <= prevMonth_)
    const calc = rows.length ? rows.at(-1)!.closing : 0
    const name = Object.entries(STATION_IDS).find(([, id]) => id === x.id)![0]
    const written = carry.find((c) => c.station === name && c.month === from.slice(0, 7))
    const writtenOpeningRow = book.find((b) => b.station === name && MONTH_OF[b.month] === from.slice(0, 7) && OPENING.test(String(b.vehicleRaw ?? b.indent ?? "")))
    // S-01: no amount on the opening row (or no row) = nothing was owed. S-02: payments made in this month but written on
    // the previous month's sheet paid that month's purchases, so they were still owed on the 1st (Excel's opening is net of them).
    const paidForPrev = payments.filter((p) => p.vendorId === x.id && p.date.startsWith(from.slice(0, 7)) && MONTH_OF[bookBySrc.get(p.__src)!.month] === prevMonth_)
    const answered = from === OPENING_STOCK.from
    const used = answered ? round2((written?.amount ?? 0) + sum(paidForPrev, (p) => p.amount)) : written && Math.abs(written.amount - calc) <= 1 ? round2(written.amount) : null
    // Cross-check: what the previous month's own sheet leaves owed at its month end (its carried-in figure + purchases − payments dated in it).
    const prevRows = book.filter((b) => b.station === name && MONTH_OF[b.month] === prevMonth_ && b.kind === "ROW" && !b.excluded)
    const isCarryIn = (b: BookRow) => OPENING.test(String(b.vehicleRaw ?? b.indent ?? "")) && !b.payDate
    const prevSheet = round2((carry.find((c) => c.station === name && c.month === prevMonth_)?.amount ?? 0) + sum(prevRows.filter((b) => b.qty), (b) => b.amt ?? 0)
      - sum(prevRows.filter((b) => (b.pay ?? 0) > 0 && !isCarryIn(b) && !(b.payDate && b.payDate > monthEnd(prevMonth_))), (b) => b.pay!))
    return { stationId: x.id, station: x.name, calculated: round2(calc), excelWritten: written ? round2(written.amount) : null, excelSrc: written?.src ?? writtenOpeningRow?.src ?? null,
      excelCell: written ? "amount written" : writtenOpeningRow ? "OPENING BALANCE written with no amount" : "no opening row", aprilOpeningKnown: !!openingOf(x),
      paidForPreviousMonth: paidForPrev.map((p) => ({ src: p.__src, date: p.date, amount: p.amount })), previousSheetOwedAtMonthEnd: prevSheet, differenceFromPreviousSheet: used == null ? null : round2(prevSheet - used),
      basis: answered ? "S-01 (written opening, blank = 0) + S-02 (payments on the previous sheet dated in this month)" : "Excel opening agreeing with the calculation", used }
  })
  // 2. Tanker stock: the Excel's written carry into the window month vs the calculated combined stock.
  const tankSrc = summaries.find((x) => MONTH_OF[x.month] === from.slice(0, 7) && x.label === "STOCK CARRIED FROM PREVIOUS MONTH")
  const tankWritten = typeof tankSrc?.values?.[0] === "number" ? (tankSrc.values[0] as number) : null
  const tankCalcRows = tankerLedger(moves, COMBINED, prevMonth_).filter((r) => r.month <= prevMonth_)
  const tankCalc = tankCalcRows.length ? tankCalcRows.at(-1)!.closing : 0

  // 3. The window's records.
  const pooledDiesel = plainDiesel.filter((d) => inWin(d.date))
  const externalW = plainExternal.filter((d) => inWin(d.date))
  const paymentsW = plainPayments.filter((x) => inWin(x.date))
  const openingLoad = (tankerId: string, litres: number, notes: string): TankerLoad => ({
    id: `tkl_opening_${from.slice(0, 7).replace("-", "")}${tankerId === COMBINED ? "" : `_${tankerId.slice(4)}`}`, tankerId, date: from, stationId: "", opening: true, invoiceNo: "OPENING", litres, rate: 0, amount: 0,
    notes, createdAt: `${from}T00:00:00.000Z`, updatedAt: `${from}T00:00:00.000Z` })
  const windowLoads = plainLoads.filter((l) => !l.opening && inWin(l.date))
  // S-03 + S-04: each tanker's own stock (opening by S-03, loads by the tanker loaded, fills by their label). It is written
  // only if every tank record maps to a tanker and no tanker ever goes below zero (the app's rule); otherwise the stock
  // stays combined and the split is only reported (reconciliation.json → tankerSplit).
  const answeredStock = from === OPENING_STOCK.from
  const idOfReg = (reg: string) => TANKER_MASTER.find((t) => t.regNo === reg)!.id
  const fillTanker = new Map(diesel.filter((d) => d.vendorId === TANKER_SOURCE_ID).map((d) => [d.id, tankerOfLabel(d.__src.indent)]))
  const answerNote = `Diesel in the tankers on the morning of ${from} (uncle's answer S-03): JIO 4,094 L ("TATA TANK", AUG 2026 R66) · Office 142 L ("OFFICE TANK", R67) · Mini 0 L. Not a purchase, owed to no pump, no value. The purchase book's ${tankWritten ?? "—"} L (${tankSrc?.src ?? "—"}, =4265+339) is not used.`
  const split = {
    loads: [...Object.entries(OPENING_STOCK.litres).filter(([, v]) => v).map(([reg, v]) => openingLoad(idOfReg(reg), v, answerNote)),
      ...windowLoads.map((l) => ({ ...l, tankerId: idOfReg(loads.find((x) => x.id === l.id)!.__tanker!) }))],
    fills: pooledDiesel.map((d) => (d.vendorId === TANKER_SOURCE_ID ? { ...d, tankerId: fillTanker.get(d.id)?.id ?? COMBINED } : d)),
    external: externalW.map((x) => ({ ...x, tankerId: COMBINED })), // ponytail: none in Sep–Oct; label them when one appears
    transfers: [], adjustments: [],
  }
  const unmapped = split.fills.filter((d) => d.tankerId === COMBINED).length + split.external.length
  const splitMoves = tankerMoves(split)
  const splitNegatives = negativePoints(splitMoves)
  const useSplit = answeredStock && !unmapped && valueTankers(split).shortfall === null
  const poolOpening = answeredStock ? sum(Object.values(OPENING_STOCK.litres), (v) => v) : tankWritten
  const pooledLoads = [...(poolOpening === null ? [] : [openingLoad(COMBINED, poolOpening, answeredStock ? `${answerNote} Kept as one combined stock: split by tanker, the records go below zero (SEPT_OCT_FUEL_IMPORT_ISSUES.md S-21, S-22).`
    : `Combined stock carried into ${from.slice(0, 7)} as written in the purchase book (${tankSrc!.src}); not split by tanker and no value in the source. UNRESOLVED: the records before ${from} give ${round2(tankCalc)} L.`)]), ...windowLoads]
  const loadsW = useSplit ? split.loads : pooledLoads
  const dieselW = useSplit ? split.fills : pooledDiesel
  const vIds = new Set(dieselW.map((d) => d.vehicleId))
  const cIds = new Set(dieselW.map((d) => d.customerId!))
  const sIds = new Set([TANKER_SOURCE_ID, ...dieselW.map((d) => d.vendorId), ...loadsW.filter((l) => !l.opening).map((l) => l.stationId), ...paymentsW.map((x) => x.vendorId!)])
  const stamp = `${from}T00:00:00.000Z`
  const vehiclesW = vehicles.filter((v) => vIds.has(v.id)).map((v) => {
    const mine = dieselW.filter((d) => d.vehicleId === v.id).sort((a, b) => a.date.localeCompare(b.date))
    return { ...v, odometerKm: Math.max(0, ...mine.map((d) => d.odometerKm ?? 0)), assignedCustomerId: mine.at(-1)?.customerId ?? null, statusHistory: [{ status: "ACTIVE" as const, startDate: from, endDate: null }], createdAt: stamp, updatedAt: stamp }
  })
  const customersW = [...customers.values()].filter((c) => cIds.has(c.id)).map((c) => ({ ...c, statusHistory: [{ status: "ACTIVE" as const, startDate: from, endDate: null }], createdAt: stamp, updatedAt: stamp }))
  const stationsW: FuelStation[] = stationList.filter((x) => sIds.has(x.id)).map((x) => {
    const o = stationOpening.find((y) => y.stationId === x.id)
    // Never carry the FY's April opening into the window: only an opening validated for the window's first day.
    const rest: FuelStation = { ...x }
    delete rest.openingBalance
    delete rest.openingBalanceDate
    return o?.used != null ? { ...rest, openingBalance: o.used, openingBalanceDate: from } : rest
  })
  const assignmentsW: VehicleAssignment[] = vehiclesW.flatMap((v) =>
    inferAssignments(v, diesel.filter((d) => inWin(d.date) && !NOT_AN_ASSIGNMENT.has(sigOf(d.__src))), TODAY).map((p, i) => ({ ...p, id: `vas_${v.id}_${i}`, createdAt: stamp, updatedAt: stamp })))
  const resolvedW = resolveCustomers(dieselW, assignmentsW)
  const recW = { loads: loadsW, fills: dieselW, external: externalW, transfers: [], adjustments: [] }
  const tvW = valueTankers(recW)
  const movesW = tankerMoves(recW)
  const valuedW = resolvedW.map((d) => (d.vendorId === TANKER_SOURCE_ID ? { ...d, amount: fillAmount(d, tvW.costOf) } : d))
  const negativesW = negativePoints(movesW)

  // 4. Reconciliation of the window, month by month.
  const purchasesW = [...valuedW, ...loadsAsStationPurchases(loadsW, tankerRecords)]
  const stationLedgerW = stationsW.filter((x) => !x.isTanker).map((x) => {
    const name = Object.entries(STATION_IDS).find(([, id]) => id === x.id)![0]
    const led = stationLedger(x.id, purchasesW, paymentsW, TODAY.slice(0, 7), openingOf(x)).filter((r) => r.month >= from.slice(0, 7))
    return { station: x.name, openingUsed: x.openingBalance ?? null, months: winMonths.map((m) => {
      const r = led.find((y) => y.month === m) ?? { opening: 0, purchased: 0, paid: 0, vouchers: 0, manualCash: 0, cashAtPump: 0, tds: 0, closing: 0 }
      const written = carry.find((c) => c.station === name && c.month === m)
      const bills = billRows.filter((b) => b.station === name && MONTH_OF[b.month] === m)
      const fillsAt = valuedW.filter((d) => d.vendorId === x.id && d.date.startsWith(m))
      const loadsAt = loadsW.filter((l) => !l.opening && l.stationId === x.id && l.date.startsWith(m))
      return { month: m, opening: r.opening, purchased: r.purchased, paid: r.paid, vouchers: r.vouchers, manualCash: r.manualCash, cashAtPump: r.cashAtPump, tds: r.tds, closing: r.closing,
        excelOpeningWritten: written ? round2(written.amount) : null, excelOpeningSrc: written?.src ?? null,
        billLitres: round2(sum(bills, (b) => b.qty ?? 0)), billAmount: round2(sum(bills, (b) => b.amt ?? 0)), fillLitres: round2(sum(fillsAt, (d) => d.litres)), fillAmount: round2(sum(fillsAt, (d) => d.amount)), fills: fillsAt.length,
        loadLitres: round2(sum(loadsAt, (l) => l.litres)), loadAmount: round2(sum(loadsAt, (l) => l.amount)) }
    }) }
  })
  const poolRows = tankerLedger(movesW, null, TODAY.slice(0, 7))
  const tankerW = winMonths.map((m) => {
    const r = tankerPeriod(poolRows, [m])
    // Each tanker's own ledger under S-03 / S-04 (written to the dataset only when useSplit).
    const byTanker = TANKER_MASTER.map((t) => {
      const p = tankerPeriod(tankerLedger(splitMoves, t.id, TODAY.slice(0, 7)), [m])
      const fs = split.fills.filter((d) => d.tankerId === t.id && d.date.startsWith(m))
      return { tanker: t.name, regNo: t.regNo, opening: round2(p.opening + p.openingStock), loaded: p.loaded, loadedCost: p.loadedCost, dispensed: p.dispensed, closing: p.closing,
        fills: fs.length, byLabel: Object.fromEntries([...new Set(fs.map((d) => indentText(d.billNo)))].map((l) => [l, round2(sum(fs.filter((d) => indentText(d.billNo) === l), (d) => d.litres))])) }
    })
    const labels = [...new Set(diesel.filter((d) => d.vendorId === TANKER_SOURCE_ID && d.date.startsWith(m) && inWin(d.date)).map((d) => indentText(d.__src.indent)))].map((label) => {
      const fs = diesel.filter((d) => d.vendorId === TANKER_SOURCE_ID && d.date.startsWith(m) && inWin(d.date) && indentText(d.__src.indent) === label)
      return { label, fills: fs.length, litres: round2(sum(fs, (d) => d.litres)), amount: round2(sum(fs, (d) => d.amount)) }
    }).sort((a, b) => b.litres - a.litres)
    const sumLine = (label: string) => summaries.filter((x) => MONTH_OF[x.month] === m && x.label === label).map((x) => ({ src: x.src, values: x.values }))
    return { month: m, opening: round2(r.opening + r.openingStock), loaded: r.loaded, loadedCost: r.loadedCost, dispensed: r.dispensed, closing: r.closing, byTanker, labels,
      excelCarriedIn: sumLine("STOCK CARRIED FROM PREVIOUS MONTH"), excelCarriedOut: sumLine("STOCK CARRIED FOR NEXT MONTH"), excelTataTank: sumLine("TATA TANK"), excelOfficeTank: sumLine("OFFICE TANK") }
  })
  const custW = winMonths.flatMap((m) => customersW.map((c) => {
    const e = valuedW.filter((d) => d.customerId === c.id && d.date.startsWith(m))
    const code = c.notes!.match(/Fuel book: (.*?)\./)![1]
    const srcRow = summaries.find((x) => x.label === "COMPANY" && MONTH_OF[x.month] === m && x.company?.replace(/\s+/g, " ") === code.replace(/\s+/g, " "))
    return { month: m, customer: c.name, fills: e.length, litres: round2(sum(e, (d) => d.litres)), amount: round2(sum(e, (d) => d.amount)), summaryLitres: srcRow?.litres ?? null, summaryAmount: srcRow?.amount ?? null, summarySrc: srcRow?.src ?? null }
  }).filter((r) => r.fills || r.summaryLitres))
  const industrial = book.filter((b) => b.kind === "ROW" && /industrial/i.test(b.excluded ?? "") && (inWin(b.date) || (MONTH_OF[b.month] >= from.slice(0, 7) && !b.date))).map((b) => ({ src: b.src, date: b.date, vehicle: b.vehicle, qty: b.qty, rate: b.rate, amt: b.amt, pay: b.pay, payDate: b.payDate, note: b.note }))

  // 5. An outcome for every source row of the window.
  const dieselBySrc = new Map(diesel.map((d) => [d.__src.src, d]))
  const extBySrc = new Map(external.map((x) => [x.__src.src, x]))
  const issuesBySrc = new Map<string, Issue[]>()
  for (const i of issues) issuesBySrc.set(i.src, [...(issuesBySrc.get(i.src) ?? []), i])
  const outcomes: Record<string, unknown>[] = []
  for (const f of fills) {
    const winByDate = !!f.date && f.date >= from
    const winByBlock = !f.date && /(SEP|OCT)\S*\s*-?\s*2026/.test(String(f.block ?? "").toUpperCase())
    if (!winByDate && !winByBlock) continue
    const d = dieselBySrc.get(f.src), x = extBySrc.get(f.src), dup = dropDuplicate.get(f.src)
    const outcome = d && inWin(d.date) ? "1 imported" : x && inWin(x.date) ? "1 imported (external dispense)" : dup ? "4 duplicate of another record" : !f.date ? "3 subtotal / not a transaction" : f.date > TODAY ? "5 quarantined (date after the latest source date)" : "6 other"
    outcomes.push({ source: "diesel book", src: f.src, date: f.date, indent: indentText(f.indent), vehicle: String(f.vehicleRaw ?? ""), litres: f.litres, rate: f.rate, amount: f.amount, outcome, erpId: d?.id ?? x?.id ?? "",
      detail: dup ? `${dup.answer}; kept ${dup.keep}` : (issuesBySrc.get(f.src) ?? []).map((i) => i.topic).join("; ") })
  }
  for (const t of blockTotals.filter((t) => /(SEP|OCT)\S*\s*-?\s*2026/.test(String(t.block ?? "").toUpperCase())))
    outcomes.push({ source: "diesel book", src: `${t.file} › ${t.sheet} › row ${t.row}`, date: null, indent: "", vehicle: "", litres: t.litres, rate: null, amount: t.amount, outcome: "3 subtotal / not a transaction", erpId: "", detail: `TOTAL row of block ${t.block}` })
  const loadBySrc = new Map(loads.map((l) => [l.__src, l]))
  const payBySrc = new Map(payments.map((x) => [x.__src, x]))
  for (const b of book) {
    const sheetInWin = MONTH_OF[b.month] >= from.slice(0, 7)
    const l = loadBySrc.get(b.src), py = payBySrc.get(b.src)
    const loadIn = !!l && inWin(l.date), payIn = !!py && inWin(py.date)
    if (!sheetInWin && !loadIn && !payIn) continue
    const isBill = b.kind === "ROW" && billRows.includes(b) && !(b.vehicle && isReg(b.vehicle) && b.date && vehicleRows.get(`${b.vehicle}|${b.date}|${round2(b.qty!)}`))
    const outcome = b.kind === "TOTAL" ? "3 subtotal / not a transaction" : loadIn || payIn ? `1 imported (${[loadIn ? "tanker load" : null, payIn ? (py!.tdsAmount ? "TDS" : "payment") : null].filter(Boolean).join(" + ")})`
      : b.excluded ? `6 excluded: ${b.excluded}` : OPENING.test(String(b.vehicleRaw ?? b.indent ?? "")) ? "3 opening-balance line (evidence for the opening, see report)" : isBill ? "3 supplier bill line (compared with the fills, not a separate record)"
      : (l && !inWin(l.date)) || (py && !inWin(py.date)) ? "2 outside the period (dated before the window)" : b.qty && /OIL/i.test(String(b.vehicleRaw ?? b.indent ?? "")) ? "6 excluded: lubricant (OIL)" : "6 other"
    outcomes.push({ source: "purchase book", src: b.src, date: b.date ?? null, indent: indentText(b.indent), vehicle: String(b.vehicleRaw ?? ""), litres: b.qty, rate: b.rate ?? null, amount: b.amt, outcome, erpId: [l && loadIn ? l.id : null, py && payIn ? py.id : null].filter(Boolean).join(" "),
      detail: [b.pay ? `payment ${b.pay}${b.payDateRaw ? ` (${b.payDateRaw})` : ""}` : null, b.note ? `note ${b.note}` : null, ...(issuesBySrc.get(b.src) ?? []).map((i) => i.topic)].filter(Boolean).join("; ") })
  }
  const adblue = load<{ src: string; date: string | null; vehicle: string; description: string; vendor: string; gross: number | null; total: number | null; adblueOnly: boolean; fluid: boolean }[]>("adblue_lines.json")
  for (const a of adblue.filter((a) => a.date && a.date >= from))
    outcomes.push({ source: "maintenance register (AdBlue)", src: a.src, date: a.date, indent: "", vehicle: a.vehicle, litres: null, rate: null, amount: a.total, outcome: "5 quarantined (AdBlue: GST and quantity rules not confirmed)", erpId: "", detail: `${a.description} · ${a.vendor} · gross ${a.gross}` })

  // 6. Write the test files.
  const tankersW = useSplit || !answeredStock ? tankerRecords : tankerRecords.map((t) => (t.id === COMBINED ? { ...t,
    notes: "JIO, Office and Mini together. The tank labels are known (uncle's answer S-04: NEW TANK = JIO, MINI TANK = Mini, OFFICE TANK = Office), but split by tanker the records go below zero (Mini from 1 Sep; JIO on 21 Sep) — see SEPT_OCT_FUEL_IMPORT_ISSUES.md S-21 / S-22. Each fill notes its tanker. Split with transfers once resolved." } : t))
  const testFile: BackupFile = {
    format: "vishal-erp-backup", version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), label: `Fuel TEST import ${from} to ${latestSourceDate} from Data`,
    settings: { ...settings, tanker: undefined },
    collections: { customers: customersW, vehicles: vehiclesW, drivers: [], trips: [], diesel_entries: dieselW, adblue_entries: [], vehicle_assignments: assignmentsW, month_locks: [],
      fuel_stations: stationsW, adblue_purchases: [], tanker_loads: loadsW, tanker_dispenses: externalW, tankers: tankersW, tanker_transfers: [], tanker_adjustments: [], invoices: [], payments: paymentsW },
  }
  const outDir = OUT_ARG ? OUT_ARG : join(ROOT, "import", `test-${from.slice(0, 7)}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "vishal-fuel-test-import.json"), JSON.stringify(testFile))
  const winSrc = new Set(dieselW.map((d) => diesel.find((x) => x.id === d.id)!.__src.src))
  writeFileSync(join(outDir, "mapping.json"), JSON.stringify({
    diesel: diesel.filter((d) => inWin(d.date)).map((d) => ({ id: d.id, src: d.__src.src, how: d.__how, sourceLitres: d.__src.litres, sourceAmount: d.__srcAmount, sourceRate: d.__src.rate, indent: indentText(d.__src.indent), tanker: fillTanker.get(d.id)?.name ?? null, tankerBasis: fillTanker.get(d.id)?.basis ?? null })),
    tankerLoads: loads.filter((l) => !l.opening && inWin(l.date)).map((l) => ({ id: l.id, src: l.__src, tanker: tankerByReg(l.__tanker ?? "")?.name ?? null, regNo: l.__tanker ?? null })),
    payments: payments.filter((x) => inWin(x.date)).map((x) => ({ id: x.id, paymentNo: x.paymentNo, src: x.__src })),
    corrections: corrections.filter((c) => winSrc.has(c.src) || [...book].some((b) => b.src === c.src && inWin(b.date))),
  }, null, 1))
  const issuesW = issues.filter((i) => outcomes.some((o) => o.src === i.src) || i.src.includes("|"))
  const recOut = { generatedAt: new Date().toISOString(), from, runDate: RUN_DATE, latestSourceDate, months: winMonths,
    counts: Object.fromEntries(Object.entries(testFile.collections).map(([k, v]) => [k, (v as unknown[]).length])),
    stationOpening, tankerOpening: { excelWritten: tankWritten, excelSrc: tankSrc?.src ?? null, calculated: round2(tankCalc), answered: answeredStock ? OPENING_STOCK.litres : null, used: poolOpening },
    tankerSplit: { applied: useSplit, unmapped, negatives: splitNegatives.map((n) => ({ ...n, tanker: TANKER_MASTER.find((t) => t.id === n.tankerId)?.name ?? n.tankerId, firstSrc: diesel.find((d) => d.id === n.first.id)?.__src.src ?? null, lowestSrc: diesel.find((d) => d.id === n.lowest.id)?.__src.src ?? null })) },
    duplicateStatus, negativeStockDays: negativesW, firstShortfall: tvW.shortfall, stationLedger: stationLedgerW, tanker: tankerW, customers: custW, industrial,
    tdsCheck: tdsCheck.filter((t) => winMonths.includes(t.month)), totals: statsOf(buildDieselIndex({ ...ds, diesel: valuedW, vehicles: vehiclesW, customers: customersW, assignments: assignmentsW, fuelStations: stationsW }), valuedW),
    outcomes: Object.fromEntries([...new Set(outcomes.map((o) => String(o.outcome).replace(/:.*/, "")))].map((k) => [k, outcomes.filter((o) => String(o.outcome).replace(/:.*/, "") === k).length])),
    issues: issuesW }
  writeFileSync(join(outDir, "reconciliation.json"), JSON.stringify(recOut, null, 1))
  const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  writeFileSync(join(outDir, "outcomes.csv"), [["source", "workbook › sheet › row", "date", "indent", "vehicle", "litres", "rate", "amount", "outcome", "erp id", "detail"].join(","),
    ...outcomes.map((o) => [o.source, o.src, o.date, o.indent, o.vehicle, o.litres, o.rate, o.amount, o.outcome, o.erpId, o.detail].map(csv).join(","))].join("\n"))
  console.log(JSON.stringify({ outDir, counts: recOut.counts, outcomes: recOut.outcomes, negativeDays: negativesW.length, tankerSplit: recOut.tankerSplit, firstShortfall: tvW.shortfall, stationOpening: stationOpening.filter((x) => sIds.has(x.stationId)), tankerOpening: recOut.tankerOpening, duplicateStatus }, null, 1))
}

/* ------------------------------------------------------------------ output */
const file: BackupFile = {
  format: "vishal-erp-backup", version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), label: "Fuel import FY 2026-27 (Apr–Oct 2026) from New data",
  settings: { ...settings, tanker: undefined },
  collections: { customers: [...customers.values()], vehicles, drivers: [], trips: [], diesel_entries: plainDiesel, adblue_entries: [], vehicle_assignments: assignments, month_locks: [],
    fuel_stations: stationList, adblue_purchases: [], tanker_loads: plainLoads, tanker_dispenses: plainExternal, tankers: tankerRecords, tanker_transfers: [], tanker_adjustments: [], invoices: [], payments: plainPayments },
}
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, "vishal-fuel-import-fy2026-27.json"), JSON.stringify(file))
writeFileSync(join(DIR, "mapping.json"), JSON.stringify({
  diesel: diesel.map((d) => ({ id: d.id, src: d.__src.src, how: d.__how, sourceLitres: d.__src.litres ?? d.litres, sourceAmount: d.__srcAmount, sourceRate: d.__src.rate, indent: d.billNo })),
  corrections,
  tankerLoads: loads.map((l) => ({ id: l.id, src: l.__src, tankerId: l.tankerId, sourceTanker: l.__tanker ?? null })), tankers: tankerRecords.map((t) => ({ id: t.id, name: t.name, regNo: t.regNo })), tankerDispenses: external.map((e) => ({ id: e.id, src: e.__src.src })), payments: payments.map((p) => ({ id: p.id, paymentNo: p.paymentNo, src: p.__src })),
  vehicles: [...vehicleIds].map(([regNo, id]) => ({ id, regNo, aliases: [...aliases.values()].filter((a) => a.to === regNo).map((a) => a.from), drivers: Object.fromEntries(driverOf.get(regNo) ?? []) })),
  customers: [...customers.values()].map((c) => ({ id: c.id, name: c.name, book: custCode.get(c.id) })), stations: stationList.map((s) => ({ id: s.id, name: s.name, openingBalance: s.openingBalance ?? null })),
}, null, 1))
const rec = { generatedAt: new Date().toISOString(), undatedPayments: UNDATED, fyFrom: FY_FROM, fyTo: FY_TO, runDate: RUN_DATE, latestSourceDate, counts: Object.fromEntries(Object.entries(file.collections).map(([k, v]) => [k, (v as unknown[]).length])),
  sourceRowsFY: fyFills.length, totals: { ...total, tankerClosingLitres: stock.stockLitres, tankerClosingValue: stock.stockValue }, firstShortfall: stock.shortfall, negativeStockDays: negatives,
  excludedBeforeFY: [...excludedBefore].map(([file, x]) => ({ file, ...x })).sort((a, b) => a.file.localeCompare(b.file)),
  consumptionRec, blockRec, stationRec, stationTotals, tankerRec, loadsByTanker, fillsByTankLabel, labelMismatch, tdsCheck, corrections, yearlyRec, pumpRec, issues }
writeFileSync(join(DIR, "reconciliation.json"), JSON.stringify(rec, null, 1))
const bytes = Buffer.byteLength(JSON.stringify(file.collections))
const byTopic = new Map<string, number>()
for (const i of issues) byTopic.set(`${i.severity} · ${i.topic}`, (byTopic.get(`${i.severity} · ${i.topic}`) ?? 0) + 1)
console.log(JSON.stringify({ counts: rec.counts, approxChars: bytes, fyFills: fyFills.length, firstShortfall: stock.shortfall, negativeStockDays: negatives.length, issues: Object.fromEntries([...byTopic].sort()) }, null, 1))
