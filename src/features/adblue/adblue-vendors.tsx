"use client"

import { useMemo, useState } from "react"
import { format, parseISO } from "date-fns"
import { Archive, MoreVertical, Pencil, Plus, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DataTable } from "@/components/shared/data-table"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { StatusBadge } from "@/components/shared/status-badge"
import { NO_VENDOR, NO_VENDOR_LABEL, stockFor, valueInventory, vendorKey, vendorLedger } from "@/domain/adblue-inventory"
import { monthLabel } from "@/domain/diesel"
import { useArchiveAdBlueVendor, useSaveAdBlueVendor } from "@/lib/api/hooks"
import { formatDate, formatINR, formatLitres as L } from "@/lib/format"
import type { AdBlueEntry, AdBluePurchase, AdBlueVendor } from "@/lib/types"


interface Row {
  key: string
  vendor: AdBlueVendor | null
  name: string
  stockLitres: number
  stockValue: number
  purchased: number
  purchasedCost: number
  consumed: number
  consumedCost: number
}

/**
 * AdBlue → Vendors (owner, 16 Nov 2026): the vendor master with each vendor's own stock — stock now (or at the period's
 * month end), bought and drawn by vehicles in the period — and, on a row, that vendor's ledger. Calculated from the same
 * FIFO run as the company figures (src/domain/adblue-inventory.ts), so Σ vendors = the company.
 */
export function AdBlueVendorsSection({
  vendors,
  purchases,
  entries,
  months,
  endedMonth,
  periodLabel,
  regOf,
  mayManage,
}: {
  vendors: AdBlueVendor[]
  purchases: AdBluePurchase[]
  entries: AdBlueEntry[]
  /** The period's yyyy-MM months (undefined = all time). */
  months: string[] | undefined
  /** A period that has ended: stock at its month end. */
  endedMonth: string | null
  periodLabel: string
  regOf: (vehicleId: string) => string
  mayManage: boolean
}) {
  const archive = useArchiveAdBlueVendor()
  const [editing, setEditing] = useState<{ vendor?: AdBlueVendor } | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)
  const draws = useMemo(() => entries.filter((e) => e.source !== "DIRECT"), [entries])

  const rows = useMemo(() => {
    const upTo = (d: { date: string }) => !endedMonth || d.date.slice(0, 7) <= endedMonth
    const all = valueInventory(purchases.filter(upTo), draws.filter(upTo))
    const stock = all.vendorStock
    // Unattributed stock is listed whenever it exists: opening stock, or stock that became unattributed at old draws.
    const keys = new Set([...vendors.map((v) => v.id), ...purchases.map(vendorKey), ...(all.moves.length ? [NO_VENDOR] : [])])
    return [...keys].map((key): Row => {
      const vendor = vendors.find((v) => v.id === key) ?? null
      const p = stockFor(vendorLedger(purchases, draws, key), months)
      const s = stock.get(key) ?? { litres: 0, value: 0 }
      return { key, vendor, name: vendor?.name ?? (key === NO_VENDOR ? NO_VENDOR_LABEL : "Unknown vendor"), stockLitres: s.litres, stockValue: s.value, purchased: p.purchased, purchasedCost: p.purchasedCost, consumed: p.consumed, consumedCost: p.consumedCost }
    })
  }, [vendors, purchases, draws, months, endedMonth])

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Vendors · stock and use · {periodLabel}</h2>
        {mayManage && (
          <Button size="sm" variant="outline" onClick={() => setEditing({})}>
            <Plus /> Add Vendor
          </Button>
        )}
      </div>
      <DataTable
        data={rows}
        getRowId={(r) => r.key || "none"}
        initialSort={{ id: "stock", desc: true }}
        dense
        onRowClick={setViewing}
        emptyMessage="No AdBlue vendors yet — add one, or record a bulk purchase."
        columns={[
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (r) => r.name,
            cell: (r) => (
              <span className="inline-flex items-center gap-1.5">
                <span className={r.vendor ? "font-medium" : "text-muted-foreground"}>{r.name}</span>
                {r.vendor?.status === "ARCHIVED" && <StatusBadge status="ARCHIVED" />}
              </span>
            ),
          },
          { id: "default", header: "Default Rate / L", align: "right", hideOnMobile: true, sortValue: (r) => r.vendor?.defaultRate ?? null, cell: (r) => <span className="num text-muted-foreground">{r.vendor?.defaultRate ? formatINR(r.vendor.defaultRate) : "—"}</span> },
          { id: "stock", header: endedMonth ? "Closing Stock" : "Stock Now", align: "right", sortValue: (r) => r.stockLitres, cell: (r) => <span className="num font-medium">{L(r.stockLitres)}</span> },
          { id: "value", header: "Stock Value", align: "right", hideOnMobile: true, sortValue: (r) => r.stockValue, cell: (r) => <span className="num">{formatINR(r.stockValue)}</span> },
          { id: "bought", header: "Purchased", align: "right", sortValue: (r) => r.purchased, cell: (r) => <span className="num">{L(r.purchased)}</span> },
          { id: "boughtCost", header: "Purchase Value", align: "right", hideOnMobile: true, sortValue: (r) => r.purchasedCost, cell: (r) => <span className="num">{formatINR(r.purchasedCost)}</span> },
          { id: "rate", header: "Average Purchase Rate", align: "right", hideOnMobile: true, sortValue: (r) => (r.purchased ? r.purchasedCost / r.purchased : null), cell: (r) => <span className="num">{r.purchased && r.purchasedCost ? `${formatINR(r.purchasedCost / r.purchased)} / L` : "—"}</span> },
          { id: "used", header: "Used by Vehicles", align: "right", sortValue: (r) => r.consumed, cell: (r) => <span className="num">{L(r.consumed)}</span> },
          { id: "usedCost", header: "Cost of Use", align: "right", hideOnMobile: true, sortValue: (r) => r.consumedCost, cell: (r) => <span className="num">{formatINR(r.consumedCost)}</span> },
          {
            id: "act",
            header: "",
            align: "right",
            cell: (r) =>
              mayManage && r.vendor ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`} onClick={(e) => e.stopPropagation()}>
                      <MoreVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onSelect={() => setEditing({ vendor: r.vendor! })}>
                      <Pencil /> Edit Vendor
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={async () => {
                        const v = r.vendor!
                        await archive.mutateAsync({ id: v.id, version: v.updatedAt, restore: v.status === "ARCHIVED" })
                        toast.success(`${v.name} ${v.status === "ARCHIVED" ? "restored" : "archived"}`)
                      }}
                    >
                      {r.vendor.status === "ARCHIVED" ? (
                        <>
                          <RotateCcw /> Restore
                        </>
                      ) : (
                        <>
                          <Archive /> Archive
                        </>
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null,
          },
        ]}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Each vendor&apos;s stock is its own: a vehicle draw uses the chosen vendor&apos;s oldest stock first, at that purchase&apos;s rate. {NO_VENDOR_LABEL} is opening stock, and stock on hand when a draw recorded before vendor tracking (no vendor) could have come from more than one source — its vendor is unknown and is never guessed. Open a vendor for its ledger.
      </p>
      {editing && <VendorDialog key={editing.vendor?.id ?? "new"} vendor={editing.vendor} onOpenChange={(o) => !o && setEditing(null)} />}
      {viewing && <VendorLedgerDialog row={viewing} purchases={purchases} draws={draws} months={months} periodLabel={periodLabel} regOf={regOf} onClose={() => setViewing(null)} />}
    </section>
  )
}

/** One vendor's monthly ledger (Opening + Purchased − Used = Closing, carried forward) and the vehicles that used its stock. */
function VendorLedgerDialog({ row, purchases, draws, months, periodLabel, regOf, onClose }: { row: Row; purchases: AdBluePurchase[]; draws: AdBlueEntry[]; months: string[] | undefined; periodLabel: string; regOf: (id: string) => string; onClose: () => void }) {
  const d = useMemo(() => {
    const ledger = vendorLedger(purchases, draws, row.key)
    const byId = new Map(draws.map((e) => [e.id, e]))
    const inPeriod = (date: string) => !months || months.includes(date.slice(0, 7))
    // One line per draw (a draw takes one vendor's batches; a draw without a vendor may take several vendors').
    const uses = new Map<string, { date: string; vehicle: string; litres: number; cost: number }>()
    for (const t of valueInventory(purchases, draws).takes)
      if (t.vendor === row.key && inPeriod(t.date)) {
        const u = uses.get(t.consumptionId) ?? { date: t.date, vehicle: regOf(byId.get(t.consumptionId)?.vehicleId ?? ""), litres: 0, cost: 0 }
        uses.set(t.consumptionId, { ...u, litres: u.litres + t.litres, cost: u.cost + t.cost })
      }
    return { ledger: [...ledger].reverse(), period: stockFor(ledger, months), uses: [...uses].map(([id, u]) => ({ id, ...u })).sort((a, b) => b.date.localeCompare(a.date)) }
  }, [row.key, purchases, draws, months, regOf])
  const p = d.period

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{row.name}</DialogTitle>
          <DialogDescription>
            AdBlue stock ledger · {periodLabel}
            {row.vendor?.defaultRate ? ` · default rate ${formatINR(row.vendor.defaultRate)} / L` : ""}
            {row.vendor?.contactPerson || row.vendor?.phone ? ` · ${[row.vendor.contactPerson, row.vendor.phone].filter(Boolean).join(", ")}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Opening Stock</div>
            <div className="num font-semibold">{L(p.opening + p.openingStock)}</div>
            {p.carriedFrom && p.opening > 0 && <div className="text-[11px] text-muted-foreground">Carried forward from {format(parseISO(`${p.carriedFrom}-01`), "MMMM yyyy")}</div>}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Purchased</div>
            <div className="num font-semibold">{L(p.purchased)}</div>
            <div className="num text-[11px] text-muted-foreground">{formatINR(p.purchasedCost)}{p.purchased ? ` · ${formatINR(p.purchasedCost / p.purchased)} / L` : ""}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Used by Vehicles</div>
            <div className="num font-semibold">{L(p.consumed)}</div>
            <div className="num text-[11px] text-muted-foreground">{formatINR(p.consumedCost)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Closing Stock</div>
            <div className="num font-semibold">{L(p.closing)}</div>
            {p.unattributed !== 0 && (
              <div className="text-[11px] text-muted-foreground">
                {p.unattributed < 0 ? `${L(-p.unattributed)} became unattributed (old draws, vendor unknown)` : `${L(p.unattributed)} from vendors' stock, vendor unknown (old draws)`}
              </div>
            )}
          </div>
        </div>
        <h3 className="text-sm font-semibold">Monthly ledger · each closing carries forward</h3>
        <DataTable
          data={d.ledger}
          getRowId={(r) => r.month}
          dense
          pageSize={12}
          emptyMessage="No purchases or use yet."
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={months?.includes(r.month) ? "font-semibold" : ""}>{monthLabel(r.month)}</span> },
            { id: "o", header: "Opening", align: "right", cell: (r) => <span className="num">{L(r.opening + r.openingStock)}</span> },
            { id: "in", header: "Purchased", align: "right", cell: (r) => <span className="num">{L(r.purchased)}</span> },
            { id: "inv", header: "Purchase Value", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{formatINR(r.purchasedCost)}</span> },
            { id: "out", header: "Used", align: "right", cell: (r) => <span className="num">{L(r.consumed)}</span> },
            ...(d.ledger.some((r) => r.unattributed)
              ? [{ id: "un", header: row.key === NO_VENDOR ? "From vendors (unknown)" : "Became unattributed", align: "right" as const, cell: (r: (typeof d.ledger)[number]) => <span className="num">{r.unattributed ? L(Math.abs(r.unattributed)) : "—"}</span> }]
              : []),
            { id: "c", header: "Closing", align: "right", cell: (r) => <span className="num font-semibold">{L(r.closing)}</span> },
          ]}
        />
        <h3 className="text-sm font-semibold">Vehicles that used this stock · {periodLabel}</h3>
        <DataTable
          data={d.uses}
          getRowId={(u) => u.id}
          dense
          pageSize={10}
          emptyMessage="No vehicle used this vendor's stock in the period."
          columns={[
            { id: "d", header: "Date", cell: (u) => <span className="num">{formatDate(u.date)}</span> },
            { id: "v", header: "Vehicle", cell: (u) => <span className="font-medium">{u.vehicle}</span> },
            { id: "l", header: "Litres", align: "right", cell: (u) => <span className="num">{L(u.litres)}</span> },
            { id: "r", header: "Rate / L", align: "right", cell: (u) => <span className="num">{u.litres ? formatINR(u.cost / u.litres) : "—"}</span> },
            { id: "a", header: "Cost", align: "right", cell: (u) => <span className="num font-medium">{formatINR(u.cost)}</span> },
          ]}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Add / edit an AdBlue vendor. The default rate only pre-fills purchases; each purchase keeps its own rate. */
function VendorDialog({ vendor, onOpenChange }: { vendor?: AdBlueVendor; onOpenChange: (o: boolean) => void }) {
  const save = useSaveAdBlueVendor()
  const [f, setF] = useState({ name: vendor?.name ?? "", defaultRate: vendor?.defaultRate ? String(vendor.defaultRate) : "", contactPerson: vendor?.contactPerson ?? "", phone: vendor?.phone ?? "", notes: vendor?.notes ?? "" })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  const submit = async () => {
    setError(null)
    if (!f.name.trim()) return setError("Enter the vendor name")
    if (f.defaultRate !== "" && !(Number(f.defaultRate) > 0)) return setError("The default rate per litre must be greater than 0")
    await save.mutateAsync({ id: vendor?.id, version: vendor?.updatedAt, data: { name: f.name, defaultRate: f.defaultRate === "" ? null : Number(f.defaultRate), contactPerson: f.contactPerson, phone: f.phone, notes: f.notes } })
    toast.success(vendor ? "Vendor updated" : "Vendor added")
    onOpenChange(false)
  }
  return (
    <FormModal open onOpenChange={onOpenChange} title={vendor ? "Edit AdBlue vendor" : "Add AdBlue vendor"} description="Who AdBlue is bought from — in bulk for stock, or directly for a vehicle." submitLabel={vendor ? "Save changes" : "Add vendor"} pending={save.isPending} onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor name" required error={error ?? undefined} className="sm:col-span-2">
          <Input value={f.name} onChange={set("name")} placeholder="e.g. XYZ Chemicals" autoFocus />
        </Field>
        <Field label="Default rate per litre (₹)" hint="Pre-fills new purchases; each purchase keeps its own rate">
          <Input type="number" min={0} step="0.01" value={f.defaultRate} onChange={set("defaultRate")} />
        </Field>
        <Field label="Contact person">
          <Input value={f.contactPerson} onChange={set("contactPerson")} />
        </Field>
        <Field label="Phone number">
          <Input type="tel" value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={1} value={f.notes} onChange={set("notes")} />
        </Field>
      </div>
    </FormModal>
  )
}
