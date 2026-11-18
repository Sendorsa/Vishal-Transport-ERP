"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { CircleDot, HandCoins, IndianRupee, Landmark, Pencil, Percent, Plus, Receipt, Trash2, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable } from "@/components/shared/data-table"
import { ALL, FilterSelect } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { fyName, fyStartYear } from "@/domain/financial-year"
import { canEditMonth } from "@/domain/month-lock"
import { filteredLines, invoiceMatches, NO_FILTERS, PAY_STATUS_LABEL, referenceLabel, tyreTotals, unallocated, vendorLedger, type TyreFilters, type TyrePayStatus, type VendorAccount } from "@/domain/tyre"
import { useDeleteTyrePayment } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { TyrePayment } from "@/lib/types"
import { OfficeBadge } from "./tyre-register"
import { DeletePaymentDialog, SettledAmount, TyrePaymentDialog } from "./tyre-payment-dialog"
import { useTyreData } from "./tyre-data"

const STATUS_CLASS: Record<TyrePayStatus, string> = {
  PAID: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  PARTIAL: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  UNPAID: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
}
const ADVANCE_CLASS = "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300"

/** Paid · Partially Paid · Unpaid / Credit. */
export function PayStatusBadge({ status }: { status: TyrePayStatus }) {
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", STATUS_CLASS[status])}>
      {PAY_STATUS_LABEL[status]}
    </Badge>
  )
}

/** A vendor's net position: payable (we owe), advance (they hold our money) or settled. */
function Balance({ a }: { a: Pick<VendorAccount, "balance"> }) {
  if (a.balance > 0) return <span className="num font-semibold text-rose-700 dark:text-rose-400">{formatINR(a.balance)}</span>
  if (a.balance < 0)
    return (
      <Badge variant="outline" className={cn("num font-medium", ADVANCE_CLASS)}>
        Advance {formatINR(-a.balance)}
      </Badge>
    )
  return <span className="text-muted-foreground">Settled</span>
}

/**
 * Tyre page → Vendor Purchases: every vendor's complete history (all months, not the current one) — what we bought,
 * what we settled (paid + TDS), and Credit Left = Total Purchased − Total Settled (an advance shown as such, never hidden).
 */
export function VendorPurchases() {
  const d = useTyreData()
  const rows = useMemo(() => d.accounts.map((a) => ({ ...a, name: d.name(a.supplierId) })).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name)), [d])
  const sum = (k: "purchased" | "paid", keep: (r: (typeof rows)[number]) => boolean = () => true) => rows.filter(keep).reduce((t, r) => Math.round((t + r[k]) * 100) / 100, 0)
  // Never netted across vendors: what we owe some vendors and what others hold of ours are shown apart.
  const payable = rows.reduce((t, r) => (r.balance > 0 ? Math.round((t + r.balance) * 100) / 100 : t), 0)
  const advance = rows.reduce((t, r) => (r.balance < 0 ? Math.round((t - r.balance) * 100) / 100 : t), 0)
  return (
    <section className="space-y-2" aria-labelledby="vendor-purchases">
      <div>
        <h2 id="vendor-purchases" className="text-sm font-semibold">
          Vendor Purchases
        </h2>
        <p className="text-xs text-muted-foreground">Every month on record, every invoice (paid, part-paid or on credit). Credit Left = Total Purchased − Total Settled (paid + TDS). Open a vendor for its bills, services and payments.</p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No vendor purchases recorded yet.</p>
      ) : (
        <DataTable
          data={rows}
          getRowId={(r) => r.supplierId}
          rowHref={(r) => `/tyre/vendors/${r.supplierId}`}
          initialSort={{ id: "credit", desc: true }}
          pageSize={10}
          showFooter
          mobileColumns={["purchased", "paid", "credit"]}
          columns={[
            {
              id: "vendor",
              header: "Vendor",
              sortValue: (r) => r.name,
              cell: (r) => (
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.invoices} invoice{r.invoices === 1 ? "" : "s"} · {r.payments} payment{r.payments === 1 ? "" : "s"}
                  </div>
                </div>
              ),
              footer: `${rows.length} vendor${rows.length === 1 ? "" : "s"}`,
            },
            { id: "purchased", header: "Total Purchased", align: "right", sortValue: (r) => r.purchased, cell: (r) => <span className="num">{formatINR(r.purchased)}</span>, footer: <span className="num">{formatINR(sum("purchased"))}</span> },
            {
              id: "paid",
              header: "Total Settled",
              align: "right",
              sortValue: (r) => r.paid,
              cell: (r) => (
                <div className="flex flex-col items-end">
                  <span className="num">{formatINR(r.paid)}</span>
                  {r.tds > 0 && <span className="num text-xs text-muted-foreground">incl. {formatINR(r.tds)} TDS</span>}
                </div>
              ),
              footer: <span className="num">{formatINR(sum("paid"))}</span>,
            },
            { id: "credit", header: "Credit Left", align: "right", sortValue: (r) => r.balance, cell: (r) => <Balance a={r} />, footer: (
                <div className="space-y-0.5">
                  <div className="num text-rose-700 dark:text-rose-400">{formatINR(payable)} payable</div>
                  {advance > 0 && <div className="num text-sky-700 dark:text-sky-400">{formatINR(advance)} advance</div>}
                </div>
              ),
            },
          ]}
        />
      )}
    </section>
  )
}

/** Vendor page: summary, purchase history, repair / service lines, and the payments ledger with Add Payment. */
export function TyreVendorDetail({ id }: { id: string }) {
  const can = useCan()
  const [role] = useRole()
  const d = useTyreData()
  const deletePay = useDeleteTyrePayment()
  const [f, setF] = useState<TyreFilters>({ ...NO_FILTERS, supplierId: id })
  const [paying, setPaying] = useState<{ payment?: TyrePayment; edit?: boolean } | null>(null)
  const [deleting, setDeleting] = useState<TyrePayment | null>(null)
  const [tab, setTab] = useState("history")
  const today = todayISO()

  const invoices = useMemo(() => d.views.filter((v) => v.supplierId === id), [d.views, id])
  const shown = useMemo(() => invoices.filter((v) => invoiceMatches(v, f)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [invoices, f])
  const lines = useMemo(() => filteredLines(invoices, f), [invoices, f])
  const payments = useMemo(() => d.payments.filter((p) => p.supplierId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [d.payments, id])
  const ledger = useMemo(() => vendorLedger(invoices, payments, id).reverse(), [invoices, payments, id])

  if (!can("tyres")) return <NoAccess what="Tyre" />
  if (!d.ready) return <PageSkeleton />
  const vendor = d.masters.find((m) => m.id === id && m.kind === "SUPPLIER")
  if (!vendor) return <EmptyState icon={CircleDot} title="Vendor not found" action={<Button asChild variant="outline"><Link href="/tyre">Back to Tyre</Link></Button>} />

  const acc = d.accounts.find((a) => a.supplierId === id) ?? { purchased: 0, paid: 0, cashPaid: 0, tds: 0, outstanding: 0, advance: 0, balance: 0, invoices: 0, payments: 0 }
  const owing = invoices.filter((v) => d.payOf(v).outstanding > 0)
  const byId = new Map(invoices.map((v) => [v.id, v]))
  const bill = (invoiceId: string) => `Bill ${byId.get(invoiceId)?.billNo || "—"}`
  const set = (k: keyof TyreFilters) => (v: string) => setF((s) => ({ ...s, [k]: v === ALL ? "" : v }))
  const uniq = <T,>(xs: T[]) => [...new Set(xs)]
  const opts = {
    period: [
      ...uniq(invoices.map((v) => fyStartYear(v.date)))
        .sort((a, b) => b - a)
        .map((y) => ({ value: `FY:${y}`, label: `FY ${fyName(y)}` })),
      { value: "RANGE", label: "Date range…" },
    ],
    company: uniq(invoices.map((v) => (v.office ? "OFFICE" : (v.customerId ?? "")))).map((c) => ({ value: c, label: c === "OFFICE" ? "Office / No Customer" : d.companyName(c) })),
    vehicle: uniq(invoices.map((v) => v.vehicleId)).map((x) => ({ value: x, label: invoices.find((v) => v.vehicleId === x)!.regNo })).sort((a, b) => a.label.localeCompare(b.label)),
    repair: uniq(invoices.flatMap((v) => v.items.map((i) => i.repairTypeId))).map((x) => ({ value: x, label: d.name(x) })).sort((a, b) => a.label.localeCompare(b.label)),
  }
  const shownTotals = tyreTotals(shown.flatMap((v) => v.items))
  const shownPay = shown.reduce((t, v) => ({ paid: t.paid + d.payOf(v).paid, outstanding: t.outstanding + d.payOf(v).outstanding }), { paid: 0, outstanding: 0 })
  const lineTotals = tyreTotals(lines.map((r) => r.item))
  const filtered = f.period !== "ALL" || f.customerId || f.vehicleId || f.repairTypeId
  const mayPay = can("tyres", "create")
  const mayApply = can("tyres", "edit")
  const mayDelete = can("tyres", "delete")
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), today, d.locks)
  const pay = new Map(payments.map((p) => [p.id, p]))

  return (
    <div className="space-y-5">
      <PageHeader
        backHref="/tyre"
        backLabel="Tyre"
        title={vendor.name}
        meta={vendor.status === "ARCHIVED" ? <Badge variant="outline">Archived</Badge> : undefined}
        description="Tyre vendor · every invoice and payment on record"
        actions={
          mayPay && (
            <Button onClick={() => setPaying({})}>
              <Plus /> Add Payment
            </Button>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <StatsCard label="Total Purchased" value={formatINR(acc.purchased)} hint={`${acc.invoices} invoice${acc.invoices === 1 ? "" : "s"}, incl. GST`} icon={Receipt} info="Σ of every invoice's grand total from this vendor (base + GST) — paid, part-paid and credit invoices alike." />
        <StatsCard label="Total Settled" value={formatINR(acc.paid)} hint={`${acc.payments} payment${acc.payments === 1 ? "" : "s"} · paid + TDS`} icon={IndianRupee} info="Σ of what the payments to this vendor settle: the amount paid plus any TDS deducted This is what reduces the payable." />
        <StatsCard label="Actual Amount Paid" value={formatINR(acc.cashPaid)} hint="Bank / cash transferred to the vendor" icon={Landmark} info="Σ of the money that actually reached the vendor — the settled amount less TDS deducted." />
        <StatsCard label="TDS Deducted" value={formatINR(acc.tds)} hint={acc.tds ? "Withheld from payments — not paid to the vendor" : "No TDS deducted"} icon={Percent} info="Σ of TDS withheld from payments to this vendor. Counted once, inside Total Settled — never added on top." />
        <StatsCard
          label="Outstanding Credit"
          value={formatINR(acc.outstanding)}
          hint={owing.length ? `${owing.length} bill${owing.length === 1 ? "" : "s"} not fully paid${acc.advance > 0 && acc.outstanding > 0 ? ` · net payable ${formatINR(Math.max(0, acc.balance))}` : ""}` : "Every bill paid"}
          icon={Wallet}
          info="Σ of each invoice's outstanding amount (total − payments allocated to it). Net position = Total Purchased − Total Settled = Outstanding − Advance."
          prominent={acc.outstanding > 0}
        />
        <StatsCard
          label="Available Advance Credit"
          value={formatINR(acc.advance)}
          hint={acc.advance > 0 ? (owing.length ? "Not yet applied — apply it to a bill below" : "With the vendor, for later bills") : "No advance with this vendor"}
          icon={HandCoins}
          info="Σ of the parts of payments not allocated to any bill: money with the vendor, applied to a later bill with Apply advance."
          className={acc.advance > 0 ? "border-sky-300/70 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/30" : undefined}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-3">
        {/* Phones: short labels, so all three tabs fit without scrolling the tab bar. */}
        <TabsList>
          <TabsTrigger value="history"><span className="sm:hidden">History</span><span className="max-sm:hidden">Purchase history</span> · {invoices.length}</TabsTrigger>
          <TabsTrigger value="services"><span className="sm:hidden">Services</span><span className="max-sm:hidden">Repair &amp; service details</span> · {invoices.reduce((t, v) => t + v.items.length, 0)}</TabsTrigger>
          <TabsTrigger value="ledger"><span className="sm:hidden">Payments</span><span className="max-sm:hidden">Payments &amp; ledger</span> · {payments.length}</TabsTrigger>
        </TabsList>

        {/* The filters apply to the purchase history and the service lines (the summary and the ledger are always complete). */}
        <div className={cn("grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center", tab === "ledger" && "hidden")}>
          <FilterSelect value={f.period === "ALL" ? ALL : f.period} onChange={(v) => setF((s) => ({ ...s, period: v === ALL ? "ALL" : v }))} options={opts.period} placeholder="Period" allLabel="All dates" className="w-full min-w-0 md:w-auto md:min-w-36" />
          {f.period === "RANGE" && (
            <>
              <Input type="date" value={f.from} max={today} onChange={(e) => setF((s) => ({ ...s, from: e.target.value }))} className="h-8 md:w-40" aria-label="From date" />
              <Input type="date" value={f.to} max={today} onChange={(e) => setF((s) => ({ ...s, to: e.target.value }))} className="h-8 md:w-40" aria-label="To date" />
            </>
          )}
          <FilterSelect value={f.customerId || ALL} onChange={set("customerId")} options={opts.company} placeholder="Company" allLabel="All companies" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.vehicleId || ALL} onChange={set("vehicleId")} options={opts.vehicle} placeholder="Vehicle" allLabel="All vehicles" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.repairTypeId || ALL} onChange={set("repairTypeId")} options={opts.repair} placeholder="Repair type" allLabel="All repair types" className="w-full min-w-0 md:w-auto md:min-w-36" />
          {filtered && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => setF({ ...NO_FILTERS, supplierId: id })}>
              Reset filters
            </Button>
          )}
        </div>

        <TabsContent value="history" className="mt-0">
          <DataTable
            data={shown}
            getRowId={(v) => v.id}
            rowHref={(v) => `/tyre/${v.id}?from=vendor`}
            initialSort={{ id: "date", desc: true }}
            showFooter
            emptyMessage={invoices.length ? "No invoice matches the filters." : `No invoices from ${vendor.name} yet.`}
            mobileColumns={["vehicle", "amount", "outstanding", "status"]}
            columns={[
              { id: "date", header: "Invoice Date", sortValue: (v) => v.date, cell: (v) => <span className="num">{formatDate(v.date)}</span>, footer: `${shown.length} invoice${shown.length === 1 ? "" : "s"}` },
              { id: "bill", header: "Bill No.", sortValue: (v) => v.billNo, cell: (v) => <span className="font-medium">{v.billNo || "—"}</span> },
              { id: "company", header: "Company", sortValue: (v) => v.company, cell: (v) => (v.office ? <OfficeBadge className="h-auto whitespace-normal" /> : v.company) },
              { id: "vehicle", header: "Vehicle", sortValue: (v) => v.regNo, cell: (v) => <span className="num font-medium">{v.regNo}</span> },
              {
                id: "items",
                header: "Repair Items",
                hideOnMobile: true,
                sortValue: (v) => v.items.length,
                cell: (v) => (
                  <div className="max-w-64 min-w-40 text-xs whitespace-normal">
                    <span className="num font-medium">{v.items.length}</span> · <span className="text-muted-foreground">{uniq(v.items.map((i) => d.name(i.repairTypeId))).join(", ")}</span>
                  </div>
                ),
              },
              { id: "amount", header: "Invoice Amount", align: "right", sortValue: (v) => v.totals.grandTotal, cell: (v) => <span className="num">{formatINR(v.totals.grandTotal)}</span>, footer: <span className="num">{formatINR(shownTotals.grandTotal)}</span> },
              { id: "paid", header: "Amount Paid", align: "right", sortValue: (v) => d.payOf(v).paid, cell: (v) => <span className="num">{formatINR(d.payOf(v).paid)}</span>, footer: <span className="num">{formatINR(Math.round(shownPay.paid * 100) / 100)}</span> },
              { id: "outstanding", header: "Outstanding", align: "right", sortValue: (v) => d.payOf(v).outstanding, cell: (v) => <span className={cn("num", d.payOf(v).outstanding > 0 && "font-medium text-rose-700 dark:text-rose-400")}>{formatINR(d.payOf(v).outstanding)}</span>, footer: <span className="num">{formatINR(Math.round(shownPay.outstanding * 100) / 100)}</span> },
              { id: "status", header: "Status", sortValue: (v) => d.payOf(v).status, cell: (v) => <PayStatusBadge status={d.payOf(v).status} /> },
            ]}
          />
        </TabsContent>

        <TabsContent value="services" className="mt-0">
          <DataTable
            data={lines}
            getRowId={(r) => r.item.id}
            rowHref={(r) => `/tyre/${r.invoice.id}?from=vendor`}
            initialSort={{ id: "date", desc: true }}
            showFooter
            emptyMessage={invoices.length ? "No repair line matches the filters." : `No work bought from ${vendor.name} yet.`}
            mobileColumns={["repair", "vehicle", "qty", "total"]}
            columns={[
              { id: "date", header: "Date", sortValue: (r) => r.invoice.date, cell: (r) => <span className="num">{formatDate(r.invoice.date)}</span>, footer: `${lines.length} line${lines.length === 1 ? "" : "s"}` },
              { id: "bill", header: "Bill No.", sortValue: (r) => r.invoice.billNo, cell: (r) => r.invoice.billNo || "—" },
              { id: "company", header: "Company", hideOnMobile: true, sortValue: (r) => r.invoice.company, cell: (r) => (r.invoice.office ? <OfficeBadge className="h-auto whitespace-normal" /> : r.invoice.company) },
              { id: "vehicle", header: "Vehicle", sortValue: (r) => r.invoice.regNo, cell: (r) => <span className="num">{r.invoice.regNo}</span> },
              { id: "repair", header: "Repair / Service", sortValue: (r) => d.name(r.item.repairTypeId), cell: (r) => <span className="font-medium">{d.name(r.item.repairTypeId)}</span> },
              { id: "brand", header: "Tyre Brand", hideOnMobile: true, sortValue: (r) => d.name(r.item.brandId), cell: (r) => d.name(r.item.brandId) || "—" },
              { id: "size", header: "Tyre Size", hideOnMobile: true, sortValue: (r) => d.name(r.item.sizeId), cell: (r) => d.name(r.item.sizeId) || "—" },
              { id: "qty", header: "Qty", align: "right", sortValue: (r) => r.item.quantity, cell: (r) => <span className="num">{formatNumber(r.item.quantity, r.item.quantity % 1 ? 3 : 0)}</span> },
              { id: "rate", header: "Rate", align: "right", hideOnMobile: true, sortValue: (r) => r.item.rate, cell: (r) => <span className="num">{formatINR(r.item.rate)}</span> },
              { id: "total", header: "Total Amount", align: "right", sortValue: (r) => r.item.totalValue, cell: (r) => <span className="num font-medium">{formatINR(r.item.totalValue)}</span>, footer: <span className="num">{formatINR(lineTotals.grandTotal)}</span> },
            ]}
          />
        </TabsContent>

        <TabsContent value="ledger" className="mt-0 space-y-5">
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">How to read this ledger:</span> a purchase is <span className="font-medium text-foreground">credited</span> to {vendor.name}&apos;s account (we owe more); a payment is{" "}
            <span className="font-medium text-foreground">debited</span> (we owe less). Balance = Σ purchases − Σ payments: <span className="text-rose-700 dark:text-rose-400">Payable</span> = we owe the vendor,{" "}
            <span className="text-sky-700 dark:text-sky-400">Advance</span> = the vendor holds our money. No opening balance is recorded for tyre vendors — the ledger starts at the first bill or payment.
          </p>
          <DataTable
            data={ledger}
            getRowId={(r) => `${r.kind}:${r.id}`}
            pageSize={20}
            emptyMessage="No purchases or payments yet."
            mobileColumns={["type", "debit", "credit", "balance"]}
            columns={[
              { id: "date", header: "Date", cell: (r) => <span className="num">{formatDate(r.date)}</span> },
              {
                id: "type",
                header: "Type",
                cell: (r) => (
                  <Badge variant="outline" className={r.kind === "PAYMENT" ? ADVANCE_CLASS : undefined}>
                    {r.kind === "PURCHASE" ? "Purchase" : "Payment"}
                  </Badge>
                ),
              },
              {
                id: "ref",
                header: "Bill No. / Reference",
                cell: (r) =>
                  r.kind === "PURCHASE" ? (
                    <Link href={`/tyre/${r.id}?from=vendor`} className="font-medium underline-offset-2 hover:underline">
                      Bill {byId.get(r.id)?.billNo || "—"}
                    </Link>
                  ) : (
                    <span className="num text-xs break-all">UTR {pay.get(r.id)?.utr}</span>
                  ),
              },
              {
                id: "desc",
                header: "Description",
                hideOnMobile: true,
                cell: (r) => {
                  if (r.kind === "PURCHASE") {
                    const v = byId.get(r.id)!
                    return <span className="text-xs">{v.regNo} · {v.items.length} line{v.items.length === 1 ? "" : "s"} · {v.office ? "Office / No Customer" : v.company}</span>
                  }
                  const p = pay.get(r.id)!
                  const adv = unallocated(p)
                  return (
                    <span className="text-xs">
                      {p.mode}
                      {p.allocations.length ? ` · for ${uniq(p.allocations.map((a) => bill(a.invoiceId))).join(", ")}` : ""}
                      {adv > 0 ? ` · ${formatINR(adv)} advance` : ""}
                    </span>
                  )
                },
              },
              {
                id: "debit",
                header: "Debit (settled)",
                align: "right",
                cell: (r) =>
                  r.debit ? (
                    <div className="flex flex-col items-end">
                      <span className="num">{formatINR(r.debit)}</span>
                      {r.tds > 0 && <span className="num max-w-36 text-right text-xs whitespace-normal text-muted-foreground">{formatINR(r.paid)} paid + {formatINR(r.tds)} TDS</span>}
                    </div>
                  ) : (
                    ""
                  ),
              },
              { id: "credit", header: "Credit (bought)", align: "right", cell: (r) => (r.credit ? <span className="num">{formatINR(r.credit)}</span> : "") },
              {
                id: "balance",
                header: "Balance",
                align: "right",
                cell: (r) =>
                  r.balance > 0 ? (
                    <span className="num font-medium text-rose-700 dark:text-rose-400">{formatINR(r.balance)} Payable</span>
                  ) : r.balance < 0 ? (
                    <span className="num font-medium text-sky-700 dark:text-sky-400">{formatINR(-r.balance)} Advance</span>
                  ) : (
                    <span className="num text-muted-foreground">₹0.00</span>
                  ),
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Newest first. Closing balance = Total Purchased {formatINR(acc.purchased)} − Total Settled {formatINR(acc.paid)} = <Balance a={acc} />. Settled = paid to the vendor {formatINR(acc.cashPaid)} + TDS deducted {formatINR(acc.tds)}.
          </p>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Payments · {payments.length}</h3>
            <DataTable
              data={payments}
              getRowId={(p) => p.id}
              pageSize={20}
              emptyMessage={mayPay ? "No payments yet — use Add Payment." : "No payments yet."}
              mobileColumns={["amount", "for", "advance", "act"]}
              columns={[
                { id: "date", header: "Date", cell: (p) => <span className="num">{formatDate(p.date)}</span> },
                {
                  id: "utr",
                  header: "Mode · Reference",
                  cell: (p) => (
                    <div>
                      <div className="font-medium">{p.mode}</div>
                      <div className="num text-xs break-all" title={referenceLabel(p.mode)}>{p.utr}</div>
                    </div>
                  ),
                },
                { id: "amount", header: "Settled", align: "right", cell: (p) => <SettledAmount payment={p} /> },
                {
                  id: "for",
                  header: "Allocated To",
                  cell: (p) =>
                    p.allocations.length ? (
                      <div className="space-y-0.5 text-xs">
                        {p.allocations.map((a, n) => (
                          <div key={n}>
                            <Link href={`/tyre/${a.invoiceId}?from=vendor`} className="underline-offset-2 hover:underline">
                              {bill(a.invoiceId)}
                            </Link>{" "}
                            <span className="num text-muted-foreground">{formatINR(a.amount)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    ),
                },
                {
                  id: "advance",
                  header: "Advance Left",
                  align: "right",
                  cell: (p) =>
                    unallocated(p) > 0 ? (
                      <Badge variant="outline" className={cn("num", ADVANCE_CLASS)}>{formatINR(unallocated(p))}</Badge>
                    ) : (
                      <span className="num text-muted-foreground">₹0.00</span>
                    ),
                },
                {
                  id: "notes",
                  header: "Details",
                  hideOnMobile: true,
                  cell: (p) => (
                    <div className="max-w-56 min-w-32 text-xs whitespace-normal text-muted-foreground">
                      {[p.reference && `Ref. ${p.reference}`, p.companyCode && `Paid by ${p.companyCode}`, p.notes].filter(Boolean).join(" · ") || "—"}
                    </div>
                  ),
                },
                {
                  id: "act",
                  header: "",
                  align: "right",
                  cell: (p) => (
                      <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                        {mayApply && unallocated(p) > 0 && owing.length > 0 && (
                          <Button variant="outline" size="sm" className="h-7" onClick={() => setPaying({ payment: p })}>
                            Apply advance
                          </Button>
                        )}
                        {mayApply && open(p.date) && (
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit the payment of ${formatDate(p.date)}`} title="Edit payment" onClick={() => setPaying({ payment: p, edit: true })}>
                            <Pencil />
                          </Button>
                        )}
                        {mayDelete && open(p.date) && p.allocations.every((a) => open(byId.get(a.invoiceId)?.date ?? p.date)) && (
                          <Button variant="ghost" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete the payment of ${formatDate(p.date)}`} title="Delete payment" onClick={() => setDeleting(p)}>
                            <Trash2 />
                          </Button>
                        )}
                      </span>
                    ),
                },
              ]}
            />
          </section>
        </TabsContent>
      </Tabs>

      {paying && <TyrePaymentDialog key={`${paying.payment?.id ?? "new"}:${!!paying.edit}`} supplierId={id} payment={paying.payment} edit={paying.edit} onClose={() => setPaying(null)} />}
      {deleting && (
        <DeletePaymentDialog
          payment={deleting}
          vendor={vendor.name}
          bills={uniq(deleting.allocations.map((a) => bill(a.invoiceId)))}
          pending={deletePay.isPending}
          onConfirm={async (reason) => {
            await deletePay.mutateAsync({ id: deleting.id, reason, version: deleting.updatedAt })
            toast.success("Payment deleted")
            setDeleting(null)
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
