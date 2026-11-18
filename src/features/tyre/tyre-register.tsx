"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { CalendarDays, CircleDot, IndianRupee, ListFilter, Plus, Receipt, Settings2, Wrench, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { StatsCard } from "@/components/shared/stats-card"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { attributionSplit, currentMonthInvoices, hasLineFilter, lineMatches, NO_FILTERS, OFFICE_LABEL, tyreTotals, type TyreFilters, type TyreInvoiceView } from "@/domain/tyre"
import { useDeleteTyreInvoice } from "@/lib/api/hooks"
import { useCan, useCurrentMonth, useRole } from "@/lib/app-state"
import { formatDate, formatINR, todayISO } from "@/lib/format"
import { TyreInvoiceDialog } from "./tyre-invoice-form"
import { TyreMastersDialog } from "./tyre-masters"
import { tyreFilterOptions, useTyreData } from "./tyre-data"
import { VendorPurchases } from "./tyre-vendors"

const FILTERS_KEY = "vt:ui:tyreFilters" // this browser only: the filters survive opening an invoice and coming back

function loadFilters(): TyreFilters {
  try {
    const raw = sessionStorage.getItem(FILTERS_KEY)
    return raw ? { ...NO_FILTERS, ...(JSON.parse(raw) as Partial<TyreFilters>) } : NO_FILTERS
  } catch {
    return NO_FILTERS
  }
}

/**
 * Tyre Data → Tyre: the **current month's** invoice register (one row per supplier bill), its filters and totals.
 * The month is the India calendar month (todayISO / useCurrentMonth); at 00:00 IST on the 1st the page shows the new
 * month by itself. Only the view moves: earlier invoices are never touched, and every month is in the Monthly Sheet.
 */
export function TyreRegister() {
  const can = useCan()
  const [role] = useRole()
  const d = useTyreData()
  const del = useDeleteTyreInvoice()
  const [f, setF] = useState<TyreFilters>(loadFilters) // the page shows a skeleton until data loads, so no hydration mismatch
  const [more, setMore] = useState(false)
  const [masters, setMasters] = useState(false)
  const [deleting, setDeleting] = useState<TyreInvoiceView | null>(null)
  // Add / Edit Invoice: a modal over this register — its search, filters and page stay exactly as they are.
  const [editor, setEditor] = useState<{ invoice?: TyreInvoiceView } | null>(null)
  const today = todayISO()
  const month = useCurrentMonth() // re-renders at the India month change (AppShell also remounts the page then)

  const update = (patch: Partial<TyreFilters>) =>
    setF((s) => {
      const next = { ...s, ...patch }
      try {
        sessionStorage.setItem(FILTERS_KEY, JSON.stringify(next))
      } catch {
        // private window / blocked storage: filters just don't persist
      }
      return next
    })
  const set = (k: keyof TyreFilters) => (v: string) => update({ [k]: v === ALL ? "" : v })

  // The month's invoices that pass the filters (a period saved by an older version of this page is ignored).
  const shown = useMemo(
    () => currentMonthInvoices(d.views, `${month}-01`, f).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [d.views, f, month]
  )
  const monthCount = useMemo(() => d.views.filter((v) => v.date.startsWith(month)).length, [d.views, month])
  const totals = useMemo(() => tyreTotals(shown.flatMap((v) => v.items)), [shown])
  const split = useMemo(() => attributionSplit(shown), [shown])
  const matchingLines = useMemo(() => (hasLineFilter(f) ? tyreTotals(shown.flatMap((v) => v.items.filter((i) => lineMatches(i, f)))) : null), [shown, f])

  const opts = useMemo(() => tyreFilterOptions(d), [d])

  // Active filters, as removable chips.
  const chips: { key: keyof TyreFilters; label: string }[] = []
  const labelOf = (list: { value: string; label: string }[], v: string) => list.find((o) => o.value === v)?.label ?? v
  for (const [k, list, what] of [
    ["customerId", opts.company, "Company"],
    ["vehicleId", opts.vehicle, "Vehicle"],
    ["vehicleType", opts.vehicleType, "Type"],
    ["supplierId", opts.supplier, "Supplier"],
    ["repairTypeId", opts.repairType, "Repair"],
    ["brandId", opts.brand, "Brand"],
    ["sizeId", opts.size, "Size"],
    ["paymentMode", opts.paymentMode, "Payment"],
    ["purchaseMode", opts.purchaseMode, "Purchase"],
  ] as const)
    if (f[k]) chips.push({ key: k, label: `${what}: ${labelOf(list, f[k])}` })
  if (f.billNo) chips.push({ key: "billNo", label: `Bill: ${f.billNo}` })
  if (f.search) chips.push({ key: "search", label: `“${f.search}”` })
  const advancedCount = [f.vehicleId, f.vehicleType, f.billNo, f.repairTypeId, f.brandId, f.sizeId, f.paymentMode, f.purchaseMode].filter(Boolean).length
  const clear = (key: (typeof chips)[number]["key"]) => update({ [key]: "" })

  if (!can("tyres")) return <NoAccess what="Tyre" />
  if (!d.ready) return <PageSkeleton />

  const mayCreate = can("tyres", "create")
  const mayEdit = can("tyres", "edit")
  const mayDelete = can("tyres", "delete")
  const open = (v: TyreInvoiceView) => canEditMonth(role, v.date.slice(0, 7), today, d.locks)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tyre"
        meta={<Badge variant="secondary">Current month · {monthLabel(month)}</Badge>}
        description="This month's tyre purchases and repair work — one row per supplier bill. Earlier months: Monthly Sheet."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/tyre/monthly-sheet" title="Historical monthly records — any month">
                <CalendarDays /> Monthly Sheet
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/tyre/payments" title="Every payment to tyre vendors — view, edit, delete">
                <IndianRupee /> Payments
              </Link>
            </Button>
            {(mayCreate || mayEdit) && (
              <Button variant="outline" onClick={() => setMasters(true)}>
                <Settings2 /> Lists
              </Button>
            )}
            {mayCreate && (
              <Button onClick={() => setEditor({})}>
                <Plus /> Add Invoice
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatsCard label="Invoices" value={shown.length} hint={chips.length ? `${monthLabel(month)} · matching the filters` : `${monthLabel(month)} (to date)`} icon={Receipt} />
        <StatsCard
          label="Invoice Total"
          value={formatINR(totals.grandTotal)}
          hint={split.office ? `Customers ${formatINR(split.customers)} · ${OFFICE_LABEL} ${formatINR(split.office)}` : `Base ${formatINR(totals.baseValue)} + GST ${formatINR(totals.gst)}`}
          info={`${monthLabel(month)} only. Σ of the shown invoices' lines: base value (quantity × rate) + CGST + SGST + IGST. ${OFFICE_LABEL} invoices count here, never in a customer's total.`}
          prominent
        />
        <StatsCard label="Repair Lines" value={totals.lines} hint={`lines on ${monthLabel(month)}'s shown invoices`} icon={Wrench} />
        {matchingLines ? (
          <StatsCard label="Matching Repair Lines" value={formatINR(matchingLines.grandTotal)} hint={`${matchingLines.lines} line${matchingLines.lines === 1 ? "" : "s"} · base ${formatINR(matchingLines.baseValue)}`} info="Only the lines that match the repair type / brand / size filters, incl. GST." icon={ListFilter} />
        ) : (
          <StatsCard label="GST" value={formatINR(totals.gst)} hint={`CGST ${formatINR(totals.cgst)} · SGST ${formatINR(totals.sgst)} · IGST ${formatINR(totals.igst)}`} />
        )}
      </div>

      <VendorPurchases />

      <section className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={set("search")} placeholder="Bill no., vehicle, supplier, tyre no.…" className="md:w-72" />
          <FilterSelect value={f.customerId || ALL} onChange={set("customerId")} options={opts.company} placeholder="Company" allLabel="All companies" />
          <FilterSelect value={f.supplierId || ALL} onChange={set("supplierId")} options={opts.supplier} placeholder="Supplier" allLabel="All suppliers" />
          <Button variant="outline" size="sm" className="h-8" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            <ListFilter /> More filters{advancedCount ? <Badge variant="secondary">{advancedCount}</Badge> : null}
          </Button>
        </div>
        {more && (
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect value={f.vehicleId || ALL} onChange={set("vehicleId")} options={opts.vehicle} placeholder="Vehicle" allLabel="All vehicles" className="w-full" />
            <FilterSelect value={f.vehicleType || ALL} onChange={set("vehicleType")} options={opts.vehicleType} placeholder="Vehicle type" allLabel="All vehicle types" className="w-full" />
            <Input value={f.billNo} onChange={(e) => update({ billNo: e.target.value })} placeholder="Bill number" className="h-8 bg-background" aria-label="Bill number" />
            <FilterSelect value={f.repairTypeId || ALL} onChange={set("repairTypeId")} options={opts.repairType} placeholder="Repair type" allLabel="All repair types" className="w-full" />
            <FilterSelect value={f.brandId || ALL} onChange={set("brandId")} options={opts.brand} placeholder="Tyre brand" allLabel="All tyre brands" className="w-full" />
            <FilterSelect value={f.sizeId || ALL} onChange={set("sizeId")} options={opts.size} placeholder="Tyre size" allLabel="All tyre sizes" className="w-full" />
            <FilterSelect value={f.paymentMode || ALL} onChange={set("paymentMode")} options={opts.paymentMode} placeholder="Payment mode" allLabel="All payment modes" className="w-full" />
            <FilterSelect value={f.purchaseMode || ALL} onChange={set("purchaseMode")} options={opts.purchaseMode} placeholder="Purchase mode" allLabel="All purchase modes" className="w-full" />
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">Repair type, brand and size match a line inside the invoice — together on the same line.</p>
          </div>
        )}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <Badge key={c.key} variant="secondary" className="gap-1 pr-1">
                {c.label}
                <button type="button" onClick={() => clear(c.key)} className="rounded-sm p-0.5 hover:bg-muted-foreground/20" aria-label={`Remove filter ${c.label}`}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Button variant="ghost" size="sm" className="h-6 text-muted-foreground" onClick={() => update(NO_FILTERS)}>
              Reset filters
            </Button>
          </div>
        )}
      </section>

      {monthCount === 0 ? (
        <EmptyState
          icon={CircleDot}
          title={`No tyre invoices in ${monthLabel(month)} yet`}
          description={d.views.length ? "Earlier months' invoices are kept — open them in the Monthly Sheet." : "Record a supplier bill with its repair lines — new tyres, rebuilt tyres, wheel alignment, fitting…"}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {mayCreate && (
                <Button onClick={() => setEditor({})}>
                  <Plus /> Add Invoice
                </Button>
              )}
              {d.views.length > 0 && (
                <Button variant="outline" asChild>
                  <Link href="/tyre/monthly-sheet">
                    <CalendarDays /> Monthly Sheet
                  </Link>
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <DataTable
          data={shown}
          getRowId={(v) => v.id}
          rowHref={(v) => `/tyre/${v.id}`}
          initialSort={{ id: "date", desc: true }}
          showFooter
          emptyMessage={`No ${monthLabel(month)} invoice matches the filters.`}
          mobileColumns={["company", "supplier", "items", "total"]}
          columns={[
            { id: "date", header: "Date", sortValue: (v) => v.date, cell: (v) => <span className="num">{formatDate(v.date)}</span>, footer: `${shown.length} invoice${shown.length === 1 ? "" : "s"}` },
            { id: "bill", header: "Bill No.", sortValue: (v) => v.billNo, cell: (v) => <span className="font-medium">{v.billNo || "—"}</span> },
            { id: "company", header: "Company", sortValue: (v) => v.company, cell: (v) => (v.office ? <OfficeBadge /> : v.company) },
            { id: "vehicle", header: "Vehicle", sortValue: (v) => v.regNo, cell: (v) => <span className="num font-medium">{v.regNo}</span> },
            { id: "type", header: "Vehicle Type", hideOnMobile: true, sortValue: (v) => v.vehicleType, cell: (v) => <span className="text-muted-foreground">{v.vehicleType || "—"}</span> },
            { id: "supplier", header: "Supplier", sortValue: (v) => v.supplier, cell: (v) => v.supplier },
            { id: "items", header: "Repair Items", align: "right", sortValue: (v) => v.items.length, cell: (v) => <span className="num">{v.items.length}</span>, footer: <span className="num">{totals.lines}</span> },
            { id: "total", header: "Invoice Total", align: "right", sortValue: (v) => v.totals.grandTotal, cell: (v) => <span className="num font-medium">{formatINR(v.totals.grandTotal)}</span>, footer: <span className="num">{formatINR(totals.grandTotal)}</span> },
            {
              id: "act",
              header: "",
              align: "right",
              cell: (v) => (
                <RowActions
                  lockedReason={(mayEdit || mayDelete) && !open(v) ? monthLockedReason(monthLabel(v.date.slice(0, 7))) : null}
                  onEdit={mayEdit && open(v) ? () => setEditor({ invoice: v }) : undefined}
                  onDelete={mayDelete && open(v) ? () => setDeleting(v) : undefined}
                  editLabel="Edit invoice"
                  deleteLabel="Delete invoice"
                />
              ),
            },
          ]}
        />
      )}

      {masters && <TyreMastersDialog onClose={() => setMasters(false)} />}
      {editor && <TyreInvoiceDialog key={editor.invoice?.id ?? "new"} invoice={editor.invoice} onClose={() => setEditor(null)} />}
      {deleting && <DeleteTyreInvoiceDialog invoice={deleting} pending={del.isPending} onConfirm={(reason) => del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })} onClose={() => setDeleting(null)} />}
    </div>
  )
}

/** "Office / No Customer": visibly not a customer. */
export function OfficeBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-dashed font-normal text-muted-foreground", className)}>
      {OFFICE_LABEL}
    </Badge>
  )
}

/** Delete confirmation (Owner / Dev): names the bill, says what changes, needs a reason. */
export function DeleteTyreInvoiceDialog({ invoice: v, pending, onConfirm, onClose }: { invoice: TyreInvoiceView; pending: boolean; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
  return (
    <DeleteDialog
      title="Delete this tyre invoice?"
      record={`${v.supplier} · bill ${v.billNo || "—"} · ${v.regNo} · ${formatDate(v.date)} · ${v.items.length} line${v.items.length === 1 ? "" : "s"} · ${formatINR(v.totals.grandTotal)}`}
      impact={`The invoice and all its repair lines are removed, and the Tyre totals for ${v.company} and ${v.regNo} change. It can be restored from the Audit Log.`}
      submitLabel="Delete Invoice"
      pending={pending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}
