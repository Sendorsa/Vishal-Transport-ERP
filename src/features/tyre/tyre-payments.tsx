"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { HandCoins, IndianRupee, Landmark, Pencil, Percent, Trash2, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { monthLabel } from "@/domain/diesel"
import { fyName, fyStartYear } from "@/domain/financial-year"
import { canEditMonth } from "@/domain/month-lock"
import { ALLOCATION_STATUS_LABEL, allocationStatus, periodRange, referenceLabel, settledOf, TYRE_PAYMENT_MODES, unallocated, vendorAccounts, type AllocationStatus } from "@/domain/tyre"
import { useDeleteTyrePayment } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, round2, todayISO } from "@/lib/format"
import type { TyrePayment } from "@/lib/types"
import { AllocationBadge, DeletePaymentDialog, PaymentDetailsDialog, TyrePaymentDialog } from "./tyre-payment-dialog"
import { useTyreData } from "./tyre-data"

interface Filters {
  /** "ALL", a month "yyyy-MM", "FY:2026" or "RANGE" (from / to) — the same periods as the register. */
  period: string
  from: string
  to: string
  supplierId: string
  mode: string
  tds: "" | "ON" | "OFF"
  status: "" | AllocationStatus
  search: string
}
const NO_FILTERS: Filters = { period: "ALL", from: "", to: "", supplierId: "", mode: "", tds: "", status: "", search: "" }
const KEY = "vt:ui:tyrePayments" // this browser only: the filters survive opening a payment's bill and coming back

function load(): Filters {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? { ...NO_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) } : NO_FILTERS
  } catch {
    return NO_FILTERS
  }
}
const norm = (s: string) => s.replace(/[\s-]+/g, "").toLowerCase()

/**
 * Tyre → Payments: every payment to every tyre vendor in one place (owner, 17 Nov 2026) — settled, paid, TDS,
 * allocations and status, with Edit (tyres:edit) and Delete (the Owner / Dev: permanent, with a reason), month locks
 * as everywhere.
 */
export function TyrePayments() {
  const can = useCan()
  const [role] = useRole()
  const d = useTyreData()
  const deletePay = useDeleteTyrePayment()
  const [f, setF] = useState<Filters>(load)
  const [viewing, setViewing] = useState<TyrePayment | null>(null)
  const [editing, setEditing] = useState<TyrePayment | null>(null)
  const [deleting, setDeleting] = useState<TyrePayment | null>(null)
  const today = todayISO()
  const update = (patch: Partial<Filters>) =>
    setF((s) => {
      const next = { ...s, ...patch }
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // private window / blocked storage: filters just don't persist
      }
      return next
    })

  const bill = useMemo(() => new Map(d.views.map((v) => [v.id, v])), [d.views])
  const range = periodRange(f)
  const shown = useMemo(() => {
    const q = norm(f.search)
    return d.payments
      .filter((p) => !range || (p.date >= range.from && p.date <= range.to))
      .filter((p) => !f.supplierId || p.supplierId === f.supplierId)
      .filter((p) => !f.mode || p.mode === f.mode)
      .filter((p) => !f.tds || (f.tds === "ON") === (p.tdsAmount ?? 0) > 0)
      .filter((p) => !f.status || allocationStatus(p) === f.status)
      .filter((p) => !q || [p.utr, p.reference, p.notes, d.name(p.supplierId), ...p.allocations.map((a) => bill.get(a.invoiceId)?.billNo ?? "")].some((s) => norm(s ?? "").includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [d, f, range, bill])

  if (!can("tyres")) return <NoAccess what="Tyre" />
  if (!d.ready) return <PageSkeleton />

  // Cards: the payments shown.
  const sum = (g: (p: TyrePayment) => number) => shown.reduce((t, p) => round2(t + g(p)), 0)
  const settled = sum(settledOf)
  const paid = sum((p) => p.amount)
  const tds = sum((p) => p.tdsAmount ?? 0)
  // Outstanding payables at the end of the period (today for all dates): per vendor, bills − settled up to then.
  const asOf = range ? (range.to > today ? today : range.to) : today
  const owed = vendorAccounts(
    d.views.filter((v) => v.date <= asOf && (!f.supplierId || v.supplierId === f.supplierId)),
    d.payments.filter((p) => p.date <= asOf && (!f.supplierId || p.supplierId === f.supplierId))
  ).reduce((t, a) => round2(t + Math.max(0, a.balance)), 0)

  const vendors = [...new Set(d.payments.map((p) => p.supplierId))].map((id) => ({ value: id, label: d.name(id) })).sort((a, b) => a.label.localeCompare(b.label))
  const months = [...new Set(d.payments.map((p) => p.date.slice(0, 7)))].sort().reverse()
  const fys = [...new Set(d.payments.map((p) => fyStartYear(p.date)))].sort((a, b) => b - a)
  const periodOptions = [...months.map((m) => ({ value: m, label: monthLabel(m) })), ...fys.map((y) => ({ value: `FY:${y}`, label: `FY ${fyName(y)}` })), { value: "RANGE", label: "Date range…" }]
  const periodText = f.period === "ALL" ? "All dates" : f.period === "RANGE" ? `${f.from ? formatDate(f.from) : "…"} – ${f.to ? formatDate(f.to) : "…"}` : f.period.startsWith("FY:") ? `FY ${fyName(Number(f.period.slice(3)))}` : monthLabel(f.period)
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTERS)
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), today, d.locks)
  const mayEdit = can("tyres", "edit")
  const mayDelete = can("tyres", "delete")
  // Deleting changes what its bills owe: their months must be open too (as the API checks).
  const deletable = (p: TyrePayment) => open(p.date) && p.allocations.every((a) => open(bill.get(a.invoiceId)?.date ?? p.date))

  return (
    <div className="space-y-5">
      <PageHeader backHref="/tyre" backLabel="Tyre" title="Tyre Payments" description="Every payment to tyre vendors — what it settled, what was paid, TDS and the bills it pays. Record a new payment from the vendor's page." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatsCard label="Total Payments Settled" value={formatINR(settled)} hint={`${shown.length} payment${shown.length === 1 ? "" : "s"} · ${periodText}`} icon={IndianRupee} info="Σ of what the payments shown settle with the vendors: paid + TDS deducted." prominent />
        <StatsCard label="Actual Amount Paid" value={formatINR(paid)} hint="Bank / cash transferred" icon={Landmark} info="Σ of the money that actually reached the vendors — settled less TDS." />
        <StatsCard label="Total TDS Deducted" value={formatINR(tds)} hint={tds ? "Withheld — counted once, inside settled" : "No TDS deducted"} icon={Percent} info="Σ TDS withheld from the payments shown. It is part of Total Payments Settled, never added on top." />
        <StatsCard label="Outstanding Vendor Payables" value={formatINR(owed)} hint={`As of ${formatDate(asOf)}${f.supplierId ? ` · ${d.name(f.supplierId)}` : ""}`} icon={Wallet} info="Σ over vendors of (bills − payments settled) dated up to the period's end, where the vendor is owed money. Vendors holding an advance count as 0 here." />
      </div>

      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={(v) => update({ search: v })} placeholder="UTR, cheque, receipt, reference, bill…" className="col-span-2 md:w-72" />
          <FilterSelect value={f.period === "ALL" ? ALL : f.period} onChange={(v) => update({ period: v === ALL ? "ALL" : v })} options={periodOptions} placeholder="Period" allLabel="All dates" className="w-full min-w-0 md:w-auto md:min-w-36" />
          {f.period === "RANGE" && (
            <>
              <Input type="date" value={f.from} max={today} onChange={(e) => update({ from: e.target.value })} className="h-8 md:w-40" aria-label="From date" />
              <Input type="date" value={f.to} max={today} onChange={(e) => update({ to: e.target.value })} className="h-8 md:w-40" aria-label="To date" />
            </>
          )}
          <FilterSelect value={f.supplierId || ALL} onChange={(v) => update({ supplierId: v === ALL ? "" : v })} options={vendors} placeholder="Vendor" allLabel="All vendors" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.mode || ALL} onChange={(v) => update({ mode: v === ALL ? "" : v })} options={TYRE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Mode" allLabel="All modes" className="w-full min-w-0 md:w-auto md:min-w-32" />
          <FilterSelect value={f.tds || ALL} onChange={(v) => update({ tds: v === ALL ? "" : (v as Filters["tds"]) })} options={[{ value: "ON", label: "TDS deducted" }, { value: "OFF", label: "No TDS" }]} placeholder="TDS" allLabel="TDS: any" className="w-full min-w-0 md:w-auto md:min-w-32" />
          <FilterSelect value={f.status || ALL} onChange={(v) => update({ status: v === ALL ? "" : (v as AllocationStatus) })} options={(Object.keys(ALLOCATION_STATUS_LABEL) as AllocationStatus[]).map((s) => ({ value: s, label: ALLOCATION_STATUS_LABEL[s] }))} placeholder="Status" allLabel="All statuses" className="w-full min-w-0 md:w-auto md:min-w-40" />
          {filtered && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => update(NO_FILTERS)}>
              Reset filters
            </Button>
          )}
        </div>
      </section>

      <DataTable
        data={shown}
        getRowId={(p) => p.id}
        onRowClick={setViewing}
        initialSort={{ id: "date", desc: true }}
        showFooter
        cardsBelow="2xl"
        emptyMessage={d.payments.length ? "No payment matches the filters." : "No tyre payments yet — record one from a vendor's page (Tyre → Vendor Purchases)."}
        mobileColumns={["vendor", "settled", "status", "act"]}
        columns={[
          { id: "date", header: "Payment Date", sortValue: (p) => p.date, cell: (p) => <span className="num">{formatDate(p.date)}</span>, footer: `${shown.length} payment${shown.length === 1 ? "" : "s"}` },
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (p) => d.name(p.supplierId),
            cell: (p) => (
              <Link href={`/tyre/vendors/${p.supplierId}`} className="font-medium underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {d.name(p.supplierId)}
              </Link>
            ),
          },
          {
            id: "ref",
            header: "Reference",
            cell: (p) => (
              <div className="max-w-56 min-w-40 text-xs whitespace-normal">
                <div className="num break-all">{p.utr}</div>
                <div className="text-muted-foreground">{referenceLabel(p.mode)}</div>
              </div>
            ),
          },
          { id: "mode", header: "Mode", sortValue: (p) => p.mode, cell: (p) => p.mode },
          { id: "settled", header: "Total Settled", align: "right", sortValue: (p) => settledOf(p), cell: (p) => <span className="num font-medium">{formatINR(settledOf(p))}</span>, footer: <span className="num">{formatINR(settled)}</span> },
          { id: "rate", header: "TDS %", align: "right", hideOnMobile: true, sortValue: (p) => p.tdsRate ?? -1, cell: (p) => (p.tdsRate != null ? <span className="num">{formatNumber(p.tdsRate, 4)}%</span> : <span className="text-muted-foreground">—</span>) },
          { id: "tds", header: "TDS Amount", align: "right", sortValue: (p) => p.tdsAmount ?? 0, cell: (p) => ((p.tdsAmount ?? 0) > 0 ? <span className="num">{formatINR(p.tdsAmount!)}</span> : <span className="text-muted-foreground">—</span>), footer: <span className="num">{formatINR(tds)}</span> },
          { id: "paid", header: "Actual Paid", align: "right", sortValue: (p) => p.amount, cell: (p) => <span className="num">{formatINR(p.amount)}</span>, footer: <span className="num">{formatINR(paid)}</span> },
          {
            id: "bills",
            header: "Allocated Invoice(s)",
            hideOnMobile: true,
            cell: (p) =>
              p.allocations.length ? (
                <div className="max-w-48 space-y-0.5 text-xs whitespace-normal">
                  {p.allocations.map((a, n) => (
                    <div key={n}>
                      <Link href={`/tyre/${a.invoiceId}?from=vendor`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                        Bill {bill.get(a.invoiceId)?.billNo || "—"}
                      </Link>{" "}
                      <span className="num text-muted-foreground">{formatINR(a.amount)}</span>
                    </div>
                  ))}
                  {unallocated(p) > 0 && <div className="num text-sky-700 dark:text-sky-400">{formatINR(unallocated(p))} advance</div>}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">{formatINR(unallocated(p))} advance</span>
              ),
          },
          { id: "status", header: "Status", sortValue: (p) => allocationStatus(p), cell: (p) => <AllocationBadge payment={p} /> },
          {
            id: "act",
            header: "",
            align: "right",
            cell: (p) => (
                <span className="inline-flex gap-0.5" onClick={(e) => e.stopPropagation()}>
                  {mayEdit && open(p.date) && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit the payment of ${formatDate(p.date)}`} title="Edit payment" onClick={() => setEditing(p)}>
                      <Pencil />
                    </Button>
                  )}
                  {mayDelete && deletable(p) && (
                    <Button variant="ghost" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete the payment of ${formatDate(p.date)}`} title="Delete payment" onClick={() => setDeleting(p)}>
                      <Trash2 />
                    </Button>
                  )}
                </span>
              ),
          },
        ]}
      />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <HandCoins className="size-3.5" /> Settled = paid to the vendor + TDS deducted. Deleting a payment removes it and its allocations permanently (the audit log keeps it); its bills are owed again.
      </p>

      {viewing && <PaymentDetailsDialog payment={d.payments.find((p) => p.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} />}
      {editing && <TyrePaymentDialog key={editing.id} supplierId={editing.supplierId} payment={editing} edit onClose={() => setEditing(null)} />}
      {deleting && (
        <DeletePaymentDialog
          payment={deleting}
          vendor={d.name(deleting.supplierId)}
          bills={[...new Set(deleting.allocations.map((a) => `Bill ${bill.get(a.invoiceId)?.billNo || "—"}`))]}
          pending={deletePay.isPending}
          onConfirm={async (reason) => {
            await deletePay.mutateAsync({ id: deleting.id, reason, version: deleting.updatedAt })
            toast.success("Payment deleted")
            setDeleting(null)
            setViewing(null)
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
