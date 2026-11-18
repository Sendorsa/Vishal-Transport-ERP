"use client"

import { useMemo, useState } from "react"
import { Droplets, HandCoins, IndianRupee, Landmark, Package, PackagePlus, Pencil, Plus, Trash2, Wallet, WalletCards } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HistoryButton } from "@/components/shared/audit"
import { DataTable } from "@/components/shared/data-table"
import { NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { stockDraws, valueInventory, vendorLedger as stockLedger } from "@/domain/adblue-inventory"
import { gstOf, PAYABLE_KIND_LABEL, PURCHASE_PAY_LABEL, type Payable, referenceLabel, settledOf, unallocated, vendorLedger, type PurchasePayStatus } from "@/domain/adblue-payments"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { useAdBlueEntries, useAdBlueVehicles, useDeleteAdBluePayment } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { canManageAdBluePayments } from "@/lib/permissions"
import { formatDate, formatINR, formatLitres as L, formatNumber, round2, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AdBluePayment, AdBluePurchase } from "@/lib/types"
import { AdBluePaymentDialog, AllocationBadge, DeleteAdBluePaymentDialog, PayableKindBadge, SettledAmount } from "./adblue-payment-dialog"
import { useAdBlueFinance, type AdBlueFinance } from "./adblue-data"

export const PAY_CLASS: Record<PurchasePayStatus, string> = {
  PAID: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  PARTIAL: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  UNPAID: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
}
export const PurchaseStatusBadge = ({ status }: { status: PurchasePayStatus }) => (
  <Badge variant="outline" className={cn("font-medium whitespace-nowrap", PAY_CLASS[status])}>
    {PURCHASE_PAY_LABEL[status]}
  </Badge>
)
const ratePerLitre = (p: AdBluePurchase) => (p.totalLitres > 0 ? round2(p.totalCost / p.totalLitres) : 0)

/**
 * AdBlue → Vendor Accounts → one vendor (owner, 18 Nov 2026): what we bought, paid and still owe, and the stock left of
 * its batches. Purchase history · Stock history (FIFO, unchanged) · Payments (Add Payment, Apply advance, Edit, Delete)
 * · Vendor ledger (purchase = debit, payment = credit; balance + Payable / − Advance). The Owner, Dev and Employee.
 */
export function AdBlueVendorAccount({ id }: { id: string }) {
  const [role] = useRole()
  const d = useAdBlueFinance()
  const entries = useAdBlueEntries()
  const regs = useAdBlueVehicles()
  const del = useDeleteAdBluePayment()
  const [paying, setPaying] = useState<{ payment?: AdBluePayment; edit?: boolean; vendorAdvance?: boolean } | null>(null)
  const [deleting, setDeleting] = useState<AdBluePayment | null>(null)
  const [viewing, setViewing] = useState<Payable | null>(null)
  const [tab, setTab] = useState("purchases")
  const today = todayISO()

  const draws = useMemo(() => stockDraws(entries.data ?? []), [entries.data])
  const stock = useMemo(() => valueInventory(d.purchases, draws), [d.purchases, draws])
  if (!d.canPay) return <NoAccess what="AdBlue vendor accounts" />
  if (!d.ready || !entries.data) return <PageSkeleton />
  const vendor = d.vendors.find((v) => v.id === id)
  if (!vendor) return <NoAccess what="this AdBlue vendor" />

  const acc = d.accounts.find((a) => a.vendorId === id) ?? { purchased: 0, litres: 0, settled: 0, cashPaid: 0, tds: 0, outstanding: 0, advance: 0, balance: 0, purchases: 0, payments: 0 }
  const left = stock.vendorStock.get(id) ?? { litres: 0, value: 0 }
  // Everything bought on this vendor's account: bulk purchases (stock) and direct purchases on credit (straight into a vehicle).
  const purchases = d.payables.filter((p) => p.vendorId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  const payments = d.payments.filter((p) => p.vendorId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  const ledger = vendorLedger(d.payables, d.payments, id).reverse()
  const owing = purchases.some((p) => d.payOfPayable(p).outstanding > 0)
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), today, d.locks)
  const mayPay = canManageAdBluePayments(role, "create") && vendor.status === "ACTIVE"
  const mayEdit = canManageAdBluePayments(role, "edit")
  const mayDelete = canManageAdBluePayments(role, "delete")
  const bill = (purchaseId: string) => { const x = d.payableOf(purchaseId); return `${x ? `${PAYABLE_KIND_LABEL[x.kind]} · ` : ""}Bill ${x?.billNo || "—"}` }
  const regOf = (vehicleId: string) => regs.data?.find((v) => v.id === vehicleId)?.regNo ?? "Vehicle"

  // Stock movements of this vendor's batches (FIFO, the same run as every AdBlue figure): in = its purchases (and opening),
  // out = the litres vehicles drew from them, and stock that became unattributed at an old draw.
  const byEntry = new Map(draws.map((e) => [e.id, e]))
  const movements = [
    ...d.purchases.filter((p) => p.adblueVendorId === id).map((p) => ({ key: p.id, date: p.date, kind: "Bulk purchase", detail: `Bill ${p.invoiceNo || "—"}`, inL: p.totalLitres, outL: 0, value: p.totalCost })),
    ...stock.takes.filter((t) => t.vendor === id).map((t, n) => ({ key: `${t.consumptionId}:${n}`, date: t.date, kind: "Vehicle refill", detail: byEntry.get(t.consumptionId) ? regOf(byEntry.get(t.consumptionId)!.vehicleId) : "—", inL: 0, outL: t.litres, value: t.cost })),
    ...stock.moves.filter((m) => m.vendor === id).map((m, n) => ({ key: `mv:${m.consumptionId}:${n}`, date: m.date, kind: "Became unattributed", detail: "An old draw's vendor is unknown", inL: 0, outL: m.litres, value: m.value })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  const monthly = stockLedger(d.purchases, draws, id).reverse()

  return (
    <div className="space-y-5">
      <PageHeader
        backHref="/adblue"
        backLabel="AdBlue"
        title={vendor.name}
        description={`AdBlue vendor account${vendor.status === "ARCHIVED" ? " · archived (history only)" : ""}${vendor.contactPerson ? ` · ${vendor.contactPerson}` : ""}${vendor.phone ? ` · ${vendor.phone}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {mayEdit && acc.advance > 0 && owing && (
              <Button variant="outline" onClick={() => setPaying({ vendorAdvance: true })}>
                <WalletCards /> Apply Advance · {formatINR(acc.advance)}
              </Button>
            )}
            {mayPay && (
              <Button size="lg" onClick={() => setPaying({})}>
                <Plus /> Make Payment
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatsCard label="Total Purchased" icon={IndianRupee} value={formatINR(acc.purchased)} hint={`${acc.purchases} purchase${acc.purchases === 1 ? "" : "s"} · incl. GST`} info="Σ value of every bulk purchase from this vendor (taxable + GST), all history." prominent />
        <StatsCard label="Total Paid" icon={Landmark} value={formatINR(acc.settled)} hint={acc.tds ? `${formatINR(acc.cashPaid)} paid + ${formatINR(acc.tds)} TDS` : `${acc.payments} payment${acc.payments === 1 ? "" : "s"}`} info="Σ of what the payments settle: the amount paid plus any TDS deducted. This is what reduces the payable." />
        <StatsCard label="Outstanding Credit" icon={Wallet} value={formatINR(acc.outstanding)} hint={acc.outstanding ? "We owe the vendor" : "Nothing owed"} info="Σ over purchases of (value − paid)." />
        <StatsCard label="Available Advance Credit" icon={WalletCards} value={formatINR(acc.advance)} hint={acc.advance ? "Apply it to a purchase" : "No advance"} info="Σ of payments not yet allocated to any purchase. Shown apart from Outstanding — never netted." />
        <StatsCard label="Total Litres Purchased" icon={PackagePlus} value={L(acc.litres)} hint="All history" info="Σ litres of every bulk purchase from this vendor." />
        <StatsCard label="Remaining Stock" icon={Package} value={L(left.litres)} hint={`Worth ${formatINR(left.value)} at purchase cost`} info="Litres left in this vendor's batches after every vehicle refill (FIFO). Payments never change stock." />
      </div>
      <p className="text-xs text-muted-foreground">
        Net payable = Total Purchased − Total Paid = <span className={cn("num font-medium", acc.balance > 0 ? "text-rose-700 dark:text-rose-400" : acc.balance < 0 ? "text-sky-700 dark:text-sky-400" : "")}>{formatINR(Math.abs(acc.balance))} {acc.balance > 0 ? "payable" : acc.balance < 0 ? "advance" : "settled"}</span> (outstanding {formatINR(acc.outstanding)} − advance {formatINR(acc.advance)}).
      </p>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="purchases">Purchase History</TabsTrigger>
          <TabsTrigger value="stock">Stock History</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="ledger">Vendor Ledger</TabsTrigger>
        </TabsList>

        <TabsContent value="purchases" className="mt-0">
          <DataTable
            data={purchases}
            getRowId={(p) => p.id}
            onRowClick={setViewing}
            pageSize={20}
            showFooter
            cardsBelow="xl"
            emptyMessage="No bulk purchases from this vendor yet."
            mobileColumns={["bill", "value", "out", "status"]}
            columns={[
              { id: "date", header: "Purchase Date", sortValue: (p) => p.date, cell: (p) => <span className="num">{formatDate(p.date)}</span>, footer: `${purchases.length} purchase${purchases.length === 1 ? "" : "s"}` },
              { id: "type", header: "Type", sortValue: (p) => p.kind, cell: (p) => <PayableKindBadge kind={p.kind} /> },
              { id: "bill", header: "Invoice / Bill No.", cell: (p) => <span>{p.billNo || <span className="text-muted-foreground">—</span>}{p.vehicleId && <span className="block text-xs text-muted-foreground">{regOf(p.vehicleId)}</span>}</span> },
              { id: "qty", header: "Quantity", align: "right", sortValue: (p) => p.litres, cell: (p) => <span className="num">{L(p.litres)}</span>, footer: <span className="num">{L(acc.litres)}</span> },
              { id: "rate", header: "Rate / L", align: "right", cell: (p) => { const b = d.purchase(p.id); return <span className="num">{formatINR(b ? ratePerLitre(b) : p.litres ? round2(p.value / p.litres) : 0)}</span> } },
              { id: "taxable", header: "Taxable", align: "right", cell: (p) => <span className="num">{formatINR(d.purchase(p.id)?.totalCost ?? p.value)}</span> },
              { id: "gst", header: "GST", align: "right", cell: (p) => { const b = d.purchase(p.id); return b?.gstRate ? <span className="num">{formatINR(gstOf(b.totalCost, b.gstRate))} <span className="text-xs text-muted-foreground">({formatNumber(b.gstRate, 2)}%)</span></span> : <span className="text-muted-foreground">—</span> } },
              { id: "value", header: "Total Value", align: "right", sortValue: (p) => p.value, cell: (p) => <span className="num font-medium">{formatINR(p.value)}</span>, footer: <span className="num">{formatINR(acc.purchased)}</span> },
              { id: "paid", header: "Paid", align: "right", cell: (p) => <span className="num">{formatINR(d.payOfPayable(p).paid)}</span> },
              { id: "out", header: "Outstanding", align: "right", sortValue: (p) => d.payOfPayable(p).outstanding, cell: (p) => <span className={cn("num", d.payOfPayable(p).outstanding > 0 && "font-medium text-rose-700 dark:text-rose-400")}>{formatINR(d.payOfPayable(p).outstanding)}</span>, footer: <span className="num">{formatINR(acc.outstanding)}</span> },
              { id: "status", header: "Status", sortValue: (p) => d.payOfPayable(p).status, cell: (p) => <PurchaseStatusBadge status={d.payOfPayable(p).status} /> },
            ]}
          />
        </TabsContent>

        <TabsContent value="stock" className="mt-0 space-y-5">
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Stock from this vendor&apos;s batches, used oldest first (FIFO). <span className="font-medium text-foreground">A payment never changes stock</span> — litres move only with purchases and vehicle refills.
          </p>
          <DataTable
            data={movements}
            getRowId={(m) => m.key}
            cardsBelow="xl"
            pageSize={25}
            dense
            emptyMessage="No stock movements for this vendor yet."
            columns={[
              { id: "date", header: "Date", cell: (m) => <span className="num">{formatDate(m.date)}</span> },
              { id: "kind", header: "Movement", cell: (m) => <span className="font-medium">{m.kind}</span> },
              { id: "detail", header: "Bill / Vehicle", cell: (m) => <span className="text-muted-foreground">{m.detail}</span> },
              { id: "in", header: "In", align: "right", cell: (m) => (m.inL ? <span className="num text-emerald-700 dark:text-emerald-400">+{L(m.inL)}</span> : "—") },
              { id: "out", header: "Out", align: "right", cell: (m) => (m.outL ? <span className="num">−{L(m.outL)}</span> : "—") },
              { id: "value", header: "At cost", align: "right", cell: (m) => <span className="num">{formatINR(m.value)}</span> },
            ]}
          />
          <section>
            <h2 className="mb-2 text-sm font-semibold">Monthly stock · each closing carries forward</h2>
            <DataTable
              data={monthly}
              getRowId={(r) => r.month}
              dense
              pageSize={24}
              emptyMessage="No stock yet."
              columns={[
                { id: "m", header: "Month", cell: (r) => monthLabel(r.month) },
                { id: "open", header: "Opening", align: "right", cell: (r) => <span className="num">{L(r.opening + r.openingStock)}</span> },
                { id: "in", header: "Purchased", align: "right", cell: (r) => <span className="num">{L(r.purchased)}</span> },
                { id: "out", header: "Used", align: "right", cell: (r) => <span className="num">{L(r.consumed - r.unattributed)}</span> },
                { id: "close", header: "Closing", align: "right", cell: (r) => <span className="num font-semibold">{L(r.closing)}</span> },
              ]}
            />
          </section>
        </TabsContent>

        <TabsContent value="payments" className="mt-0">
          <DataTable
            data={payments}
            getRowId={(p) => p.id}
            cardsBelow="xl"
            pageSize={20}
            emptyMessage={mayPay ? "No payments yet — use Make Payment." : "No payments yet."}
            mobileColumns={["amount", "for", "status", "act"]}
            columns={[
              { id: "date", header: "Payment Date", cell: (p) => <span className="num">{formatDate(p.date)}</span> },
              {
                id: "ref",
                header: "Mode · Reference",
                cell: (p) => (
                  <div>
                    <div className="font-medium">{p.mode}</div>
                    <div className="num text-xs break-all" title={referenceLabel(p.mode)}>{p.utr}</div>
                  </div>
                ),
              },
              { id: "amount", header: "Total Settled", align: "right", cell: (p) => <SettledAmount payment={p} /> },
              { id: "paid", header: "Actual Paid", align: "right", cell: (p) => <span className="num">{formatINR(p.amount)}</span> },
              {
                id: "for",
                header: "Allocated To",
                cell: (p) => (
                  <div className="space-y-0.5 text-xs">
                    {p.allocations.map((a, n) => (
                      <div key={n}>
                        {bill(a.purchaseId)} <span className="num text-muted-foreground">{formatINR(a.amount)}</span>
                      </div>
                    ))}
                    {unallocated(p) > 0 && <div className="num text-sky-700 dark:text-sky-400">{formatINR(unallocated(p))} advance</div>}
                  </div>
                ),
              },
              { id: "status", header: "Status", cell: (p) => <AllocationBadge payment={p} /> },
              {
                id: "act",
                header: "",
                align: "right",
                cell: (p) => (
                  <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                    {mayEdit && unallocated(p) > 0 && owing && (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => setPaying({ payment: p })}>
                        Apply Advance
                      </Button>
                    )}
                    {mayEdit && open(p.date) && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit the payment of ${formatDate(p.date)}`} title="Edit payment" onClick={() => setPaying({ payment: p, edit: true })}>
                        <Pencil />
                      </Button>
                    )}
                    {mayDelete && open(p.date) && p.allocations.every((a) => open(d.payableOf(a.purchaseId)?.date ?? p.date)) && (
                      <Button variant="ghost" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete the payment of ${formatDate(p.date)}`} title="Delete payment" onClick={() => setDeleting(p)}>
                        <Trash2 />
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </TabsContent>

        <TabsContent value="ledger" className="mt-0 space-y-3">
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">How to read this ledger:</span> a purchase is a <span className="font-medium text-foreground">debit</span> (we owe {vendor.name} more); a payment is a{" "}
            <span className="font-medium text-foreground">credit</span> (we owe less) — its full settled amount, TDS included. Balance = Σ debits − Σ credits: <span className="text-rose-700 dark:text-rose-400">Payable</span> = we owe the vendor,{" "}
            <span className="text-sky-700 dark:text-sky-400">Advance</span> = the vendor holds our money. No opening balance is recorded — the ledger starts at the first purchase or payment.
          </p>
          <DataTable
            data={ledger}
            getRowId={(r) => r.id}
            cardsBelow="xl"
            pageSize={30}
            emptyMessage="Nothing bought from or paid to this vendor yet."
            mobileColumns={["type", "debit", "credit", "bal"]}
            columns={[
              { id: "date", header: "Date", cell: (r) => <span className="num">{formatDate(r.date)}</span> },
              { id: "type", header: "Type", cell: (r) => (r.kind === "PURCHASE" ? (r.purchaseKind === "DIRECT" ? "Direct purchase" : "Bulk purchase") : "Payment") },
              { id: "bill", header: "Bill / Invoice No.", cell: (r) => (r.kind === "PURCHASE" ? d.payableOf(r.id)?.billNo || "—" : [...new Set(d.payments.find((p) => p.id === r.id)?.allocations.map((a) => d.payableOf(a.purchaseId)?.billNo || "—") ?? [])].join(", ") || "—") },
              { id: "ref", header: "Payment Reference", cell: (r) => (r.kind === "PAYMENT" ? <span className="num text-xs break-all">{d.payments.find((p) => p.id === r.id)?.utr}</span> : "—") },
              {
                id: "desc",
                header: "Description",
                hideOnMobile: true,
                cell: (r) => {
                  if (r.kind === "PURCHASE") {
                    const p = d.purchase(r.id)
                    const x = d.payableOf(r.id)
                    return <span className="text-xs text-muted-foreground">{p ? `${L(p.totalLitres)} ${p.product || "AdBlue"} into stock${p.gstRate ? ` · incl. ${formatNumber(p.gstRate, 2)}% GST` : ""}` : x ? `${L(x.litres)} straight into ${x.vehicleId ? regOf(x.vehicleId) : "a vehicle"}` : ""}</span>
                  }
                  const p = d.payments.find((x) => x.id === r.id)
                  return <span className="text-xs text-muted-foreground">{p ? `${p.mode}${r.tds ? ` · ${formatINR(r.paid)} paid + ${formatINR(r.tds)} TDS` : ""}` : ""}</span>
                },
              },
              { id: "debit", header: "Debit (purchase)", align: "right", cell: (r) => (r.debit ? <span className="num">{formatINR(r.debit)}</span> : "—") },
              { id: "credit", header: "Credit (settled)", align: "right", cell: (r) => (r.credit ? <span className="num">{formatINR(r.credit)}</span> : "—") },
              {
                id: "bal",
                header: "Running Balance",
                align: "right",
                cell: (r) => (
                  <span className={cn("num font-medium", r.balance > 0 ? "text-rose-700 dark:text-rose-400" : r.balance < 0 ? "text-sky-700 dark:text-sky-400" : "")}>
                    {formatINR(Math.abs(r.balance))} <span className="text-xs font-normal">{r.balance > 0 ? "Payable" : r.balance < 0 ? "Advance" : "Settled"}</span>
                  </span>
                ),
              },
            ]}
          />
        </TabsContent>
      </Tabs>

      {paying && <AdBluePaymentDialog key={`${paying.payment?.id ?? "new"}:${!!paying.edit}:${!!paying.vendorAdvance}`} vendorId={id} payment={paying.payment} edit={paying.edit} vendorAdvance={paying.vendorAdvance} onClose={() => setPaying(null)} />}
      {deleting && (
        <DeleteAdBluePaymentDialog
          payment={deleting}
          vendor={vendor.name}
          bills={[...new Set(deleting.allocations.map((a) => bill(a.purchaseId)))]}
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: deleting.id, reason, version: deleting.updatedAt })
            toast.success("Payment deleted")
            setDeleting(null)
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {viewing && <PurchaseDetailsDialog payable={viewing} d={d} regOf={regOf} onClose={() => setViewing(null)} />}
    </div>
  )
}

/**
 * One purchase owed to a vendor, read only: a bulk purchase (quantities, taxable, GST) or a direct purchase on credit
 * (vehicle, litres × rate) — its value, paid, outstanding and every payment applied to it.
 */
export function PurchaseDetailsDialog({ purchase, payable, d, regOf, onClose }: { purchase?: AdBluePurchase; payable?: Payable; d: AdBlueFinance; regOf?: (vehicleId: string) => string; onClose: () => void }) {
  const x = payable ?? (purchase ? d.payableOf(purchase.id) : undefined)
  const p = purchase ?? (x?.kind === "BULK" ? d.purchase(x.id) : undefined)
  const id = (p?.id ?? x?.id)!
  const pay = x ? d.payOfPayable(x) : d.payOf(p!)
  const applied = d.payments.flatMap((y) => y.allocations.filter((a) => a.purchaseId === id).map((a) => ({ x: y, amount: a.amount }))).sort((a, b) => b.x.date.localeCompare(a.x.date))
  const rows: [string, React.ReactNode][] = p
    ? [
        ["Vendor", d.vendorName(p.adblueVendorId)],
        ["Purchase date", formatDate(p.date)],
        ["Invoice / bill", p.invoiceNo || "—"],
        ["Product", p.product || "—"],
        ["Quantity", `${formatNumber(p.buckets)} × ${formatNumber(p.litresPerBucket, 2)} L = ${L(p.totalLitres)}`],
        ["Rate per litre", formatINR(ratePerLitre(p))],
        ["Taxable amount", formatINR(p.totalCost)],
        ["GST", p.gstRate ? `${formatINR(gstOf(p.totalCost, p.gstRate))} (${formatNumber(p.gstRate, 2)}%)` : "None"],
        ["Total purchase value", <span key="v" className="font-semibold">{formatINR(pay.value)}</span>],
        ["Paid", formatINR(pay.paid)],
        ["Outstanding", formatINR(pay.outstanding)],
        ["Notes", p.notes || "—"],
      ]
    : [
        ["Vendor", d.vendorName(x!.vendorId)],
        ["Purchase date", formatDate(x!.date)],
        ["Invoice / bill", x!.billNo || "—"],
        ["Vehicle", x!.vehicleId ? (regOf?.(x!.vehicleId) ?? "—") : "—"],
        ["Quantity", L(x!.litres)],
        ["Rate per litre", formatINR(x!.litres ? round2(x!.value / x!.litres) : 0)],
        ["Total purchase value", <span key="v" className="font-semibold">{formatINR(pay.value)}</span>],
        ["Paid", formatINR(pay.paid)],
        ["Outstanding", formatINR(pay.outstanding)],
      ]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {p ? "Bulk purchase" : "Direct purchase"} · {formatINR(pay.value)} <PurchaseStatusBadge status={pay.status} />
          </DialogTitle>
          <DialogDescription>{p ? `Stock: +${L(p.totalLitres)} at ${formatINR(p.totalCost)} (taxable — what FIFO costs these litres at).` : "Bought straight into the vehicle on the vendor's credit — never bulk stock. Edit it from the vehicle's AdBlue tab."}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="num text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <HandCoins className="size-4" /> Payments applied
          </h3>
          {applied.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {applied.map(({ x, amount }, n) => (
                <li key={n} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span>
                    {formatDate(x.date)} · {x.mode} <span className="num text-xs text-muted-foreground">{x.utr}</span>
                    {x.tdsAmount > 0 && <span className="block text-xs text-muted-foreground">payment {formatINR(settledOf(x))} incl. {formatINR(x.tdsAmount)} TDS</span>}
                  </span>
                  <span className="num">{formatINR(amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing paid yet — on credit.</p>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <HistoryButton id={id} />
          <Button variant="outline" onClick={onClose}>
            <Droplets /> Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
