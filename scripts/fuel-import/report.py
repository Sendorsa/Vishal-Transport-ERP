"""
Fuel import, step 3: write the reconciliation report (import/fy2026-27/RECONCILIATION.md) and the full
issue list (issues.csv) from what extract.py and build.ts produced. Read-only on everything else.

    python3 -E prototype/scripts/fuel-import/report.py [--out=<dir>] [--previous=<previous import json>]

--out: read and write a dry-run folder instead of import/fy2026-27 (the source is always import/fy2026-27/source).
--previous: the import file this one replaces — writes CHANGES.md / changes.json (every record added, removed or changed).
"""
import collections, csv, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ARG = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
DIR = ARG.get("out") or os.path.join(ROOT, "import", "fy2026-27")
SRC = os.path.join(ROOT, "import", "fy2026-27", "source")
J = lambda *p: json.load(open(os.path.join(DIR, *p)))
S = lambda f: json.load(open(os.path.join(SRC, f)))
rec, mapping, data = J("reconciliation.json"), J("mapping.json"), J("vishal-fuel-import-fy2026-27.json")
inventory, fills, adblue = S("inventory.json"), S("consumption.json"), S("adblue_lines.json")
others, book = S("other_workbooks_scan.json"), S("purchase_book.json")
C = data["collections"]
issues = rec["issues"]


def inr(x):
    """₹ with Indian grouping and 2 decimals (the app's formatINR)."""
    if x is None:
        return "—"
    neg, x = x < 0, abs(round(x + 0.0, 2))
    whole, frac = f"{x:.2f}".split(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    s = ",".join(([head] if head else []) + groups + [tail]) if len(whole) > 3 else whole
    return f"{'−' if neg else ''}₹{s}.{frac}"


def n(x, d=2):
    return "—" if x is None else f"{x:,.{d}f}"


def diff(a, b):
    return None if a is None or b is None else round(a - b, 2)


out = []
w = out.append
by_file = collections.Counter(f["file"] for f in fills)
fy = [f for f in fills if f["date"] and "2026-04-01" <= f["date"] <= "2027-03-31"]
fy_by_file = collections.Counter(f["file"] for f in fy)
imported_src = {m["src"] for m in mapping["diesel"]} | {m["src"] for m in mapping["tankerDispenses"]} | {m["src"] for m in mapping["tankerLoads"]} | {m["src"] for m in mapping["payments"]}
imp_by_file = collections.Counter(s.split(" › ")[0] for s in imported_src)
iss_by_file = collections.defaultdict(collections.Counter)
for i in issues:
    iss_by_file[i["src"].split(" › ")[0]][i["severity"]] += 1

w("# Fuel import FY 2026-27 — reconciliation report\n")
from datetime import date as _date
_cut = _date.fromisoformat(rec["latestSourceDate"]).strftime("%-d %B %Y")
w(f"Generated {rec['generatedAt'][:19].replace('T', ' ')} UTC from `New data/` (read-only). Period: **1 April 2026 – {_cut}** (FY 2026-27 from its first day; the cutoff is the latest real date in the source).")
w("Every figure below comes from `reconciliation.json`; every flagged, excluded or quarantined row is listed in `issues.csv` with its workbook, sheet and row; every value the import changed from the source is in section 9 and `mapping.json → corrections`.\n")
w("**Business rules applied** (owner's decisions and the uncle's answers — see `issues.md` for each): FY 2026-27 only (1 Apr 2026 – 31 Mar 2027) · fuel retail excluded · **tank fills costed at the rate in their own AMOUNT formula** (answer 23) · **three tankers** TN70AX9480, KA53C0538, KA51AF1429 in the tanker master; this period's tanker history kept as one *combined stock* until the uncle says which tanker MINI / NEW / OFFICE TANK means (answer 24) · TN70AU5763 / TN70AU5796 short registrations mapped to their sheets, DTPL (A-1) · 4 confirmed duplicates counted once (A-3, A-4) · generator / bunk / can diesel charged to **Jio Bunk** (A-5) · KA51MW5115 = **owner's personal vehicle** (A-6) · Shrudu load years = 2026 (answer 13) · **TDS** = a deduction dated the month's last day (answer 14) · 53 Titan Cabs zero-amount cash fills at 0 L (answer 22) · APJ July loads kept and dispensed to APJ · unidentified pumps kept under “Pump not identified” · AdBlue invoices classified, not imported (GST and bucket questions open).\n")

w("## 1. Summary of imported records\n")
w("| Section | Records |\n|---|---|")
for k, label in [("customers", "Customers (one per diesel book)"), ("vehicles", "Vehicles"), ("vehicle_assignments", "Vehicle assignment periods"), ("fuel_stations", "Fuel stations (incl. Diesel Tanker source)"),
                 ("diesel_entries", "Diesel entries"), ("tankers", "Tankers (3 tankers + the combined pre-split stock)"), ("tanker_loads", "Tanker loads (incl. 1 opening stock)"), ("tanker_dispenses", "External tanker dispenses"), ("payments", "Fuel station payments (incl. TDS entries)"),
                 ("adblue_purchases", "AdBlue purchases"), ("adblue_entries", "AdBlue entries")]:
    w(f"| {label} | {len(C.get(k, [])):,} |")
t = rec["totals"]
w(f"\nDiesel as the app reports it (tank fills at the rate on each fill): **{n(t['litres'])} L**, **{inr(t['spend'])}**, {t['km']:,} km, {t['kmpl']} km/L. Combined tanker stock on {_cut}: **{n(t['tankerClosingLitres'])} L** (stock valuation at the weighted-average load cost, internal only: {inr(t['tankerClosingValue'])}). No tanker's stock goes below zero (first shortfall: {rec['firstShortfall'] or 'none'}).\n")

w("## 2. Files inspected\n")
w("### Diesel Data (consumption books and the purchase book)\n")
w("| Workbook | Role | Sheets | Fill rows read (all years) | FY 2026-27 fill rows | Imported | Flags / exclusions / unresolved |\n|---|---|---|---|---|---|---|")
seen_files = set()
for it in sorted(inventory, key=lambda x: -len(x.get("sheets", []))):
    f = it["file"]
    if f in seen_files:
        continue
    seen_files.add(f)
    if "Total Diesel Value 2025" in f:
        it = {**it, "role": "purchase book FY 2025-26 (outside the import period; not mapped)"}
    k = f
    iss = iss_by_file.get(f, {})
    w(f"| {f.replace('Diesel Data/', '')} | {it['role']}{(' — ' + it['customer']) if it.get('customer') else ''} | {len(it.get('sheets', []))} | {by_file.get(f, 0):,} | {fy_by_file.get(f, 0):,} | {imp_by_file.get(f, 0):,} | {', '.join(f'{v} {s}' for s, v in sorted(iss.items())) or '—'} |")
w("\nSheets and row ranges read per workbook are in `source/inventory.json` (every sheet, rows 1…last). Hidden sheets: none in these workbooks. Rows before 1 April 2026 were read but are outside the import period; several 2026-2027 books are copies of the 2025-26 books (e.g. Harohalli is byte-identical, JBM P1/P2 carry 2025 data).\n")
w("### Vishal Gasoline (VT's own outlet)\n")
w("Retail operations of the outlet — nozzle sales, HSD/MS purchases from the oil company, outside-customer indents, lubes, staff salary — are **fuel retail, excluded**. Its `INDENTS` workbooks' `VISHAL` sheet is the outlet's register of what it sold to our vehicles and is used only as a cross-check (section 5.6).\n")
w("### Other folders in `New data`\n")
fold = collections.defaultdict(lambda: [0, 0])
for o in others:
    top = o["file"].split("/")[0]
    fold[top][0] += 1
    fold[top][1] += bool(o.get("hits"))
CLASS = {
    "Purchase-Maintenance Data ": "AdBlue bought at workshops/dealers (listed in section 7, not imported); other parts and labour out of scope",
    "Payroll-Salary Data": "‘Advance / diesel debit’ salary deductions — payroll, not fuel transactions",
    "Trip Sheet Data Folder": "Diesel-escalation clauses and rates in client billing — pricing, not fuel transactions",
    "New Client Quotes": "Diesel cost assumptions in quotations — not transactions",
    "Profit and Loss Dashboards": "Monthly diesel expense totals in P&L — summaries, not transactions",
    "Attach Vehicle Data": "Diesel payments netted from attached-vehicle hire — hire settlements, not fuel purchases",
    "In Process - Construction Details": "Fuel-station construction costs and diesel given to a JCB — construction project, not fleet fuel",
    "Insurance Data": "Tanker / pickup insurance — vehicle documents", "RTO Expense Data": "Tanker road tax / FC — vehicle documents",
    "KPI": "BCP documents mentioning fuel supply — policy, not transactions",
}
w("| Folder | Workbooks / files | With fuel words | Classification |\n|---|---|---|---|")
for k, (cnt, hits) in sorted(fold.items()):
    w(f"| {k.strip()} | {cnt} | {hits} | {CLASS.get(k, 'No fuel content found' if not hits else 'Mentions only')} |")
w("\nEvery workbook was scanned (sheet names and the first 60 rows of every sheet) for DIESEL / ADBLUE / HSD / TANKER / FUEL / BUNK / INDENT (`source/other_workbooks_scan.json`). The old `Data/` folder was not used.\n")

w("## 3. Source-to-ERP mapping\n")
w("""| Source | ERP record | Rule |
|---|---|---|
| Consumption book row (DATE, VEHICLE NO, QUANTITY IN LITERS, AMOUNT `=G*rate`, CLOSE KM, INDENT NO, DRIVER) | Diesel entry | date; vehicle (KA→TN re-registrations from *vehicle documentation › KA TO TN CHANGE* merged); customer = the book; litres as written; odometer = CLOSE KM (CLAUDE.md mapping; empty → no odometer); bill no. = INDENT NO; driver in notes |
| INDENT NO = MINI TANK / NEW TANK / OFFICE TANK (and FLEET with no pump bill) | Diesel entry from **Diesel Tanker**, tanker = combined stock | ₹ = litres × the rate in the row's own AMOUNT formula (answer 23); the source's saved amount is compared (5.3, `issues.csv`) |
| INDENT NO = FLEET billed by a pump the same day (purchase book vehicle row) | Diesel entry at that fuel station | e.g. KA51MW5115 30 Jul at Vishal Gasoline — imported once |
| INDENT NO = indent number / NO INDENT / card / cash | Diesel entry at a fuel station | rate from the AMOUNT formula; station = the purchase-book bill with that rate that month (or the previous month); cash/PhonePe → paid at pump; unmatched → “Pump not identified” / “Card / cash (pump not recorded)” |
| Hosur Goods OUTSIDEVEHICLE rows 144, 194, 226, 307, 447, 452, 460, 467, 537, 706 (generator, bunk, can, MJ Casting construction) | Diesel entry, customer **Jio Bunk**, placeholder “JIO BUNK (non-vehicle use)” | uncle's answer A-5 |
| Vehicle column “5763” / “5796” on sheets TN70AU5763 / TN70AU5796 | That sheet's vehicle, DTPL | uncle's answer A-1 |
| Other non-vehicle rows from a tank | External tanker dispense | vehicle no. = the text written (only APJ industrial remains) |
| Purchase book row, vehicle TN70AX9480 / KA53C0538 / KA51AF1429 | Tanker load | station = the block; litres, rate; amount = litres × rate |
| Purchase book INDENT QUANTITY / DIESEL / PETROL / cab rows | — (bills) | not records: reconciled against the fills assigned to that station (5.4) |
| Purchase book payment column (+ date) | Fuel station payment voucher | mode NEFT unless noted CASH |
| Purchase book “TDS” payment cells | TDS entry (₹0 voucher, TDS = the amount) dated the month's last day | answer 14 — settles the station's bill, never hits the bank; compared with 0.1% of that month's purchases (5.8) |
| April opening balance rows | Station opening balance (1 Apr 2026) | Aries Gemini, Raghuveer |
| April “STOCK CARRIED FROM PREVIOUS MONTH” 7,721 L × ₹90.99 | Tanker opening stock | no supplier, owed to nobody |
| Later months' opening rows | — | carry-forward check only (5.3) |
""")
w("Full id ↔ source mapping: `mapping.json` (every diesel entry, load, dispense and payment with its workbook › sheet › row).\n")

w("## 4. Source coverage\n")
sev = collections.Counter(i["severity"] for i in issues)
top = collections.Counter((i["severity"], i["topic"]) for i in issues)
w(f"FY 2026-27 consumption rows in the books: **{len(fy):,}** · imported as diesel entries **{len(C['diesel_entries']):,}** + external dispenses from books **{sum(1 for m in mapping['tankerDispenses'] if 'Diesel Data' in m['src'] and 'Total Diesel' not in m['src']):,}** · see table for the rest.\n")
w("| Severity | Topic | Rows |\n|---|---|---|")
for (s, tpc), c in sorted(top.items()):
    w(f"| {s} | {tpc} | {c:,} |")
w("\n*excluded* = deliberately not imported (reason given) · *unresolved* = needs a decision or correction in the source · *flag* = imported, with a caveat · *discrepancy* = imported, but the source disagrees with itself.\n")

w("## 5. Numerical reconciliation\n")
w("### 5.1 Fuel stations, 1 Apr – 12 Oct 2026 (source purchase book vs ERP ledger)\n")
w("| Station | Opening (source) | Opening (ERP) | Purchases (source) | Purchases (ERP) | Δ | Payments (source) | Payments (ERP) | Δ | Closing (ERP) |\n|---|---|---|---|---|---|---|---|---|---|")
for s in rec["stationTotals"]:
    w(f"| {s['station']} | {inr(s['sourceOpening'])} | {inr(s['erpOpening'])} | {inr(s['sourcePurchases'])} | {inr(s['erpPurchases'])} | {inr(diff(s['erpPurchases'], s['sourcePurchases']))} | {inr(s['sourcePayments'])} | {inr(s['erpPayments'])} | {inr(diff(s['erpPayments'], s['sourcePayments']))} | {inr(s['erpClosing'])} |")
st = {s["station"]: s for s in rec["stationTotals"]}
d = lambda name: inr(diff(st[name]["erpPurchases"], st[name]["sourcePurchases"]))
w(f"""
- **Payments reconcile exactly** for every station. “Card / cash” payments are the app's cash-at-pump rows for fills paid on the spot (no source column).
- **Purchases**: the ERP's station purchases are the individual fills and tanker loads; the source's are its bills. They agree exactly for Lakshmitha, JP Brother and Samruddhi; Shrudu differs by {d('Shrudu Fuel Station')} (paise rounding of loads); Vishal Gasoline by {d('Vishal Gasoline')} (its indent fills in the books vs its 10-day indent bills). Shree Shankara ({d('Shree Shankara')}) and Mahadeshwara ({d('Mahadeshwara Agencies')}) are short because fills billed at rates that match no bill landed in “Pump not identified” ({inr(st['Pump not identified']['erpPurchases'])}): section 5.4 shows the month-by-month gap. Aries Gemini ({d('Aries Gemini Energy')}): fills at ₹90.99 in April match Aries' rate; the source shows 50 L without a vehicle or date. Raghuveer ({d('Raghuveer Fuels')}): cab bills vs card-swipe fills differ month to month.
- TDS lines are dated the last day of their sheet's month (answer 14) and count in Payments Made as TDS. Two Lakshmitha April payments (not TDS) have no date — still dated at month end, flagged as a guess.
- Vishal Gasoline July: the source nets a −₹10,15,600 “industrial consumption” adjustment out of its payments; the ERP shows payments as made, so its July closing is ₹10,15,600 lower than the sheet's (owner's decision; APJ loads imported and dispensed to APJ).
""")
w("### 5.2 Station ledger, month by month (ERP), with the source's own carried-forward balances\n")
w("| Station | Month | Opening (ERP) | Opening written in source | Δ | Purchased | Paid | Closing |\n|---|---|---|---|---|---|---|---|")
for s in rec["stationRec"]:
    for m in s["months"]:
        w(f"| {s['station']} | {m['month']} | {inr(m['opening'])} | {inr(m['sourceOpening'])} | {inr(diff(m['opening'], m['sourceOpening']))} | {inr(m['purchased'])} | {inr(m['paid'])} | {inr(m['closing'])} |")
w("\nEvery ERP month's opening equals the previous month's closing (calculated, never stored). Where the source writes an opening balance in a later month it is compared above; differences come from payments dated in a different month than the sheet they are written in (the ERP files a payment in the month it was made — CLAUDE.md rule) and from the purchase differences in 5.1.\n")
w("### 5.3 Consumption per customer per month (diesel books vs the purchase book's company summary vs ERP)\n")
w("| Month | Customer | Fills (ERP) | Litres (ERP) | Litres (books) | Litres (summary) | Δ ERP − summary | Book ₹ (flat rates) | ERP ₹ (app costing) |\n|---|---|---|---|---|---|---|---|---|")
for r in rec["consumptionRec"]:
    w(f"| {r['month']} | {r['customer']} | {r['erpFills']:,} | {n(r['erpLitres'])} | {n(r['bookLitres'])} | {n(r['summaryLitres'])} | {n(diff(r['erpLitres'], r['summaryLitres']))} | {inr(r['bookAmount'])} | {inr(r['erpAmount'])} |")
w("""
- Litres reconcile with the summary to within its 1-decimal rounding for most customer-months. Larger differences are the source's own (the summary was typed, not linked): e.g. TEPL April −1,324.07 L, Titan Cabs / Cars June (−808.93 / +763.97 L — the two summary lines appear swapped), DTPL April +139.66 L.
- ERP litres can differ from the book litres where rows were excluded (non-vehicle pump fills, duplicates) or moved by the assignment history (`issues.csv`).
- **₹ follow the books** (answer 23): each tank fill is costed at the rate in its own AMOUNT formula, so ERP ₹ = book ₹ except paise rounding (3 rows) and rows changed by an answer (duplicates, Jio Bunk, zero-cash fills).
""")
w("### 5.4 Pump bills vs fills assigned to that station\n")
w("| Month | Station | Bill litres | Bill ₹ | Fills (ERP) | Fill litres | Fill ₹ |\n|---|---|---|---|---|---|---|")
for r in rec["pumpRec"]:
    w(f"| {r['month']} | {r['station']} | {n(r['billLitres'])} | {inr(r['billAmount'])} | {r['erpFills']:,} | {n(r['erpLitres'])} | {inr(r['erpAmount'])} |")
w("\n### 5.5 Diesel tanker stock — combined (pre-split) stock\n")
w("| Month | Opening (ERP) | Loaded | Purchase cost | Dispensed | Closing (ERP) | Source “carried from previous month” | Source “carried for next month” as written | = carried forward (answer 18) | TATA TANK | OFFICE TANK |\n|---|---|---|---|---|---|---|---|---|---|---|")
for r in rec["tankerRec"]:
    w(f"| {r['month']} | {n(r['opening'])} | {n(r['loaded'])} | {inr(r['loadedCost'])} | {n(r['dispensed'])} | {n(r['closing'])} | {n(r['sourceCarriedIn'])} | {n(r['sourceCarriedOutAsWritten'])} | {n(r['sourceCarriedForward'])} | {n(r['tataTank'])} | {n(r['officeTank'])} |")
w("""
- Opening 7,721 L (April sheet, “STOCK CARRIED FROM PREVIOUS MONTH” × ₹90.99) — stock, never a purchase.
- **Answer 18**: the negative “carried for next month” figures (−2,354 L in April, −7,467.78 L in May) are stock carried forward into the next month, written as a deduction — not negative stock. The next month opens with the same figure (May +2,354, June +7,467.78), confirming it. April's 2,354 L = TATA TANK 1,635.33 + OFFICE TANK 719 (to the litre), so the source's carried figure counts the two stationary tanks, while the ERP's stock is everything loaded minus everything dispensed. The gap (ERP April closing − 2,354 L) is unexplained by the source: it needs dip readings (pending question).
""")
w("**Loads by tanker (purchase book — the evidence for the three tankers)**\n")
w("| Tanker | Loads | Litres | ₹ | " + " | ".join(m["month"] for m in rec["loadsByTanker"][0]["byMonth"]) + " |\n|---|---|---|---|" + "---|" * len(rec["loadsByTanker"][0]["byMonth"]))
for r in rec["loadsByTanker"]:
    w(f"| {r['tanker']} | {r['loads']} | {n(r['litres'])} | {inr(r['amount'])} | " + " | ".join(n(m["litres"]) for m in r["byMonth"]) + " |")
w("\n**Fills by the tank label written in the diesel books** (the books never name the tanker):\n")
w("| INDENT NO | Fills | Litres | ₹ (source rates) |\n|---|---|---|---|")
for r in rec["fillsByTankLabel"]:
    w(f"| {r['label'] or '(blank)'} | {r['fills']:,} | {n(r['litres'])} | {inr(r['amount'])} |")
w("\nUntil the uncle confirms which tanker each label is, the history stays in the combined stock; nothing is assigned by guess. Once confirmed (with dip readings at a cut-over date), the stock is moved into each tanker with **Transfer Between Tankers** (never a purchase).\n")
y = rec["yearlyRec"]
w("### 5.6 Monthly purchase totals (source “Total” sheet) and the Vishal Gasoline cross-check\n")
w("| Month | Litres (source) | ₹ (source) | Paid (source) | Tanker loads (ERP) | Pump fills (ERP) |\n|---|---|---|---|---|---|")
for r in y:
    w(f"| {r['month']} | {n(r['litres'])} | {inr(r['amount'])} | {inr(r['paid'])} | {n(r['erpLoadLitres'])} L | {n(r['erpPumpLitres'])} L |")
vg = [d for d in C["diesel_entries"] if d["vendorId"] == "dv_vishal" and "2026-09-20" <= d["date"] <= "2026-09-30"] + [l for l in C["tanker_loads"] if l["stationId"] == "dv_vishal" and "2026-09-20" <= l["date"] <= "2026-09-30"]
w(f"\nVishal Gasoline's own indent register (*INDENTS/2026/09.SEP INDENT DETAILS › VISHAL*, 20–30 Sep): 63,945.30 L, {inr(6499485.43)}. ERP fills and loads at Vishal Gasoline dated 20–30 Sep: {n(sum(x['litres'] for x in vg))} L, {inr(sum(x['amount'] for x in vg))}.\n")
w("### 5.7 Source block TOTAL rows that don't add up\n")
w(f"{len(rec['blockRec'])} per-vehicle monthly blocks whose own TOTAL row differs from the rows above it (formula range or typing in the source):\n")
w("| Block | Month | TOTAL litres | Σ rows | TOTAL ₹ | Σ rows ₹ |\n|---|---|---|---|---|---|")
for b in rec["blockRec"]:
    w(f"| {b['src'].replace('Diesel Data/', '')} | {b['block']} | {n(b['totalLitres'])} | {n(b['rowsLitres'])} | {inr(b['totalAmount'])} | {inr(b['rowsAmount'])} |")

w("\n### 5.8 TDS (answer 14): source TDS vs 0.1% of that month's purchases\n")
w("| Station | Month | TDS in source | Month's purchases (source rows) | 0.1% | Difference |\n|---|---|---|---|---|---|")
for r in rec["tdsCheck"]:
    w(f"| {r['station']} | {r['month']} | {inr(r['sourceTds'])} | {inr(r['monthPurchases'])} | {inr(r['tdsAt0_1pct'])} | {inr(r['difference'])} |")
w("\nThree April TDS figures equal 0.1% of that month's purchases rounded up to the rupee; five don't — e.g. Shrudu's June TDS ₹11,362 matches May's purchases (₹11,362.83), and Vishal Gasoline's August / September TDS match neither month. The source amounts are imported as written (they are what was deducted); which month each covers, and the rounding rule, are open questions (issues.md).\n")
w("### 5.9 Rows outside FY 2026-27\n")
w("Rows dated before 1 April 2026 (earlier financial years — not imported):\n")
w("| Workbook | Rows | Litres |\n|---|---|---|")
for r in rec["excludedBeforeFY"]:
    w(f"| {r['file'].replace('Diesel Data/', '')} | {r['rows']:,} | {n(r['litres'])} |")
w(f"\nRows dated after the cutoff are typos and quarantined individually in `issues.csv` (“Date after FY 2026-27 (quarantined)” — {sum(1 for i in issues if i['topic'].startswith('Date after'))} rows). Opening balances on 1 April 2026 are separate records (station openings, tanker opening stock), never purchases.\n")

w("\n## 6. Unresolved items and source ambiguities\n")
for topic in sorted({i["topic"] for i in issues if i["severity"] in ("unresolved", "discrepancy")} | {"Duplicate (same fill in another workbook) — inferred, to confirm"}):
    rows = [i for i in issues if i["topic"] == topic]
    if not rows:
        continue
    w(f"**{topic}** ({len(rows)})\n")
    for i in rows[:12]:
        w(f"- `{i['src'].replace('Diesel Data/', '')}` — {i['detail']}")
    if len(rows) > 12:
        w(f"- … {len(rows) - 12} more in `issues.csv`")
    w("")
w("""**Not in the fuel books (defaults used, review in the app):** vehicle and customer details (make, model, GST, address, pricing — left blank); company VT/VTHPL (all set to VT); fuel type (all Diesel — some cars fill at petrol prices, e.g. ₹109.74 at Vishal Gasoline); payment mode (NEFT unless the source says CASH); station locations (blank).
""")
w("## 7. AdBlue (classified, not imported — GST and quantity questions open)\n")
w("Answer 25: AdBlue is bought both in bulk (into stock) and directly for a vehicle. The ERP now has both workflows (AdBlue → Add Bulk Purchase; vehicle → AdBlue → Direct Vendor Purchase). The invoice lines are **not imported yet** because Problem 25's other two questions are open: whether GST is part of the cost, and whether “20L QTY-10” means ten 20-litre buckets. Proposed classification of each line, from what the register shows:\n")
import re as _re
def _cls(x):
    if not x["fluid"]:
        return "DEF filter / part — not AdBlue fluid"
    if not x["adblueOnly"]:
        return "Mixed with other parts / labour — split needed"
    v = (x["vehicle"] or "").upper()
    if _re.fullmatch(r"(KA|TN)\d{1,2}[A-Z]{0,3}\d{3,4}", v):
        return "Direct purchase candidate (one vehicle on the invoice)"
    return "Bulk purchase candidate (fleet / customer label or no vehicle)"
_c = collections.Counter(_cls(x) for x in adblue)
_amt = collections.defaultdict(float)
for x in adblue:
    _amt[_cls(x)] += x["total"] or 0
w("| Proposed treatment | Lines | Invoice total incl. GST |\n|---|---|---|")
for k, v in sorted(_c.items()):
    w(f"| {k} | {v} | {inr(_amt[k])} |")
w("")
fl = [x for x in adblue if x["fluid"]]
w(f"The fuel books carry no AdBlue quantities (only an “ADBLUE” marker in TEAL-2 and empty “ADBLUE DETAILS” blocks in Tata Electronics). AdBlue was bought per vehicle at workshops and dealers and appears in the maintenance invoice registers: **{len(adblue)} lines** in FY 2026-27, **{sum(1 for x in fl if x['adblueOnly'])} AdBlue-only** (invoice total {inr(sum(x['total'] or 0 for x in fl if x['adblueOnly']))}), **{sum(1 for x in fl if not x['adblueOnly'])} mixed** with other parts/labour in one value, {len(adblue) - len(fl)} DEF filters/parts only. Full list: `source/adblue_lines.json`.\n")
w("| Date | Vehicle | Vendor | Description | Gross ₹ | Total ₹ | Proposed |\n|---|---|---|---|---|---|---|")
for x in sorted(adblue, key=lambda x: x["date"] or ""):
    w(f"| {x['date']} | {x['vehicle'] or '—'} | {x['vendor']} | {str(x['description'])[:70]} | {inr(x['gross'])} | {inr(x['total'])} | {_cls(x)} |")

w("\n## 8. How to repeat, restore or roll back\n")
w("""1. `python3 -E prototype/scripts/fuel-import/scan_others.py` (optional) and `python3 -E prototype/scripts/fuel-import/extract.py` — reads `New data/`, writes `import/fy2026-27/source/`.
2. `cd prototype && npx tsx scripts/fuel-import/build.ts [--out=<dry-run folder>]` — builds `vishal-fuel-import-fy2026-27.json`, `mapping.json`, `reconciliation.json` (same source → same ids, so re-importing replaces rather than duplicates).
3. `python3 -E prototype/scripts/fuel-import/report.py [--out=…] [--previous=<previous import file>]` — this report, `issues.csv` and `CHANGES.md`.
3a. `cd prototype && npm run import:verify` — restores the file into an in-memory app and checks it (ids, links, ledgers, stock, no duplicates on a second restore).
4. In the app as Owner or Dev: **Settings → Data → Restore from file** → choose `vishal-fuel-import-fy2026-27.json`. A backup of the current data downloads first; the restore is all-or-nothing and recorded in the Audit Log.
5. **Roll back**: restore the downloaded backup file (`vishal-erp-before-restore-*.json`) the same way.
""")
w("\n## 9. Values changed from the source (with the rule that changed them)\n")
w("| Source row | Rule | Field | Source value | Imported value |\n|---|---|---|---|---|")
for c in rec["corrections"]:
    w(f"| `{c['src'].replace('Diesel Data/', '')}` | {c['rule']} | {c['field']} | {c['before']} | {c['after']} |")
open(os.path.join(DIR, "RECONCILIATION.md"), "w").write("\n".join(out))

# ------------------------------------------------------------------ CHANGES.md: this import vs the one it replaces
if ARG.get("previous"):
    prev = json.load(open(ARG["previous"]))["collections"]
    cur = data["collections"]
    IGN = {"createdAt", "updatedAt"}
    changes, lines = {}, []
    for k in sorted(set(prev) | set(cur)):
        a = {r["id"]: r for r in prev.get(k, [])}
        b = {r["id"]: r for r in cur.get(k, [])}
        added = [i for i in b if i not in a]
        removed = [i for i in a if i not in b]
        changed = []
        for i in b:
            if i in a:
                diffs = {f: [a[i].get(f), b[i].get(f)] for f in set(a[i]) | set(b[i]) if f not in IGN and a[i].get(f) != b[i].get(f)}
                if diffs:
                    changed.append({"id": i, "changes": diffs})
        changes[k] = {"before": len(a), "after": len(b), "added": added, "removed": [a[i] for i in removed], "changed": changed}
    src = {m["id"]: m["src"] for m in mapping["diesel"] + mapping["tankerLoads"] + mapping["tankerDispenses"] + mapping["payments"]}
    lines.append("# FY 2026-27 fuel import — changes from the previous import\n")
    lines.append(f"Previous file: `{os.path.basename(ARG['previous'])}` (backed up before this run). Same deterministic ids, so a record that exists in both is the **same record, updated** — never a second copy. Every removed record is listed with its last values; `changes.json` has every field change.\n")
    lines.append("| Collection | Before | After | Added | Removed | Changed |\n|---|---|---|---|---|---|")
    for k, c in changes.items():
        lines.append(f"| {k} | {c['before']:,} | {c['after']:,} | {len(c['added']):,} | {len(c['removed']):,} | {len(c['changed']):,} |")
    lines.append("\n## Removed records\n")
    for k, c in changes.items():
        for r in c["removed"]:
            lines.append(f"- **{k}** `{r['id']}` — {r.get('date', '')} {r.get('litres', '')} L {r.get('vehicleNo', '')} · was: {json.dumps({x: r[x] for x in r if x in ('vehicleId', 'vendorId', 'amount', 'notes', 'vehicleNo', 'customerId')}, ensure_ascii=False)[:220]}")
    why = collections.Counter()
    for k, c in changes.items():
        for ch in c["changed"]:
            why[(k, ",".join(sorted(ch["changes"])))] += 1
    lines.append("\n## Changed records, by the fields that changed\n")
    lines.append("| Collection | Fields changed | Records |\n|---|---|---|")
    for (k, f), v in sorted(why.items(), key=lambda x: -x[1]):
        lines.append(f"| {k} | {f} | {v:,} |")
    lines.append("\nWhy: tank fills now carry the rate from their own AMOUNT formula (answer 23) instead of ₹0 costed at the average; every tanker record names its tanker (answer 24); TDS entries became TDS deductions (answer 14); vehicles / customers / assignments moved by the uncle's answers (A-1, A-3, A-5, A-6); 53 zero-amount cash fills at 0 L (answer 22). Each source-level change is in RECONCILIATION.md section 9.\n")
    lines.append("## Added records\n")
    for k, c in changes.items():
        for i in c["added"][:60]:
            lines.append(f"- **{k}** `{i}`{(' — ' + src[i]) if i in src else ''}")
    open(os.path.join(DIR, "CHANGES.md"), "w").write("\n".join(lines))
    json.dump(changes, open(os.path.join(DIR, "changes.json"), "w"), ensure_ascii=False, indent=1, default=str)
    print("CHANGES.md:", {k: (len(c["added"]), len(c["removed"]), len(c["changed"])) for k, c in changes.items()})
with open(os.path.join(DIR, "issues.csv"), "w", newline="") as fh:
    wr = csv.writer(fh)
    wr.writerow(["severity", "topic", "source (workbook › sheet › row)", "detail"])
    for i in issues:
        wr.writerow([i["severity"], i["topic"], i["src"], i["detail"]])
print(f"RECONCILIATION.md ({len(out)} lines), issues.csv ({len(issues)} rows)")
