"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { HandCoins, IndianRupee, Plus, Wallet } from "lucide-react"
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
import { allocationStatus, PAYABLE_KIND_LABEL, periodRange, settledOf, supplierTotals, vendorAccounts } from "@/domain/adblue-payments"
import { useDeleteAdBluePayment } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { canManageAdBluePayments } from "@/lib/permissions"
import { formatDate, formatINR, round2, todayISO } from "@/lib/format"
import type { AdBluePayment } from "@/lib/types"
import { AdBluePaymentDetailsDialog, AdBluePaymentDialog, AllocationBadge, DeleteAdBluePaymentDialog } from "./adblue-payment-dialog"
import { useAdBlueFinance } from "./adblue-data"

interface Filters {
  /** "ALL", a month "yyyy-MM", "FY:2026" or "RANGE" (from / to). */
  period: string
  from: string
  to: string
  vendorId: string
  search: string
}
const NO_FILTERS: Filters = { period: "ALL", from: "", to: "", vendorId: "", search: "" }
const KEY = "vt:ui:adbluePayments" // this browser only: the filters survive opening a vendor and coming back

function load(): Filters {
  try {
    const raw = sessionStorage.getItem(KEY)
    const saved = raw ? (JSON.parse(raw) as Partial<Filters>) : {}
    // Only today's filters: a mode / TDS / status filter saved before they were removed (24 Nov 2026) never applies unseen.
    return { period: saved.period ?? "ALL", from: saved.from ?? "", to: saved.to ?? "", vendorId: saved.vendorId ?? "", search: saved.search ?? "" }
  } catch {
    return NO_FILTERS
  }
}
const norm = (s: string) => s.replace(/[\s-]+/g, "").toLowerCase()

/**
 * AdBlue → Payments (owner, 18 Nov 2026; simplified 24 Nov 2026): a payment register — Total Settled and Outstanding
 * Vendor Payables, search / date / vendor, and Date · Vendor · Total Settled · Mode · Status. A row opens the payment's
 * details (breakdown, TDS, allocations) with Edit (Owner / Dev / Employee) and Delete (permanent: the Owner / Dev, with a
 * reason). Never stock.
 */
export function AdBluePaymentsPanel({ title = "Payments" }: { title?: string | null }) {
  const can = useCan()
  const [role] = useRole()
  const d = useAdBlueFinance()
  const del = useDeleteAdBluePayment()
  const [f, setF] = useState<Filters>(load)
  const [viewing, setViewing] = useState<AdBluePayment | null>(null)
  const [editing, setEditing] = useState<AdBluePayment | null>(null)
  const [deleting, setDeleting] = useState<AdBluePayment | null>(null)
  const [adding, setAdding] = useState(false)
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

  const range = periodRange(f)
  const shown = useMemo(() => {
    const q = norm(f.search)
    return d.payments
      .filter((p) => !range || (p.date >= range.from && p.date <= range.to))
      .filter((p) => !f.vendorId || p.vendorId === f.vendorId)
      .filter((p) => !q || [p.utr, p.notes, d.vendorName(p.vendorId), ...p.allocations.map((a) => d.payableOf(a.purchaseId)?.billNo ?? "")].some((s) => norm(s ?? "").includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [d, f, range])

  const sum = (g: (p: AdBluePayment) => number) => shown.reduce((t, p) => round2(t + g(p)), 0)
  const settled = sum(settledOf)
  // Payables and advance at the end of the period (today for all dates), per vendor — never netted across vendors.
  const asOf = range ? (range.to > today ? today : range.to) : today
  const owed = supplierTotals(
    vendorAccounts(
      d.payables.filter((x) => x.date <= asOf && (!f.vendorId || x.vendorId === f.vendorId)),
      d.payments.filter((p) => p.date <= asOf && (!f.vendorId || p.vendorId === f.vendorId))
    )
  )

  const vendors = [...new Set(d.payments.map((p) => p.vendorId))].map((id) => ({ value: id, label: d.vendorName(id) })).sort((a, b) => a.label.localeCompare(b.label))
  const months = [...new Set(d.payments.map((p) => p.date.slice(0, 7)))].sort().reverse()
  const fys = [...new Set(d.payments.map((p) => fyStartYear(p.date)))].sort((a, b) => b - a)
  const periodOptions = [...months.map((m) => ({ value: m, label: monthLabel(m) })), ...fys.map((y) => ({ value: `FY:${y}`, label: `FY ${fyName(y)}` })), { value: "RANGE", label: "Date range…" }]
  const periodText = f.period === "ALL" ? "All dates" : f.period === "RANGE" ? `${f.from ? formatDate(f.from) : "…"} – ${f.to ? formatDate(f.to) : "…"}` : f.period.startsWith("FY:") ? `FY ${fyName(Number(f.period.slice(3)))}` : monthLabel(f.period)
  const filtered = f.period !== "ALL" || !!f.vendorId || !!f.search
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), today, d.locks)
  const mayEdit = canManageAdBluePayments(role, "edit")
  const mayDelete = canManageAdBluePayments(role, "delete") && can("adblue", "delete")
  const deletable = (p: AdBluePayment) => open(p.date) && p.allocations.every((a) => open(d.payableOf(a.purchaseId)?.date ?? p.date))
  const bills = (p: AdBluePayment) => [...new Set(p.allocations.map((a) => { const x = d.payableOf(a.purchaseId); return `${x ? PAYABLE_KIND_LABEL[x.kind] : ""} Bill ${x?.billNo || "—"}`.trim() }))]

  const mayPay = canManageAdBluePayments(role, "create")
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {title && <h2 className="text-base font-semibold">{title}</h2>}
        {mayPay && (
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <Plus /> Add Payment
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <StatsCard label="Total Settled" value={formatINR(settled)} hint={`${shown.length} payment${shown.length === 1 ? "" : "s"} · ${periodText}${f.vendorId ? ` · ${d.vendorName(f.vendorId)}` : ""}`} icon={IndianRupee} info="Σ of what the payments shown settle with the vendors: actual amount paid + TDS deducted. This is what reduces the vendors' outstanding." />
        <StatsCard label="Outstanding Vendor Payables" value={formatINR(owed.outstanding)} hint={`As of ${formatDate(asOf)}${f.vendorId ? ` · ${d.vendorName(f.vendorId)}` : ""}`} icon={Wallet} info="Σ over purchases dated up to the period's end of (value − paid). Advance with a vendor is never subtracted — it stays on each payment and vendor page." />
      </div>

      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={(v) => update({ search: v })} placeholder="UTR, cheque, receipt, invoice…" className="col-span-2 md:w-72" />
          <FilterSelect value={f.period === "ALL" ? ALL : f.period} onChange={(v) => update({ period: v === ALL ? "ALL" : v })} options={periodOptions} placeholder="Period" allLabel="All dates" className="w-full min-w-0 md:w-auto md:min-w-36" />
          {f.period === "RANGE" && (
            <>
              <Input type="date" value={f.from} max={today} onChange={(e) => update({ from: e.target.value })} className="h-8 md:w-40" aria-label="From date" />
              <Input type="date" value={f.to} max={today} onChange={(e) => update({ to: e.target.value })} className="h-8 md:w-40" aria-label="To date" />
            </>
          )}
          <FilterSelect value={f.vendorId || ALL} onChange={(v) => update({ vendorId: v === ALL ? "" : v })} options={vendors} placeholder="Vendor" allLabel="All vendors" className="w-full min-w-0 md:w-auto md:min-w-36" />
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
        dense
        emptyMessage={d.payments.length ? "No payment matches the filters." : "No AdBlue vendor payments yet — use Add Payment."}
        mobileColumns={["vendor", "settled", "status"]}
        columns={[
          { id: "date", header: "Payment Date", sortValue: (p) => p.date, cell: (p) => <span className="num">{formatDate(p.date)}</span>, footer: `${shown.length} payment${shown.length === 1 ? "" : "s"}` },
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (p) => d.vendorName(p.vendorId),
            // The vendor's page (Make Payment, Apply Advance, ledger) — the row itself opens the payment.
            cell: (p) => (
              <Link href={`/adblue/vendors/${p.vendorId}`} className="font-medium underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {d.vendorName(p.vendorId)}
              </Link>
            ),
          },
          { id: "settled", header: "Total Settled", align: "right", sortValue: (p) => settledOf(p), cell: (p) => <span className="num font-medium">{formatINR(settledOf(p))}</span>, footer: <span className="num">{formatINR(settled)}</span> },
          { id: "mode", header: "Payment Mode", sortValue: (p) => p.mode, cell: (p) => p.mode },
          { id: "status", header: "Status", sortValue: (p) => allocationStatus(p), cell: (p) => <AllocationBadge payment={p} /> },
        ]}
      />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <HandCoins className="size-3.5" /> Total Settled = actual amount paid + TDS deducted. Open a payment for its breakdown, allocations, Edit and Delete. Payments never change AdBlue stock.
      </p>

      {adding && <AdBluePaymentDialog onClose={() => setAdding(false)} />}
      {viewing && (() => {
        const p = d.payments.find((x) => x.id === viewing.id) ?? viewing
        return (
          <AdBluePaymentDetailsDialog
            payment={p}
            onClose={() => setViewing(null)}
            onEdit={mayEdit && open(p.date) ? () => (setViewing(null), setEditing(p)) : undefined}
            onDelete={mayDelete && deletable(p) ? () => setDeleting(p) : undefined}
          />
        )
      })()}
      {editing && <AdBluePaymentDialog key={editing.id} vendorId={editing.vendorId} payment={editing} edit onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteAdBluePaymentDialog
          payment={deleting}
          vendor={d.vendorName(deleting.vendorId)}
          bills={bills(deleting)}
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: deleting.id, reason, version: deleting.updatedAt })
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

/** AdBlue → Payments (`/adblue/payments`): the same payments view as the AdBlue page's Payments tab, on its own page. */
export function AdBluePaymentsPage() {
  const [role] = useRole()
  const d = useAdBlueFinance()
  if (!canManageAdBluePayments(role, "view")) return <NoAccess what="AdBlue payments" />
  if (!d.ready) return <PageSkeleton />
  return (
    <div className="space-y-5">
      <PageHeader backHref="/adblue" backLabel="AdBlue" title="AdBlue Payments" description="Every payment to AdBlue vendors — what it settled and the purchases it pays. Payments never change stock." />
      <AdBluePaymentsPanel title={null} />
    </div>
  )
}
