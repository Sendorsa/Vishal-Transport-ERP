"""
Expense history — PREPARATION ONLY (owner, 25 Nov 2026). Reads the RTO road tax and insurance books (never modified),
matches each row to a vehicle of the ERP's vehicle master by normalised registration, and writes a review folder:

    python3 -E prototype/scripts/expense-import/extract.py

    import/expenses-history/candidates.json   rows that map to exactly one vehicle, in the Expense form's shape
    import/expenses-history/unmatched.csv     rows that can't be imported as they are, with the reason
    import/expenses-history/REVIEW.md         counts and amounts per book, section and reason; vehicles without amounts

Nothing is imported: the ERP, the database and the browser are untouched. Every candidate keeps its book, sheet and row
(`source`), so a later import can be repeated without duplicating anything. Vehicle master: the FY 2026-27 fuel import
(import/fy2026-27/vishal-fuel-import-fy2026-27.json) — the vehicles the ERP was loaded with; override with VT_VEHICLES.
Needs openpyxl.
"""
import csv, datetime, json, os, re, warnings
from collections import Counter, defaultdict

import openpyxl

warnings.filterwarnings("ignore")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DATA = os.path.join(ROOT, "Data")
OUT = os.path.join(ROOT, "import", "expenses-history")
VEHICLES = os.environ.get("VT_VEHICLES", os.path.join(ROOT, "import", "fy2026-27", "vishal-fuel-import-fy2026-27.json"))
ROAD_TAX = [os.path.join(DATA, "RTO Expense Data", "ROAD TAX DETAILS", f) for f in ("2025 - 2026.xlsx", " 2026 - 2027.xlsx")]
INSURANCE = [os.path.join(DATA, "Insurance Data", f) for f in ("2025-2026.xlsx", "2026-2027.xlsx")]
DOCS = os.path.join(DATA, "Vehicle Documentation Records", "vehicle documentation.xlsx")


def reg(s):
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def text(s):
    if isinstance(s, float) and s.is_integer():
        s = int(s)  # a number typed where a registration belongs: shown as typed, never matched
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()


def day(v):
    """dd.mm.yyyy / dd/mm/yyyy text or an Excel date → yyyy-mm-dd; anything else → None (never guessed)."""
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    m = re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", text(v))
    if not m:
        return None
    try:
        return datetime.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        return None


def money(v):
    return round(float(v), 2) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def rows(path):
    """(sheet, excel row, {header: value}) for every data row under the sheet's SL NO header (headers differ per sheet)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for ws in wb.worksheets:
        if ws.title.strip().upper() == "TOTAL":
            continue
        hdr = None
        for i, r in enumerate(ws.iter_rows(values_only=True), start=1):
            cells = [c for c in r]
            if hdr is None:
                if any(text(c).upper().startswith("SL NO") for c in cells):  # the header may start in column A or B
                    hdr = [text(c).upper() for c in cells]
                continue
            rec = {}
            for k, v in zip(hdr, cells):
                if k and k not in rec:  # the insurance books repeat SL NO / DATE for the "received payments" block: first one wins
                    rec[k] = v
            if any(v not in (None, "") for k, v in rec.items() if k != "SL NO"):
                yield ws.title.strip(), i, rec


def main():
    data = json.load(open(VEHICLES))
    vehicles = (data.get("collections") or data)["vehicles"]
    by_reg = defaultdict(list)
    for v in vehicles:
        by_reg[reg(v["regNo"])].append(v)

    # Re-registered vehicles (vehicle documentation › "KA TO TN CHANGE": same chassis, new number). Used only when the old
    # number isn't in the ERP and the new one is — the row then goes to the vehicle under its current registration.
    renamed = {}
    for sheet, row, r in rows(DOCS):
        old, new = reg(r.get("VEHICLE NUMBER")), reg(r.get("TN REGISTRATION NUMBER"))
        if old and new and old not in by_reg and len(by_reg.get(new, [])) == 1:
            renamed[old] = new

    candidates, unmatched, seen = [], [], set()

    def add(section, book, sheet, row, reg_raw, rec, why=None):
        src = f"{os.path.basename(book).strip()} › {sheet} › row {row}"
        key = reg(reg_raw)
        if key in renamed:
            rec = {**rec, "remarks": "; ".join(filter(None, [rec.get("remarks", ""), f"Paid as {text(reg_raw)} (re-registered {by_reg[renamed[key]][0]['regNo']})"]))}
            key = renamed[key]
        hits = by_reg.get(key, [])
        reason = why or (None if len(hits) == 1 else "no vehicle with this registration in the ERP" if not hits else "more than one vehicle with this registration")
        if not reason and not rec["date"]:
            reason = "date missing or not a real date"
        if not reason and rec["amount"] is None:
            reason = "amount missing or not a number"
        sig = (section, key, rec["date"], rec["description"], rec["amount"])
        if not reason and sig in seen:
            reason = "same vehicle, date, description and amount already listed (possible duplicate row)"
        if reason:
            unmatched.append({"section": section, "source": src, "registration": text(reg_raw), "date": rec["date"] or "", "description": rec["description"], "amount": "" if rec["amount"] is None else rec["amount"], "reason": reason})
            return
        seen.add(sig)
        candidates.append({**rec, "section": section, "vehicleIds": [hits[0]["id"]], "registration": hits[0]["regNo"], "source": src})

    # Road tax books: road tax, plus the rows that are really fitness fees or fines (TAX TYPE / DESCRIPTION).
    for book in ROAD_TAX:
        for sheet, row, r in rows(book):
            reg_raw = r.get("REGISTRATION NUMBER")
            if text(reg_raw).upper() in ("", "TOTAL") or text(r.get("SL NO")).upper() == "TOTAL":
                continue
            tax_type, desc = text(r.get("TAX TYPE")).upper(), text(r.get("DESCRIPTION")).upper()
            section = "FINE" if tax_type == "FINE AMOUNT" else "FITNESS" if tax_type in ("FC PURPOSE", "FC CHARGES") or desc.startswith("FC") else "ROAD_TAX"
            frm, till = day(r.get("TAX FROM")), day(r.get("TAX VALID TILL"))
            rec = {
                "date": day(r.get("DATE")),
                "description": desc or (tax_type if section != "ROAD_TAX" and tax_type not in ("SAME", "INTERSTATE") else ("DIFF TAX" if tax_type == "DIFF TAX" else "")),
                "taxType": ("Same state" if tax_type == "SAME" else "Interstate" if tax_type == "INTERSTATE" else "") if section == "ROAD_TAX" else ("FINE AMOUNT" if section == "FINE" else ""),
                "amount": money(r.get("AMOUNT")),
                "validFrom": frm if section != "FINE" and frm and till else "",
                "validTill": till if section != "FINE" and frm and till else "",
                "remarks": text(r.get("REMARKS")),
                "customerNameInBook": text(r.get("COMPANY NAME")),
            }
            if section == "FINE":
                rec["paymentStatus"] = "PAID"  # the books list what was paid; the paid day is the row's date
                rec["paymentDate"] = rec["date"] or ""
            why = None
            if section == "ROAD_TAX" and not rec["description"]:
                why = "no description (which tax?)"
            if section == "ROAD_TAX" and (frm or till) and not (frm and till):
                why = "only one of Tax From / Tax Valid Till is a date"
            add(section, book, sheet, row, reg_raw, rec, why)

    # Insurance books: what was paid = TOTAL AMOUNT (premium + GST). No policy dates in the books: the end date comes from
    # the vehicle documentation workbook only when it is exactly one policy year after the row's date (± 3 days).
    expiry = {}
    for sheet, row, r in rows(DOCS):
        k = reg(r.get("VEHICLE NUMBER"))
        d = day(r.get("INSURANCE"))
        if k and d:
            expiry[k] = d
    for book in INSURANCE:
        for sheet, row, r in rows(book):
            reg_raw = r.get("REG NO")
            if not reg(reg_raw) or "BAL" in text(reg_raw).upper():
                continue  # previous month / year balance rows — the agent's account, not a policy
            date = day(r.get("DATE"))
            provider = r.get("INSURANCE COMPANY")
            premium, gst, total = money(r.get("PREMIUM")), money(r.get("GST")), money(r.get("TOTAL AMOUNT"))
            till, why = "", None
            exp = expiry.get(reg(reg_raw))
            if date and exp:
                gap = (datetime.date.fromisoformat(exp) - datetime.date.fromisoformat(date)).days
                till = exp if 361 <= gap <= 367 else ""
            if not till:
                why = "policy end date not known (the books have none; vehicle documentation doesn't match one year)"
            if isinstance(provider, (int, float)) or not text(provider):
                provider, why = "", why or "insurance company not recorded in the book"
            rec = {
                "date": date, "description": "", "provider": text(provider), "amount": total,
                "validFrom": date if till else "", "validTill": till,
                "remarks": f"Premium {premium} + GST {gst}" if premium is not None and gst is not None else "",
            }
            add("INSURANCE", book, sheet, row, reg_raw, rec, why)

    os.makedirs(OUT, exist_ok=True)
    json.dump(candidates, open(os.path.join(OUT, "candidates.json"), "w"), indent=1)
    with open(os.path.join(OUT, "unmatched.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["section", "source", "registration", "date", "description", "amount", "reason"])
        w.writeheader()
        w.writerows(unmatched)

    # Review summary.
    def inr(x):
        return f"₹{x:,.2f}"
    lines = ["# Expense history — review before any import", "", "Prepared by `prototype/scripts/expense-import/extract.py`. **Nothing has been imported.**", "",
             f"Vehicle master used for matching: `{os.path.relpath(VEHICLES, ROOT)}` ({len(vehicles)} vehicles). Matching = registration with spaces, dashes and case ignored; one vehicle exactly, never a guess.", "",
             "## Candidates (match exactly one vehicle)", "", "| Section | Rows | Amount | Vehicles |", "|---|---:|---:|---:|"]
    for s in ("ROAD_TAX", "FITNESS", "FINE", "INSURANCE"):
        xs = [c for c in candidates if c["section"] == s]
        lines.append(f"| {s} | {len(xs)} | {inr(sum(c['amount'] for c in xs))} | {len({c['vehicleIds'][0] for c in xs})} |")
    lines += ["", "## Not importable as they are", "", "| Section | Reason | Rows | Amount |", "|---|---|---:|---:|"]
    for (s, why), n in sorted(Counter((u["section"], u["reason"]) for u in unmatched).items()):
        amt = sum(u["amount"] for u in unmatched if u["section"] == s and u["reason"] == why and isinstance(u["amount"], float))
        lines.append(f"| {s} | {why} | {n} | {inr(amt)} |")
    regs = Counter(u["registration"] for u in unmatched if u["reason"].startswith("no vehicle"))
    def one_apart(a, b):  # one character added, removed or changed
        if abs(len(a) - len(b)) > 1 or a == b:
            return False
        if len(a) == len(b):
            return sum(x != y for x, y in zip(a, b)) == 1
        short, long_ = sorted((a, b), key=len)
        return any(long_[:i] + long_[i + 1:] == short for i in range(len(long_)))
    lines += ["", f"### Registrations not in the ERP's vehicle master ({len(regs)})", "", "Never matched automatically. \"Possible typo\" = an ERP registration one character away — check which side is wrong.", "", "| Registration in the book | Rows | Possible typo of (ERP) |", "|---|---:|---|"]
    for r, n in sorted(regs.items()):
        near = sorted({v["regNo"] for v in vehicles if reg(r) and one_apart(reg(r), reg(v["regNo"]))})
        lines.append(f"| {r} | {n} | {', '.join(near) or '—'} |")
    lines.append("")
    have = defaultdict(set)
    for c in candidates:
        have[c["section"]].add(c["vehicleIds"][0])
    lines += ["## ERP vehicles with no amount in these books", ""]
    for s in ("ROAD_TAX", "INSURANCE", "FITNESS"):
        missing = sorted(v["regNo"] for v in vehicles if v["id"] not in have[s] and reg(v["regNo"]))
        lines.append(f"- **{s}** ({len(missing)}): {', '.join(missing)}")
    lines += ["", "Source rows: `candidates.json` (each with `source` = book › sheet › row) and `unmatched.csv`.", ""]
    open(os.path.join(OUT, "REVIEW.md"), "w").write("\n".join(lines))
    print(f"{len(candidates)} candidates, {len(unmatched)} not importable → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
