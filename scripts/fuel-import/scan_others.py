"""Fuel import, step 0: keyword-scan every other workbook in New data/ (outside Diesel Data and Vishal Gasoline) for fuel content, so nothing is skipped because of its folder name.

    python3 -E prototype/scripts/fuel-import/scan_others.py
"""
import openpyxl, os, re, sys, json, warnings
warnings.filterwarnings("ignore")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
root = os.path.join(ROOT, "New data"); out = []
KW=re.compile(r"DIESEL|AD ?BLUE|\bHSD\b|TANKER|PETROL PUMP|FUEL|\bBUNK\b|INDENT", re.I)
for dp,dn,fn in os.walk(root):
    if "/Diesel Data" in dp or "/Vishal Gasoline" in dp: continue
    for f in sorted(fn):
        p=os.path.join(dp,f); rel=os.path.relpath(p,root)
        if not f.lower().endswith((".xlsx",".xlsx_",".xlsm")):
            out.append({"file":rel,"type":os.path.splitext(f)[1] or "(none)","hits":None}); continue
        try:
            fh=open(p,"rb"); wb=openpyxl.load_workbook(fh,read_only=True,data_only=True); hits=[]
            for ws in wb.worksheets:
                if KW.search(ws.title): hits.append(f"sheet:{ws.title}")
                n=0
                for r in ws.iter_rows(values_only=True):
                    n+=1
                    if n>60: break
                    for v in r:
                        if isinstance(v,str) and KW.search(v): hits.append(f"{ws.title}:{v.strip()[:40]}"); break
            out.append({"file":rel,"sheets":len(wb.worksheets),"hits":hits[:8],"nhits":len(hits)}); fh.close()
        except Exception as e: out.append({"file":rel,"error":str(e)[:80]})
json.dump(out, open(os.path.join(ROOT, "import", "fy2026-27", "source", "other_workbooks_scan.json"), "w"), indent=1)
print(len(out), sum(1 for o in out if o.get("hits")))
