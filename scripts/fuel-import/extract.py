"""
Fuel import, step 1: read the source workbooks in `New data/` (never modified) and write normalised,
traceable JSON to `import/<period>/source/`. Every record keeps its workbook, sheet and row.

    python3 -E prototype/scripts/fuel-import/extract.py            # FY 2026-27 (default)

Needs openpyxl (`pip3 install --user openpyxl`). Read-only on the source files.
"""
import datetime, json, os, re, warnings

import openpyxl
from openpyxl.utils import column_index_from_string as ci

warnings.filterwarnings("ignore")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
# Source folder and output folder can be overridden (e.g. the Sept–Oct test import reads `Data/`):
#   VT_SRC=Data VT_OUT=import/test-sep-oct-2026/source python3 -E prototype/scripts/fuel-import/extract.py
SRC = os.path.join(ROOT, os.environ.get("VT_SRC", "New data"))
OUT = os.path.join(ROOT, os.environ.get("VT_OUT", os.path.join("import", "fy2026-27", "source")))

DIESEL = os.path.join(SRC, "Diesel Data")
PURCHASE_BOOK = os.path.join(DIESEL, "2026-2027", " Total Diesel Value 2026-2027.xlsx")
VEHICLE_DOCS = os.path.join(SRC, "Vehicle Documentation Records", "vehicle documentation.xlsx")
# Workbook → customer, as the purchase book's own per-company summary names them (verified by litres).
FAMILIES = [
    ("Tata Electronics", "TEPL"), ("JASMINE", "TEPS (JASMIN)"), ("HOSUR GOODS", "HOSUR GOODS"),
    ("Vishal  Cabs", "CARS"), ("TEAL - 2", "TITAN"), ("TITAN CABS", "TITAN CABS"), ("DHOOT", "DTPL"),
    ("SCHOOL", "SCHOOL"), ("AVTEC", "AVTEC"), ("SEATING", "MINDA SEATING"), ("MINDA Switch", "MINDA SWITCH"),
    ("LUMINOUS", "LUMINOUS"), ("MJ CASTING", "MINDA CASTING"), ("JAMNA", "JAMNA"), ("RINDER", "MINDA RINDER"),
    ("JBM", "BIDADI VECHILE"), ("Hosur  Buses", "HOSUR BUSES"), ("Harohalli", "HAROHALLI"),
]
RETAIL = re.compile(r"Total Diesel Value|JIO BUNK", re.I)  # purchase book read separately; JIO BUNK = fuel retail (excluded)


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().upper()


def reg(s):
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def pdate(v):
    """dd.mm.yyyy text or a real date → yyyy-mm-dd; anything else → None (kept raw for the report)."""
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, str):
        m = re.fullmatch(r"\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s*", v)
        if m:
            d, mo, y = map(int, m.groups())
            y += 2000 if y < 100 else 0
            try:
                return datetime.date(y, mo, d).isoformat()
            except ValueError:
                return None
    return None


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def rate_from(formula):
    """=G3*88.99 → 88.99 (the rate typed into the AMOUNT formula); None if not that shape."""
    if isinstance(formula, str):
        m = re.fullmatch(r"=\s*[A-Z]+\d+\s*\*\s*([\d.]+)\s*", formula) or re.fullmatch(r"=\s*([\d.]+)\s*\*\s*[A-Z]+\d+\s*", formula)
        if m:
            return float(m.group(1))
    return None


def open_book(path):
    """Values and formulas, read-only. .xlsx_ files are ordinary workbooks with a renamed extension."""
    fv, ff = open(path, "rb"), open(path, "rb")
    return fv, ff, openpyxl.load_workbook(fv, data_only=True, read_only=True), openpyxl.load_workbook(ff, data_only=False, read_only=True)


def family(name):
    return next((c for k, c in FAMILIES if k in name), None)


# ---------------------------------------------------------------- consumption books (per-vehicle fills)
def consumption():
    rows, totals, inventory = [], [], []
    for dp, _, fn in os.walk(DIESEL):
        for f in sorted(fn):
            if not f.endswith((".xlsx", ".xlsx_")):
                continue
            path = os.path.join(dp, f)
            rel = os.path.relpath(path, SRC)
            if RETAIL.search(f):
                inventory.append({"file": rel, "role": "purchase book" if "Total Diesel" in f else "EXCLUDED: fuel retail (JIO BUNK)"})
                continue
            fv, ff, wv, wf = open_book(path)
            sheets = []
            for wsv, wsf in zip(wv.worksheets, wf.worksheets):
                hdr = title = None
                n = 0
                for i, (rv, rf) in enumerate(zip(wsv.iter_rows(values_only=True), wsf.iter_rows(values_only=True)), 1):
                    n = i
                    cells = [norm(v) if v is not None else "" for v in rv]
                    t = next((c for c in cells if c.startswith("DIESEL CHARGES FOR THE MONTH")), None)
                    if t:
                        title = t.replace("DIESEL CHARGES FOR THE MONTH OF", "").strip()
                    if any("QUANTITY" in c for c in cells) and "DATE" in cells:
                        end = next((j for j in range(4, len(cells)) if cells[j] in ("SL NO", "SI NO")), len(cells))
                        hdr = cells[:end]
                        continue
                    if not hdr:
                        continue

                    def col(*names):
                        return next((j for j, c in enumerate(hdr) if any(c == x or c.startswith(x) for x in names)), None)

                    ix = {"indent": col("INDENT"), "date": col("DATE"), "veh": col("VEHICLE", "VECHILE"), "driver": col("DRIVER"),
                          "vtype": col("TYPE OF VEHICLE"), "qty": col("QUANTITY", "QTY"), "amt": col("AMOUNT"), "open": col("OPEN KM"),
                          "close": col("CLOSE KM", "CLOSING KM"), "rate": col("RATE")}
                    g = lambda k, r=rv: r[ix[k]] if ix[k] is not None and ix[k] < len(r) else None
                    q = num(g("qty"))
                    first = cells[0] if cells else ""
                    if "TOTAL" in first or (cells and any(c == "TOTAL" for c in cells[:3])):
                        if q is not None:
                            totals.append({"file": rel, "sheet": wsv.title, "row": i, "block": title, "litres": q, "amount": num(g("amt"))})
                        continue
                    if q is None or q == 0:
                        continue
                    amt_formula = g("amt", rf)
                    rows.append({
                        "src": f"{rel} › {wsv.title} › row {i}", "file": rel, "sheet": wsv.title, "row": i, "block": title,
                        "customer": family(f), "indent": g("indent"), "dateRaw": None if g("date") is None else str(g("date")),
                        "date": pdate(g("date")), "vehicleRaw": g("veh"), "vehicle": reg(g("veh")), "driver": g("driver"), "slot": g("vtype"),
                        "litres": q, "amount": num(g("amt")), "amountFormula": amt_formula if isinstance(amt_formula, str) else None,
                        "rate": num(g("rate")) or rate_from(amt_formula), "openKm": num(g("open")), "closeKm": num(g("close")),
                        "extra": [v for v in rv[len(hdr):] if v not in (None, "")][:3],
                    })
                sheets.append({"sheet": wsv.title, "state": wsv.sheet_state, "rowsRead": n})
            inventory.append({"file": rel, "role": "consumption book", "customer": family(f), "sheets": sheets})
            for x in (wv, wf):
                x.close()
            fv.close(); ff.close()
    return rows, totals, inventory


# ---------------------------------------------------------------- purchase book (stations, loads, payments)
# One map per month: station blocks with their columns (header row 3). Read from the sheets themselves.
B = lambda station, **c: {"station": station, **c}
MONTHS = {
    "APRIL 2026": [
        B("Shree Shankara", sl="A", date="B", indent="C", veh="E", qty="F", rate="G", amt="H", pay="I", payDate="J"),
        B("Mahadeshwara Agencies", sl="M", date="N", qty="O", rate="P", amt="Q", pay="R", payDate="S"),
        B("CARD RECHARGE", sl="V", date="W", amt="Z", pay="AA", excluded="card top-ups: money paid into a fuel card, not a fuel purchase"),
        B("Aries Gemini Energy", sl="AD", date="AE", veh="AF", qty="AG", rate="AH", amt="AI", pay="AJ", payDate="AK"),
        B("Raghuveer Fuels", sl="AM", date="AN", veh="AO", qty="AP", rate="AQ", amt="AR", pay="AS", payDate="AT"),
        B("Lakshmitha Fuels", sl="AV", date="AW", veh="AX", qty="AY", rate="AZ", amt="BA", pay="BB", payDate="BC"),
        B("JP Brother Indian Oil", sl="BD", date="BE", veh="BF", qty="BG", rate="BH", amt="BI", pay="BJ", payDate="BK"),
        B("Shrudu Fuel Station", sl="BL", date="BM", veh="BN", qty="BO", rate="BP", amt="BQ", pay="BR", payDate="BS"),
    ],
    "MAY 2026": [
        B("Shree Shankara", sl="A", date="B", veh="C", qty="D", rate="E", amt="F", pay="G", payDate="H"),
        B("Mahadeshwara Agencies", sl="J", date="K", qty="L", rate="M", amt="N", pay="O", payDate="P"),
        B("Raghuveer Fuels", sl="S", date="T", veh="U", qty="W", rate="X", amt="Y", pay="Z", payDate="AA"),
        B("JP Brother Indian Oil", sl="AD", date="AE", veh="AF", qty="AG", rate="AH", amt="AI", pay="AJ", payDate="AK"),
        B("Shrudu Fuel Station", sl="AM", date="AN", veh="AO", qty="AP", rate="AQ", amt="AR", pay="AS", payDate="AT"),
    ],
    "JUNE 2026": [
        B("Shree Shankara", sl="A", date="B", veh="C", qty="D", rate="E", amt="F", pay="G", payDate="H"),
        B("Mahadeshwara Agencies", sl="J", date="K", qty="L", rate="M", amt="N", pay="O", payDate="P"),
        B("Raghuveer Fuels", sl="S", date="T", veh="U", qty="W", rate="X", amt="Y", pay="Z", payDate="AA"),
        B("JP Brother Indian Oil", sl="AD", date="AE", veh="AF", qty="AG", rate="AH", amt="AI", pay="AJ", payDate="AK"),
        B("Shrudu Fuel Station", sl="AM", date="AN", veh="AO", qty="AP", rate="AQ", amt="AR", pay="AS", payDate="AT"),
        B("Lakshmitha Fuels", sl="AV", date="AW", veh="AX", qty="AY", rate="AZ", amt="BA", pay="BB", payDate="BC"),
        B("Samruddhi Fuels", sl="BF", date="BG", veh="BH", qty="BI", rate="BJ", amt="BK", pay="BL", payDate="BM"),
    ],
    "JULY 2026": [
        B("Vishal Gasoline", sl="A", indent="B", date="C", veh="D", qty="E", rate="F", amt="G", pay="H", payDate="I", note="J"),
        B("Shree Shankara", sl="K", date="L", veh="M", qty="N", rate="O", amt="P", pay="Q", payDate="R"),
        B("Mahadeshwara Agencies", sl="T", date="U", qty="V", rate="W", amt="X", pay="Y", payDate="Z"),
        B("Raghuveer Fuels", sl="AC", date="AD", veh="AE", qty="AG", rate="AH", amt="AI", pay="AJ", payDate="AK"),
        B("JP Brother Indian Oil", sl="AN", date="AO", veh="AP", qty="AQ", rate="AR", amt="AS", pay="AT", payDate="AU"),
        B("Shrudu Fuel Station", sl="AW", date="AX", veh="AY", qty="AZ", rate="BA", amt="BB", pay="BC", payDate="BD"),
        B("Lakshmitha Fuels", sl="BF", date="BG", veh="BH", qty="BI", rate="BJ", amt="BK", pay="BL", payDate="BM"),
        B("Samruddhi Fuels", sl="BP", date="BQ", veh="BR", qty="BS", rate="BT", amt="BU", pay="BV", payDate="BW"),
    ],
    "AUG 2026": [
        B("Vishal Gasoline", sl="A", indent="B", date="C", veh="D", qty="E", rate="F", amt="G", pay="H", payDate="I", note="J"),
        B("Shree Shankara", sl="K", date="L", veh="M", qty="N", rate="O", amt="P", pay="Q", payDate="R"),
        B("Mahadeshwara Agencies", sl="T", date="U", qty="X", rate="Y", amt="Z", pay="AA", payDate="AB"),
        B("Raghuveer Fuels", sl="AE", date="AF", veh="AG", qty="AI", rate="AJ", amt="AK", pay="AL", payDate="AM"),
    ],
    "SEP  2026": [
        B("Vishal Gasoline", sl="A", indent="B", date="C", veh="D", qty="E", rate="F", amt="G", pay="H", payDate="I", note="J"),
        B("Shrudu Fuel Station", sl="K", date="L", veh="M", qty="N", rate="O", amt="P", pay="Q", payDate="R"),
        B("INDUSTRIAL SUPPLY", sl="T", indent="U", date="V", veh="W", qty="X", rate="Y", amt="Z", pay="AA", payDate="AB", note="AC",
          excluded="industrial supply: diesel resold to other companies (fuel retail)"),
        B("Raghuveer Fuels", sl="AE", date="AF", veh="AG", qty="AI", rate="AJ", amt="AK", pay="AL", payDate="AM"),
    ],
    "OCT 2026": [
        B("Vishal Gasoline", sl="A", indent="B", date="C", veh="D", qty="E", rate="F", amt="G", pay="H", payDate="I", note="J"),
        B("Shrudu Fuel Station", sl="K", date="L", veh="M", qty="N", rate="O", amt="P", pay="Q", payDate="R"),
        B("INDUSTRIAL SUPPLY", sl="T", indent="U", date="V", veh="W", qty="X", rate="Y", amt="Z", pay="AA", payDate="AB", note="AC",
          excluded="industrial supply: diesel resold to other companies (fuel retail)"),
        B("Raghuveer Fuels", sl="AE", date="AF", veh="AG", qty="AI", rate="AJ", amt="AK", pay="AL", payDate="AM"),
        B("Lakshmitha Fuels", sl="AO", date="AP", veh="AQ", qty="AR", rate="AS", amt="AT", pay="AU", payDate="AV"),
    ],
}


def purchase_book():
    """Every non-empty cell of every station block, row by row, classified later by the builder."""
    fv, ff, wv, wf = open_book(PURCHASE_BOOK)
    rel = os.path.relpath(PURCHASE_BOOK, SRC)
    out, summaries = [], []
    for month, blocks in MONTHS.items():
        grid_v = [list(r) for r in wv[month].iter_rows(values_only=True)]
        grid_f = [list(r) for r in wf[month].iter_rows(values_only=True)]
        at = lambda g, r, c: g[r][ci(c) - 1] if c and r < len(g) and ci(c) - 1 < len(g[r]) else None
        for b in blocks:
            for r in range(3, len(grid_v)):
                sl = at(grid_v, r, b["sl"])
                if isinstance(sl, str) and "TOTAL" in sl.upper():
                    out.append({"month": month, "station": b["station"], "src": f"{rel} › {month.strip()} › {b['station']} (columns {b['sl']}…) › row {r + 1}", "row": r + 1, "kind": "TOTAL",
                                "qty": num(at(grid_v, r, b.get("qty"))), "amt": num(at(grid_v, r, b.get("amt"))), "pay": num(at(grid_v, r, b.get("pay"))), "excluded": b.get("excluded")})
                    break
                cell = {k: at(grid_v, r, b[k]) for k in ("indent", "date", "veh", "qty", "rate", "amt", "pay", "payDate", "note") if b.get(k)}
                if all(v in (None, "", 0) for k, v in cell.items() if k not in ("rate",)):
                    continue
                qf = at(grid_f, r, b.get("qty"))
                out.append({"month": month, "station": b["station"], "src": f"{rel} › {month.strip()} › {b['station']} (columns {b['sl']}…) › row {r + 1}", "row": r + 1, "kind": "ROW",
                            "indent": cell.get("indent"), "dateRaw": None if cell.get("date") is None else str(cell.get("date")), "date": pdate(cell.get("date")),
                            "vehicleRaw": cell.get("veh"), "vehicle": reg(cell.get("veh")), "qty": num(cell.get("qty")), "qtyFormula": qf if isinstance(qf, str) else None,
                            "rate": num(cell.get("rate")), "amt": num(cell.get("amt")), "pay": num(cell.get("pay")), "payDateRaw": None if cell.get("payDate") is None else str(cell.get("payDate")),
                            "payDate": pdate(cell.get("payDate")), "note": cell.get("note"), "excluded": b.get("excluded")})
        # The sheet's own summaries ("BUNK NAME … OUTSTANDING", stock carried, per-company litres) — reconciliation only.
        for r, row in enumerate(grid_v):
            for c, v in enumerate(row):
                if isinstance(v, str) and norm(v) in ("STOCK CARRIED FROM PREVIOUS MONTH", "STOCK CARRIED FOR NEXT MONTH", "BALANCE TO PAY", "DIFFERENCE", "TATA TANK", "OFFICE TANK", "DIESEL CARD", "INDUSTRIAL CONSUMPTION", "NET CONSUMPTION"):
                    summaries.append({"month": month, "src": f"{rel} › {month.strip()} › row {r + 1}", "label": norm(v), "values": [x for x in row[c + 1:c + 6] if x is not None]})
            if any(isinstance(v, str) and norm(v) == "COMPANY NAMES" for v in row):
                c0 = next(c for c, v in enumerate(row) if isinstance(v, str) and norm(v) == "COMPANY NAMES")
                for rr in range(r + 1, min(r + 20, len(grid_v))):
                    name = grid_v[rr][c0] if c0 < len(grid_v[rr]) else None
                    if not name:
                        continue
                    if norm(name) == "TOTAL" or (isinstance(name, str) and name.strip()):
                        summaries.append({"month": month, "src": f"{rel} › {month.strip()} › row {rr + 1}", "label": "COMPANY", "company": norm(name),
                                          "litres": num(grid_v[rr][c0 + 1]), "amount": num(grid_v[rr][c0 + 2])})
            if any(isinstance(v, str) and norm(v) == "BUNK NAME" for v in row):
                c0 = next(c for c, v in enumerate(row) if isinstance(v, str) and norm(v) == "BUNK NAME")
                for rr in range(r + 1, min(r + 14, len(grid_v))):
                    name = grid_v[rr][c0] if c0 < len(grid_v[rr]) else None
                    if isinstance(name, str) and name.strip():
                        vals = grid_v[rr][c0 + 1:c0 + 6]
                        summaries.append({"month": month, "src": f"{rel} › {month.strip()} › row {rr + 1}", "label": "BUNK", "bunk": norm(name), "values": vals})
    tot = []
    for r, row in enumerate(wv["Total "].iter_rows(values_only=True)):
        if isinstance(row[2] if len(row) > 2 else None, datetime.datetime):
            tot.append({"src": f"{rel} › Total › row {r + 1}", "month": row[2].date().isoformat()[:7], "litres": num(row[3]), "amount": num(row[4]), "paid": num(row[5]), "outstanding": num(row[6])})
    sheet_names = wv.sheetnames
    for x in (wv, wf):
        x.close()
    fv.close(); ff.close()
    return out, summaries, tot, {"file": rel, "role": "purchase book", "sheets": sheet_names, "mapped": list(MONTHS)}


# ---------------------------------------------------------------- vehicle aliases (KA → TN re-registration)
def aliases():
    fv = open(VEHICLE_DOCS, "rb")
    wb = openpyxl.load_workbook(fv, data_only=True, read_only=True)
    out = []
    for r, row in enumerate(wb["KA TO TN CHANGE"].iter_rows(values_only=True), 1):
        if r > 1 and row[1] and row[2]:
            out.append({"src": f"Vehicle Documentation Records/vehicle documentation.xlsx › KA TO TN CHANGE › row {r}", "from": reg(row[1]), "to": reg(row[2])})
    wb.close(); fv.close()
    return out


# ---------------------------------------------------------------- AdBlue in the maintenance invoice registers (listed, not imported)
MAINT = os.path.join(SRC, "Purchase-Maintenance Data ")
ADBLUE = re.compile(r"AD ?BLUE|\bDEF\b", re.I)


def adblue_lines():
    out = []
    for company in ("VTHPL", "VTT"):
        folder = os.path.join(MAINT, company, "2026 - 2027")
        for f in sorted(os.listdir(folder)):
            if not f.endswith(".xlsx"):
                continue
            path = os.path.join(folder, f)
            fh = open(path, "rb")
            wb = openpyxl.load_workbook(fh, data_only=True, read_only=True)
            for ws in wb.worksheets:
                hdr = None
                for i, r in enumerate(ws.iter_rows(values_only=True), 1):
                    cells = [norm(v) if v is not None else "" for v in r]
                    if "PURPOSE" in cells and "GROSS" in cells:
                        hdr = cells
                        continue
                    if not hdr:
                        continue
                    g = lambda name: r[hdr.index(name)] if name in hdr and hdr.index(name) < len(r) else None
                    desc = g("PURPOSE")
                    if not (isinstance(desc, str) and ADBLUE.search(desc)):
                        continue
                    date = pdate(g("DATE")) or pdate(next((v for v in r if isinstance(v, datetime.datetime)), None))
                    if not date or not ("2026-04-01" <= date <= "2027-03-31"):
                        continue
                    parts = [p.strip() for p in re.split(r"/", desc) if p.strip()]
                    fluid = [p for p in parts if re.search(r"AD ?BLUE", p, re.I) or (re.search(r"\bDEF\b", p, re.I) and not re.search(r"FILTER|PUMP|TANK", p, re.I))]
                    qty = re.search(r"QTY\s*-?\s*([\d.]+)", " ".join(fluid), re.I)
                    out.append({"src": f"{os.path.relpath(path, SRC)} › {ws.title} › row {i}", "company": company, "date": date, "vehicle": reg(g("VEHICLE NO")),
                                "site": g("COMANY NAME") or g("COMPANY"), "description": desc, "vendor": g("CUSTOMER NAME"), "gross": num(g("GROSS")),
                                "total": num(g("TOTAL")) or num(g("AMOUNT")) or num(g("GRAND TOTAL")), "adblueOnly": bool(fluid) and len(fluid) == len(parts), "fluid": bool(fluid),
                                "qty": float(qty.group(1)) if qty else None, "litresStated": bool(re.search(r"LTR|LITRE|LTS", " ".join(fluid), re.I))})
            wb.close(); fh.close()
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    if "--adblue" in os.sys.argv:
        lines = adblue_lines()
        json.dump(lines, open(os.path.join(OUT, "adblue_lines.json"), "w"), indent=1, default=str)
        print(f"AdBlue invoice lines {len(lines)} (AdBlue only {sum(1 for x in lines if x['adblueOnly'])})")
        return
    rows, totals, inventory = consumption()
    purchases, summaries, yearly, pinv = purchase_book()
    inventory.append(pinv)
    al = aliases()
    write = lambda name, data: json.dump(data, open(os.path.join(OUT, name), "w"), indent=1, default=str)
    write("consumption.json", rows)
    write("consumption_totals.json", totals)
    write("purchase_book.json", purchases)
    write("purchase_summaries.json", summaries)
    write("purchase_yearly.json", yearly)
    write("aliases.json", al)
    write("inventory.json", inventory)
    write("adblue_lines.json", adblue_lines())
    print(f"consumption rows {len(rows)}, block totals {len(totals)}, purchase-book cells/rows {len(purchases)}, summaries {len(summaries)}, aliases {len(al)}")


if __name__ == "__main__":
    main()
