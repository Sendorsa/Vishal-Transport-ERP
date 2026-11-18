"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { HandCoins, Hash, IndianRupee, Landmark, Pencil, Percent, Plus, Trash2, Wallet, WalletCards } from "lucide-react"
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
import { ADBLUE_PAYMENT_MODES, ALLOCATION_STATUS_LABEL, allocationStatus, periodRange, referenceLabel, settledOf, supplierTotals, unallocated, vendorAccounts, type AllocationStatus } from "@/domain/adblue-payments"
import { useDeleteAdBluePayment } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { canManageAdBluePayments } from "@/lib/permissions"
import { formatDate, formatINR, formatNumber, round2, todayISO } from "@/lib/format"
import type { AdBluePayment } from "@/lib/types"
import { AdBluePaymentDetailsDialog, AdBluePaymentDialog, AllocationBadge, DeleteAdBluePaymentDialog } from "./adblue-payment-dialog"
import { useAdBlueFinance } from "./adblue-data"

interface Filters {
  /** "ALL", a month "yyyy-MM", "FY:2026" or "RANGE" (from / to). */
  period: string
  from: string
  to: string
  vendorId: string
  mode: string
  tds: "" | "ON" | "OFF"
  status: "" | AllocationStatus
  search: string
}
const NO_FILTERS: Filters = { period: "ALL", from: "", to: "", vendorId: "", mode: "", tds: "", status: "", search: "" }
const KEY = "vt:ui:adbluePayments" // this browser only: the filters survive opening a vendor and coming back

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
 * AdBlue → Payments (owner, 18 Nov 2026): every payment to every AdBlue vendor — settled, paid, TDS, allocations and
 * status, with Edit (Owner / Dev / Employee) and Delete (permanent: the Owner / Dev, with a reason). Record a payment
 * from the vendor's account. Never stock.
 */
export function AdBluePaymentsPanel() {
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
      .filter((p) => !f.mode || p.mode === f.mode)
      .filter((p) => !f.tds || (f.tds === "ON") === p.tdsAmount > 0)
      .filter((p) => !f.status || allocationStatus(p) === f.status)
      .filter((p) => !q || [p.utr, p.notes, d.vendorName(p.vendorId), ...p.allocations.map((a) => d.purchase(a.purchaseId)?.invoiceNo ?? "")].some((s) => norm(s ?? "").includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [d, f, range])

  const sum = (g: (p: AdBluePayment) => number) => shown.reduce((t, p) => round2(t + g(p)), 0)
  const settled = sum(settledOf)
  const paid = sum((p) => p.amount)
  const tds = sum((p) => p.tdsAmount)
  // Payables and advance at the end of the period (today for all dates), per vendor — never netted across vendors.
  const asOf = range ? (range.to > today ? today : range.to) : today
  const owed = supplierTotals(
    vendorAccounts(
      d.purchases.filter((p) => p.date <= asOf && (!f.vendorId || p.adblueVendorId === f.vendorId)),
      d.payments.filter((p) => p.date <= asOf && (!f.vendorId || p.vendorId === f.vendorId))
    )
  )

  const vendors = [...new Set(d.payments.map((p) => p.vendorId))].map((id) => ({ value: id, label: d.vendorName(id) })).sort((a, b) => a.label.localeCompare(b.label))
  const months = [...new Set(d.payments.map((p) => p.date.slice(0, 7)))].sort().reverse()
  const fys = [...new Set(d.payments.map((p) => fyStartYear(p.date)))].sort((a, b) => b - a)
  const periodOptions = [...months.map((m) => ({ value: m, label: monthLabel(m) })), ...fys.map((y) => ({ value: `FY:${y}`, label: `FY ${fyName(y)}` })), { value: "RANGE", label: "Date range…" }]
  const periodText = f.period === "ALL" ? "All dates" : f.period === "RANGE" ? `${f.from ? formatDate(f.from) : "…"} – ${f.to ? formatDate(f.to) : "…"}` : f.period.startsWith("FY:") ? `FY ${fyName(Number(f.period.slice(3)))}` : monthLabel(f.period)
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTERS)
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), today, d.locks)
  const mayEdit = canManageAdBluePayments(role, "edit")
  const mayDelete = canManageAdBluePayments(role, "delete") && can("adblue", "delete")
  const deletable = (p: AdBluePayment) => open(p.date) && p.allocations.every((a) => open(d.purchase(a.purchaseId)?.date ?? p.date))
  const bills = (p: AdBluePayment) => [...new Set(p.allocations.map((a) => `Bill ${d.purchase(a.purchaseId)?.invoiceNo || "—"}`))]

  const mayPay = canManageAdBluePayments(role, "create")
  return (
    <div className="space-y-5">
      {mayPay && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Pay an AdBlue vendor: choose the vendor, enter the payment, allocate it to its purchases, save. <span className="hidden sm:inline">The vendor&apos;s ledger updates at once.</span>
          </p>
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add Payment
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatsCard label="Total Payments" value={formatNumber(shown.length)} hint={periodText} icon={Hash} info="Number of payments to AdBlue vendors shown (filters applied)." />
        <StatsCard label="Total Amount Settled" value={formatINR(settled)} hint={`${shown.length} payment${shown.length === 1 ? "" : "s"} · ${periodText}`} icon={IndianRupee} info="Σ of what the payments shown settle with the vendors: paid + TDS deducted. This is what reduces the vendors' outstanding." prominent />
        <StatsCard label="Actual Amount Paid" value={formatINR(paid)} hint="Bank / cash transferred" icon={Landmark} info="Σ of the money that actually reached the vendors — settled less TDS." />
        <StatsCard label="Total TDS Deducted" value={formatINR(tds)} hint={tds ? "Withheld — counted once, inside settled" : "No TDS deducted"} icon={Percent} info="Σ TDS withheld from the payments shown. It is part of Total Payments Settled, never added on top." />
        <StatsCard label="Outstanding Vendor Payables" value={formatINR(owed.outstanding)} hint={`As of ${formatDate(asOf)}${f.vendorId ? ` · ${d.vendorName(f.vendorId)}` : ""}`} icon={Wallet} info="Σ over purchases dated up to the period's end of (value − paid). Advance with a vendor is shown separately, never subtracted." />
        <StatsCard label="Advance Credit" value={formatINR(owed.advance)} hint={`As of ${formatDate(asOf)} · not yet on a purchase`} icon={WalletCards} info="Σ of the payments' parts not allocated to any purchase (dated up to the period's end) — credit the vendors hold for later purchases." />
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
          <FilterSelect value={f.mode || ALL} onChange={(v) => update({ mode: v === ALL ? "" : v })} options={ADBLUE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Mode" allLabel="All modes" className="w-full min-w-0 md:w-auto md:min-w-32" />
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
        emptyMessage={d.payments.length ? "No payment matches the filters." : "No AdBlue vendor payments yet — record one from a vendor's account (Vendor Accounts tab)."}
        mobileColumns={["vendor", "settled", "status", "act"]}
        columns={[
          { id: "date", header: "Payment Date", sortValue: (p) => p.date, cell: (p) => <span className="num">{formatDate(p.date)}</span>, footer: `${shown.length} payment${shown.length === 1 ? "" : "s"}` },
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (p) => d.vendorName(p.vendorId),
            cell: (p) => (
              <Link href={`/adblue/vendors/${p.vendorId}`} className="font-medium underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {d.vendorName(p.vendorId)}
              </Link>
            ),
          },
          {
            id: "ref",
            header: "Reference",
            cell: (p) => (
              <div className="max-w-56 min-w-36 text-xs whitespace-normal">
                <div className="num break-all">{p.utr}</div>
                <div className="text-muted-foreground">{referenceLabel(p.mode)}</div>
              </div>
            ),
          },
          { id: "mode", header: "Mode", sortValue: (p) => p.mode, cell: (p) => p.mode },
          { id: "settled", header: "Total Settled", align: "right", sortValue: (p) => settledOf(p), cell: (p) => <span className="num font-medium">{formatINR(settledOf(p))}</span>, footer: <span className="num">{formatINR(settled)}</span> },
          { id: "rate", header: "TDS %", align: "right", hideOnMobile: true, sortValue: (p) => p.tdsRate ?? -1, cell: (p) => (p.tdsRate != null ? <span className="num">{formatNumber(p.tdsRate, 4)}%</span> : <span className="text-muted-foreground">—</span>) },
          { id: "tds", header: "TDS Amount", align: "right", sortValue: (p) => p.tdsAmount, cell: (p) => (p.tdsAmount > 0 ? <span className="num">{formatINR(p.tdsAmount)}</span> : <span className="text-muted-foreground">—</span>), footer: <span className="num">{formatINR(tds)}</span> },
          { id: "paid", header: "Actual Paid", align: "right", sortValue: (p) => p.amount, cell: (p) => <span className="num">{formatINR(p.amount)}</span>, footer: <span className="num">{formatINR(paid)}</span> },
          {
            id: "bills",
            header: "Allocated Purchase(s)",
            hideOnMobile: true,
            cell: (p) => (
              <div className="max-w-48 space-y-0.5 text-xs whitespace-normal">
                {p.allocations.map((a, n) => (
                  <div key={n}>
                    Bill {d.purchase(a.purchaseId)?.invoiceNo || "—"} <span className="num text-muted-foreground">{formatINR(a.amount)}</span>
                  </div>
                ))}
                {unallocated(p) > 0 && <div className="num text-sky-700 dark:text-sky-400">{formatINR(unallocated(p))} advance</div>}
              </div>
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
        <HandCoins className="size-3.5" /> Settled = paid to the vendor + TDS deducted. Payments never change AdBlue stock. Deleting a payment removes it and its allocations permanently (the audit log keeps it).
      </p>

      {adding && <AdBluePaymentDialog onClose={() => setAdding(false)} />}
      {viewing && <AdBluePaymentDetailsDialog payment={d.payments.find((p) => p.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} />}
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
      <PageHeader backHref="/adblue" backLabel="AdBlue" title="AdBlue Payments" description="Every payment to AdBlue vendors — what it settled, what was paid, TDS and the purchases it pays. Payments never change stock." />
      <AdBluePaymentsPanel />
    </div>
  )
}
