"use client"

import { useMemo, useState } from "react"
import { IndianRupee, Package, PackageMinus, PackagePlus, Plus, Store } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { DataTable } from "@/components/shared/data-table"
import { EditedBadge, ReasonField } from "@/components/shared/audit"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { FormModal } from "@/components/shared/form-modal"
import { Field, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { AdBlueOpeningDialog } from "@/features/go-live/opening-dialogs"
import { canChangeAdBluePurchases, hasOwnerAuthority } from "@/lib/permissions"
import { StatsCard } from "@/components/shared/stats-card"
import { bulkStockUse, inventoryLedger, isDirectAdBlue, type VendorStockUse, purchaseSummary, stockDraws, stockFor, totalsFor, valueInventory, type VendorPurchases } from "@/domain/adblue-inventory"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { useAdBlueFinance } from "./adblue-data"
import { AdBluePaymentsPanel } from "./adblue-payments"
import { TdsBreakdown } from "./adblue-payment-dialog"
import { PurchaseDetailsDialog, PurchaseStatusBadge } from "./adblue-vendor-account"
import { ADBLUE_PAYMENT_MODES, ADBLUE_TDS_PERCENT, gstOf, PURCHASE_PAYMENT_TYPE_LABEL, referenceLabel, tdsProblem, tdsSplit, type PurchasePaymentType } from "@/domain/adblue-payments"
import { SimpleSelect } from "@/components/shared/simple-select"
import { AddAdBlueDialog } from "../diesel/add-adblue-dialog"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { inEntryOrder } from "@/domain/payment-order"
import { useAdBlueEntries, useAdBluePurchases, useAdBlueTotals, useAdBlueVehicles, useAdBlueVendors, useCreateAdBlueVendorByName, useDeleteAdBluePurchase, useMonthLocks, useSaveAdBluePurchase } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, monthKey, todayISO, formatLitres, round2 } from "@/lib/format"
import type { AdBlueEntry, AdBluePayment, AdBluePurchase, AdBlueVendor, Vehicle } from "@/lib/types"
import { MonthLockControl, useDieselIndex } from "../diesel/parts"
import { usePeriod } from "../diesel/period"

const L = formatLitres
/** The AdBlue page's tabs (owner, 24 Nov 2026: Vendor Accounts removed — each vendor's page stays, linked from Payments). */
const TABS = ["overview", "purchases", "payments", "stock"]

/**
 * AdBlue Inventory — physical stock in litres: bulk purchases in, vehicle AdBlue entries out.
 * Separate from fuel stations (money owed to pumps). All figures are calculated from purchases
 * and vehicle entries (src/domain/adblue-inventory.ts).
 *
 * Direct vendor purchases (uncle's answer 25) are bought straight into a vehicle: they appear in their own
 * section, never as bulk purchases and never in stock; Total AdBlue Expense = bulk issued at cost + direct.
 */
export function AdBlueInventory() {
  const can = useCan()
  const [role] = useRole()
  const { ds, idx } = useDieselIndex()
  // Monthly / Quarterly / Yearly / All Time — the same filter as Fuel Stations.
  const period = usePeriod(idx)
  const month = period.mode === "month" ? period.periodMonths?.[0] : undefined
  const purchases = useAdBluePurchases()
  const entries = useAdBlueEntries()
  const totals = useAdBlueTotals() // company-wide figures, totals by month only (computed on the server for the shared database)
  const regs = useAdBlueVehicles() // every AdBlue vehicle's registration — also those outside Tata Adblue's Diesel vehicles
  const vendors = useAdBlueVendors()
  const locks = useMonthLocks()
  const del = useDeleteAdBluePurchase()
  const [editing, setEditing] = useState<{ purchase?: AdBluePurchase } | null>(null)
  const [deleting, setDeleting] = useState<AdBluePurchase | null>(null)
  const [direct, setDirect] = useState<{ vehicle?: Vehicle } | null>(null)
  const [openingOpen, setOpeningOpen] = useState(false)
  const [viewing, setViewing] = useState<AdBluePurchase | null>(null)
  const f = useAdBlueFinance() // supplier money: the Owner, Dev and Employee only (f.canPay)
  // The tab shown (this browser only, kept while moving between pages).
  const [tab, setTab] = useState(() => {
    try {
      const t = sessionStorage.getItem("vt:ui:adblueTab")
      return t && TABS.includes(t) ? t : "overview" // a tab remembered from before (e.g. the removed Vendor Accounts) opens Overview
    } catch {
      return "overview"
    }
  })
  const pickTab = (t: string) => {
    setTab(t)
    try {
      sessionStorage.setItem("vt:ui:adblueTab", t)
    } catch {
      // storage blocked: the tab just isn't remembered
    }
  }

  const d = useMemo(() => {
    if (!purchases.data || !entries.data || !totals.data) return null
    // Purchased − Consumed = Current Stock is asserted in npm run check:diesel — an internal check, never shown to users.
    return { totals: totals.data, all: inEntryOrder(entries.data), history: inEntryOrder(purchases.data) }
  }, [purchases.data, entries.data, totals.data])

  if (!can("adblue")) return <NoAccess what="AdBlue inventory" />
  if (!d || !f.ready) return <PageSkeleton />
  // The Overview: vendor-wise bulk and direct purchases dated in the period (purchase records only, never payments).
  const summary = purchaseSummary(purchases.data ?? [], d.all, period.match)
  // Used / remaining of the period's bulk lots, as of today — from the FIFO valuation's own lots.
  const bulkUse = bulkStockUse(purchases.data ?? [], stockDraws(d.all), period.match)
  // Used in the period (company-wide totals by month): bulk draws from the stock ledger (FIFO) + direct purchases, each entry once.
  const used = { bulk: stockFor(d.totals.ledger, period.periodMonths).consumed, direct: totalsFor(d.totals, period.periodMonths, null).directLitres }
  const p = period.label
  const entriesInPeriod = d.all.filter(period.match)
  const regOf = (id: string) => idx?.vehicles.get(id)?.regNo ?? regs.data?.find((v) => v.id === id)?.regNo ?? "Unknown"
  const open = (p: AdBluePurchase) => canEditMonth(role, p.date.slice(0, 7), todayISO(), locks.data ?? [])
  const mayEdit = canChangeAdBluePurchases(role, "edit")
  const mayDelete = canChangeAdBluePurchases(role, "delete")
  const mayManageVendors = can("adblue", "create") && hasOwnerAuthority(role) // the AdBlue profiles pick existing vendors only

  return (
    <div className="space-y-5">
      <PageHeader
        title="AdBlue Inventory"
        description="AdBlue bought in bulk, held as stock and drawn by vehicles. Separate from fuel stations — this tracks litres in stock, not money owed to pumps."
        actions={
          can("adblue", "create") && (
            <div className="flex flex-wrap gap-2">
              {/* Go-live opening (owner, 3 Nov 2026): Owner / Dev, once, before any other AdBlue record. */}
              {hasOwnerAuthority(role) && !(purchases.data ?? []).some((p) => p.opening) && (
                <Button variant="outline" onClick={() => setOpeningOpen(true)}>
                  <PackagePlus /> Record Opening Stock
                </Button>
              )}
              <Button variant="outline" onClick={() => setDirect({})}>
                <Store /> Direct Vendor Purchase
              </Button>
              <Button onClick={() => setEditing({})}>
                <Plus /> Add Bulk Purchase
              </Button>
            </div>
          )
        }
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold">Purchase summary · {p}</h2>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatsCard label="Total Quantity Purchased" icon={PackagePlus} value={L(summary.totals.overall.litres)} hint={`Bulk + Direct · ${p}`} info="Σ litres of bulk purchases and direct vendor purchases dated in the period. Opening stock, payments and advances are never purchases." />
          <StatsCard label="Total Purchase Value" icon={IndianRupee} value={formatINR(summary.totals.overall.value)} hint={`Bulk + Direct · ${p}`} info="Bulk: taxable + GST of each purchase. Direct: litres × the recorded rate. Payments, advances and outstanding balances never change it." />
          <StatsCard label="Total AdBlue Used" icon={PackageMinus} value={L(round2(used.bulk + used.direct))} hint={`${p} · Bulk ${L(used.bulk)} + Direct ${L(used.direct)}`} info="Litres vehicles received in the period: drawn from bulk stock (FIFO) plus bought directly from a vendor. A direct purchase is never a bulk draw, so each entry counts once." />
          <StatsCard label="Total Bulk Stock Remaining" icon={Package} value={L(d.totals.current.stockLitres)} hint="As of today · not filtered by period" info="Litres in bulk storage today: every vendor's stock plus opening / unattributed stock (FIFO valuation). Direct vendor purchases never enter bulk storage. The period filter doesn't change it." />
        </div>
      </section>

      <Tabs value={tab} onValueChange={pickTab} className="gap-4">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="purchases">Purchase History</TabsTrigger>
          {f.canPay && <TabsTrigger value="payments">Payments</TabsTrigger>}
          <TabsTrigger value="stock">Stock Usage</TabsTrigger>
        </TabsList>
        {tab !== "payments" && tab !== "purchases" && (
          <div className="flex flex-wrap items-center gap-3">
            {period.control}
            {month && <MonthLockControl month={month} />}
          </div>
        )}

        <TabsContent value="overview" className="mt-0 space-y-5">
          <VendorPurchasesTable
            title="Bulk purchases by vendor"
            rows={[
              ...summary.bulk.map((r) => ({ ...r, ...(bulkUse.byVendor.get(r.key) ?? { used: 0, remaining: 0, moved: 0 }) })),
              ...(bulkUse.unattributed.opening || bulkUse.unattributed.used || bulkUse.unattributed.remaining ? [{ key: UNATTRIBUTED, vendor: "Unattributed / Opening stock", purchases: 0, litres: 0, value: 0, used: bulkUse.unattributed.used, remaining: bulkUse.unattributed.remaining, moved: 0, opening: bulkUse.unattributed.opening }] : []),
            ]}
            total={summary.totals.bulk}
            empty="No bulk purchases in this period."
            note="Used and Remaining Stock: of the lots bought in this period, as of today (each vendor's oldest lot is used first). Opening stock and stock whose vendor is unknown are never a vendor's."
          />
          {/* A direct purchase is one record of litres delivered into a vehicle: all used, nothing enters bulk stock. */}
          <VendorPurchasesTable title="Direct purchases by vendor" rows={summary.direct.map((r) => ({ ...r, used: r.litres, remaining: 0, moved: 0 }))} total={summary.totals.direct} empty="No direct vendor purchases in this period." />
        </TabsContent>

        <TabsContent value="purchases" className="mt-0">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Purchase history</h2>
            <DataTable
              data={d.history}
              getRowId={(p) => p.id}
              onRowClick={f.canPay ? (p) => !p.opening && setViewing(p) : undefined}
              cardsBelow="xl"
              dense
              pageSize={25}
              emptyMessage="No AdBlue purchases yet — use Add Purchase."
              columns={[
                {
                  id: "date",
                  header: "Date",
                  cell: (p) => (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="num">{formatDate(p.date)}</span>
                      <EditedBadge id={p.id} />
                    </span>
                  ),
                },
                { id: "vendor", header: "Vendor", cell: (p) => <span className="font-medium">{p.opening ? "Opening stock (not a purchase)" : p.vendorName}</span> },
                ...(f.canPay ? [] : [{ id: "product", header: "Product", cell: (p: AdBluePurchase) => <span className="text-muted-foreground">{p.opening ? "—" : p.product || "—"}</span> }]), // the payers see it in the purchase's details
                { id: "buckets", header: "Buckets", align: "right", cell: (p) => (p.opening ? "—" : `${formatNumber(p.buckets)} × ${formatNumber(p.litresPerBucket, 2)} L`) },
                { id: "litres", header: "Litres", align: "right", cell: (p) => <span className="num">{L(p.totalLitres)}</span> },
                { id: "rate", header: "Rate", align: "right", cell: (p) => (p.opening ? "—" : <span className="num flex flex-col items-end"><span>{formatINR(p.pricePerBucket)} / bucket</span>{p.totalLitres > 0 && <span className="text-xs text-muted-foreground">{formatINR(p.totalCost / p.totalLitres)} / L</span>}</span>) },
                { id: "amt", header: "Taxable", align: "right", cell: (p) => <span className="num font-medium">{formatINR(p.totalCost)}</span> },
                ...(f.canPay
                  ? [
                      { id: "gst", header: "GST", align: "right" as const, cell: (p: AdBluePurchase) => (p.gstRate ? <span className="num">{formatINR(gstOf(p.totalCost, p.gstRate))}</span> : "—") },
                      { id: "value", header: "Purchase Value", align: "right" as const, cell: (p: AdBluePurchase) => (p.opening ? "—" : <span className="num font-medium">{formatINR(f.payOf(p).value)}</span>) },
                      { id: "out", header: "Outstanding", align: "right" as const, cell: (p: AdBluePurchase) => (p.opening ? "—" : <span className="num">{formatINR(f.payOf(p).outstanding)}</span>) },
                      { id: "status", header: "Payment", cell: (p: AdBluePurchase) => (p.opening ? <span className="text-xs text-muted-foreground">Not a purchase</span> : <PurchaseStatusBadge status={f.payOf(p).status} />) },
                    ]
                  : []),
                { id: "inv", header: "Voucher / Invoice", cell: (p) => <span className="text-muted-foreground">{p.invoiceNo || "—"}</span> },
                ...(f.canPay ? [] : [{ id: "notes", header: "Notes", cell: (p: AdBluePurchase) => <span className="text-xs text-muted-foreground">{p.notes || "—"}</span> }]),
                {
                  id: "act",
                  header: "",
                  align: "right",
                  cell: (p) => (
                    <RowActions
                      lockedReason={(mayEdit || mayDelete) && !open(p) ? monthLockedReason(monthLabel(p.date.slice(0, 7))) : null}
                      onEdit={mayEdit && !p.opening ? () => setEditing({ purchase: p }) : undefined}
                      onDelete={mayDelete ? () => setDeleting(p) : undefined}
                    />
                  ),
                },
              ]}
            />
          </section>
        </TabsContent>

        {f.canPay && (
          <TabsContent value="payments" className="mt-0">
            <AdBluePaymentsPanel />
          </TabsContent>
        )}

        <TabsContent value="stock" className="mt-0 space-y-5">
          <UsageTable
            title="Bulk Stock Usage"
            description="AdBlue issued from bulk inventory to vehicles."
            vendorHeader="Source Vendor"
            rows={entriesInPeriod.filter((e) => !isDirectAdBlue(e))}
            regOf={regOf}
            empty="No AdBlue issued from bulk stock in this period."
            note="Cost = the purchase rate of the source vendor's batches used, oldest first; a draw across two batches shows their combined rate per litre."
          />
          <UsageTable
            title="Direct Vendor Usage"
            description="AdBlue purchased directly from a vendor for a vehicle, without entering bulk storage."
            vendorHeader="Vendor"
            rows={entriesInPeriod.filter(isDirectAdBlue)}
            regOf={regOf}
            empty="No direct vendor purchases for vehicles in this period."
            note="Cost = litres × the recorded rate. Edit or delete any entry on the vehicle's AdBlue tab."
          />
        </TabsContent>
      </Tabs>

      {openingOpen && <AdBlueOpeningDialog onOpenChange={setOpeningOpen} />}
      {viewing && <PurchaseDetailsDialog purchase={(purchases.data ?? []).find((x) => x.id === viewing.id) ?? viewing} d={f} onClose={() => setViewing(null)} />}
      {direct && !direct.vehicle && (
        <FormModal open onOpenChange={(o) => !o && setDirect(null)} title="Direct Vendor Purchase" description="AdBlue bought from a vendor straight into one vehicle — bulk stock is not changed." submitLabel="Next" onSubmit={() => undefined}>
          <Field label="Vehicle" required>
            <SimpleSelect
              value=""
              onChange={(id) => setDirect({ vehicle: ds?.vehicles.find((v) => v.id === id) })}
              placeholder="Select vehicle"
              options={(ds?.vehicles ?? []).filter((v) => v.status !== "ARCHIVED").sort((a, b) => a.regNo.localeCompare(b.regNo)).map((v) => ({ value: v.id, label: v.regNo }))}
            />
          </Field>
        </FormModal>
      )}
      {direct?.vehicle && <AddAdBlueDialog open onOpenChange={(o) => !o && setDirect(null)} vehicle={direct.vehicle} customer={null} month={monthKey(todayISO())} initialSource="DIRECT" />}
      {editing && <PurchaseDialog key={editing.purchase?.id ?? "new"} purchase={editing.purchase} vendors={vendors.data ?? []} mayAddVendor={mayManageVendors} mayPay={f.canPay} paidSoFar={editing.purchase ? f.payOf(editing.purchase).paid : 0} applied={editing.purchase ? f.payments.flatMap((x) => x.allocations.filter((a) => a.purchaseId === editing.purchase!.id).map((a) => ({ payment: x, amount: a.amount }))).sort((a, b) => a.payment.date.localeCompare(b.payment.date)) : []} onOpenChange={(o) => !o && setEditing(null)} />}
      {deleting && (
        <DeleteDialog
          title="Delete this AdBlue purchase?"
          record={`${deleting.vendorName} · ${formatDate(deleting.date)} · ${L(deleting.totalLitres)} · ${formatINR(deleting.totalCost)}`}
          impact={`Stock goes down by ${L(deleting.totalLitres)}; AdBlue Purchased, the stock ledger, carry-forward, Inventory Value and the cost of later draws are recalculated. Refused if that AdBlue has already been used.`}
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })
            toast.success("AdBlue purchase deleted")
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/**
 * Add / edit a bulk AdBlue purchase. Totals are Buckets × per-bucket values. The vendor comes from the vendor master;
 * its default rate per litre pre-fills Price per Bucket (rate × litres per bucket), which stays editable — the rate
 * actually paid is saved on this purchase and costs every litre of it (FIFO).
 */
function PurchaseDialog({ purchase, vendors, mayAddVendor, mayPay, paidSoFar, applied = [], onOpenChange }: { purchase?: AdBluePurchase; vendors: AdBlueVendor[]; mayAddVendor: boolean; mayPay: boolean; paidSoFar: number; applied?: { payment: AdBluePayment; amount: number }[]; onOpenChange: (o: boolean) => void }) {
  const save = useSaveAdBluePurchase()
  const createVendor = useCreateAdBlueVendorByName()
  const today = todayISO()
  const [f, setF] = useState({
    date: purchase?.date ?? today,
    vendorId: purchase?.adblueVendorId ?? "",
    product: purchase?.product ?? "AdBlue",
    buckets: purchase ? String(purchase.buckets) : "",
    litresPerBucket: purchase ? String(purchase.litresPerBucket) : "20",
    pricePerBucket: purchase ? String(purchase.pricePerBucket) : "",
    gstRate: purchase ? String(purchase.gstRate ?? 0) : "0",
    invoiceNo: purchase?.invoiceNo ?? "",
    notes: purchase?.notes ?? "",
  })
  // Purchase Payment Details (a new purchase only; the Owner, Dev and Employee): Credit = nothing paid, no payment.
  const [pay, setPay] = useState({ type: "CREDIT" as PurchasePaymentType, amount: "", mode: "", utr: "", date: today, notes: "", tdsOn: false, tdsPercent: String(ADBLUE_TDS_PERCENT), acceptAdvance: false })
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  // Active vendors (the purchase's own vendor kept even if archived since).
  const options = vendors.filter((v) => v.status === "ACTIVE" || v.id === purchase?.adblueVendorId).sort((a, b) => a.name.localeCompare(b.name)).map((v) => ({ value: v.id, label: v.defaultRate ? `${v.name} · ${formatINR(v.defaultRate)} / L` : v.name }))
  const defaultPrice = (vendorId: string, perBucket: string) => {
    const rate = vendors.find((v) => v.id === vendorId)?.defaultRate
    return rate && Number(perBucket) > 0 ? String(Number((rate * Number(perBucket)).toFixed(2))) : ""
  }
  // Picking a vendor (or changing litres per bucket) fills Price per Bucket from its default rate until a price is typed.
  const [priceTyped, setPriceTyped] = useState(!!purchase)
  const pickVendor = (vendorId: string) => setF((s) => ({ ...s, vendorId, pricePerBucket: priceTyped ? s.pricePerBucket : defaultPrice(vendorId, s.litresPerBucket) }))
  const buckets = Number(f.buckets)
  const perBucket = Number(f.litresPerBucket)
  const price = Number(f.pricePerBucket)
  const gstRate = f.gstRate.trim() === "" ? 0 : Number(f.gstRate)
  const totalLitres = buckets * perBucket
  const taxable = Math.round(buckets * price * 100) / 100
  const gst = gstOf(taxable, gstRate)
  const value = Math.round((taxable + gst) * 100) / 100
  // What a new payment may settle: the whole value of a new purchase; on an edit, what is still owed after the
  // payments already recorded (they are never changed here — Payments → Edit / Delete corrects them).
  const owed = Math.max(0, Math.round((value - paidSoFar) * 100) / 100)
  const paying = mayPay && pay.type !== "CREDIT" && owed > 0
  const payAmount = pay.type === "FULL" && pay.amount === "" ? owed : Number(pay.amount || 0)
  const extra = pay.type === "FULL" ? Math.max(0, Math.round((payAmount - owed) * 100) / 100) : 0
  const percent = pay.tdsPercent.trim() === "" ? NaN : Number(pay.tdsPercent)
  const tdsErr = paying && pay.tdsOn ? tdsProblem(payAmount, percent) : null
  const split = paying && pay.tdsOn && payAmount > 0 && !tdsErr ? tdsSplit(payAmount, percent) : null

  const submit = async () => {
    setError(null)
    if (!f.vendorId) return setError("Choose the vendor")
    if (!(buckets > 0) || !(perBucket > 0)) return setError("Enter the number of buckets and litres per bucket")
    if (!(price >= 0) || f.pricePerBucket === "") return setError("Enter the price per bucket")
    if (!(gstRate >= 0 && gstRate <= 100)) return setError("GST %: between 0 and 100")
    if (purchase && value < paidSoFar) return setError(`${formatINR(paidSoFar)} has already been paid against this purchase — its value can't go below that.`)
    if (paying) {
      if (pay.type === "PARTIAL" && !(payAmount > 0 && payAmount < owed)) return setError(`Partially Paid: enter an amount more than ₹0 and less than ${formatINR(owed)}`)
      if (pay.type === "FULL" && payAmount < owed) return setError(`Fully Paid settles ${formatINR(owed)} — enter that amount, or choose Partially Paid`)
      if (extra > 0 && !pay.acceptAdvance) return setError(`${formatINR(extra)} is more than this purchase owes — tick "keep as advance credit", or correct the amount`)
      if (!pay.date) return setError("Enter the payment date")
      if (!pay.mode) return setError("Choose the payment mode")
      if (!pay.utr.trim()) return setError(`Enter the ${referenceLabel(pay.mode).toLowerCase()}`)
      if (tdsErr) return setError(tdsErr)
    }
    await save.mutateAsync({
      id: purchase?.id, version: purchase?.updatedAt,
      data: {
        date: f.date, adblueVendorId: f.vendorId, product: f.product, buckets, litresPerBucket: perBucket, pricePerBucket: price, gstRate, invoiceNo: f.invoiceNo.trim(), notes: f.notes.trim(),
        ...(paying ? { payment: { type: pay.type, amount: payAmount, mode: pay.mode, utr: pay.utr.trim(), date: pay.date, tdsPercent: pay.tdsOn ? percent : null, notes: pay.notes.trim(), acceptAdvance: extra > 0 && pay.acceptAdvance } } : {}),
      },
      reason,
    })
    toast.success(purchase ? (paying ? "Payment recorded for this purchase" : "Purchase updated") : `Purchase saved — +${L(totalLitres)} to inventory`, { description: paying ? `${formatINR(payAmount)} paid now · ${formatINR(Math.max(0, owed - payAmount))} outstanding${extra ? ` · ${formatINR(extra)} advance credit` : ""}` : purchase ? undefined : `On credit · ${formatINR(value)} outstanding` })
    onOpenChange(false)
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={purchase ? "Edit AdBlue purchase" : "Add bulk AdBlue purchase"}
      description="Bulk AdBlue into inventory — stock goes up by the total litres, whatever is paid now."
      submitLabel={purchase ? "Save changes" : "Save purchase"}
      pending={save.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Purchase date" required>
          <Input type="date" value={f.date} max={today} onChange={set("date")} />
        </Field>
        <Field label="Vendor" required error={error ?? undefined}>
          <CreatableSelect
            value={f.vendorId}
            options={options}
            onChange={pickVendor}
            onCreate={mayAddVendor ? async (name) => createVendor(name) : undefined}
            createLabel={(q) => `Add vendor "${q}"`}
            placeholder="Select vendor"
            invalid={!!error && !f.vendorId}
          />
        </Field>
        <Field label="Invoice / bill number">
          <Input value={f.invoiceNo} onChange={set("invoiceNo")} />
        </Field>
        <Field label="Product / grade / quality">
          <Input value={f.product} onChange={set("product")} placeholder="e.g. AdBlue ISO 22241" />
        </Field>
        <Field label="Number of buckets" required>
          <Input type="number" min={0} step="1" value={f.buckets} onChange={set("buckets")} />
        </Field>
        <Field label="Litres per bucket" required>
          <Input type="number" min={0} step="0.01" value={f.litresPerBucket} onChange={(e) => { const v = e.target.value; setF((s) => ({ ...s, litresPerBucket: v, pricePerBucket: priceTyped ? s.pricePerBucket : defaultPrice(s.vendorId, v) })) }} />
        </Field>
        <Field label="Price per bucket (₹, before GST)" required hint={price > 0 && perBucket > 0 ? `Rate ${formatINR(price / perBucket)} / L${(() => { const d = vendors.find((v) => v.id === f.vendorId)?.defaultRate; return d && Math.abs(d - price / perBucket) > 0.005 ? ` · vendor default ${formatINR(d)} / L` : "" })()}` : "Filled from the vendor's default rate — change it to the price actually paid"}>
          <Input type="number" min={0} step="0.01" value={f.pricePerBucket} onChange={(e) => { setPriceTyped(true); set("pricePerBucket")(e) }} />
        </Field>
        <Field label="GST (%)" hint="0 when the bill has no GST. Owed to the vendor; stock is costed before GST.">
          <Input type="number" min={0} max={100} step="0.01" value={f.gstRate} onChange={set("gstRate")} className="num" />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={1} value={f.notes} onChange={set("notes")} />
        </Field>
        {purchase && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">Total Litres</div>
          <div className="num font-semibold">{totalLitres > 0 ? L(totalLitres) : "—"}</div>
          {totalLitres > 0 && <div className="num text-[11px] text-muted-foreground">{formatNumber(buckets)} × {formatNumber(perBucket, 2)} L</div>}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Taxable Amount</div>
          <div className="num font-semibold">{f.pricePerBucket !== "" && buckets > 0 ? formatINR(taxable) : "—"}</div>
          {totalLitres > 0 && price > 0 && <div className="num text-[11px] text-muted-foreground">{formatINR(taxable / totalLitres)} / L</div>}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">GST</div>
          <div className="num font-semibold">{gst ? formatINR(gst) : "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Total Purchase Value</div>
          <div className="num font-semibold">{f.pricePerBucket !== "" && buckets > 0 ? formatINR(value) : "—"}</div>
        </div>
      </div>

      {mayPay && (
        <section className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Purchase Payment Details</h3>
            {purchase && <PurchaseStatusBadge status={owed === 0 ? "PAID" : paidSoFar > 0 ? "PARTIAL" : "UNPAID"} />}
          </div>
          {purchase && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Payments already recorded</div>
              {applied.length ? (
                <ul className="divide-y rounded-md border text-sm">
                  {applied.map(({ payment: x, amount }) => (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-1.5">
                      <span>
                        {formatDate(x.date)} · {x.mode} <span className="num text-xs break-all text-muted-foreground">{x.utr}</span>
                        {x.tdsAmount > 0 && <span className="block text-xs text-muted-foreground">incl. {formatINR(x.tdsAmount)} TDS on the payment</span>}
                      </span>
                      <span className="num font-medium">{formatINR(amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None — on credit so far.</p>
              )}
              <p className="text-xs text-muted-foreground">These stay as they are. To correct or remove one, use AdBlue → Payments (Edit / Delete).</p>
            </div>
          )}
          {owed === 0 && purchase ? (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">Fully paid — nothing is outstanding on this purchase.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={purchase ? "Pay now" : "Payment Type"} required hint={pay.type === "CREDIT" ? (purchase ? "Credit — no new payment; the outstanding stays owed" : "Nothing paid now — the whole value is owed to the vendor") : undefined}>
                <SimpleSelect value={pay.type} onChange={(v) => setPay((s) => ({ ...s, type: v as PurchasePaymentType, amount: "", acceptAdvance: false, tdsOn: v === "CREDIT" ? false : s.tdsOn }))} options={(Object.keys(PURCHASE_PAYMENT_TYPE_LABEL) as PurchasePaymentType[]).map((t) => ({ value: t, label: PURCHASE_PAYMENT_TYPE_LABEL[t] }))} />
              </Field>
              {pay.type !== "CREDIT" && (
                <>
                  <Field label="Amount Paid (₹)" required hint={pay.type === "FULL" ? `Settles the ${purchase ? "outstanding" : "purchase value"} ${formatINR(owed)} (with TDS: before TDS)` : `Less than ${formatINR(owed)}`}>
                    <Input type="number" min={0} step="0.01" value={pay.type === "FULL" && pay.amount === "" ? (owed > 0 ? String(owed) : "") : pay.amount} onChange={(e) => setPay((s) => ({ ...s, amount: e.target.value }))} className="num" />
                  </Field>
                  <Field label="Payment Mode" required>
                    <SimpleSelect value={pay.mode} onChange={(v) => setPay((s) => ({ ...s, mode: v }))} options={ADBLUE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Choose…" />
                  </Field>
                  <Field label={pay.mode ? referenceLabel(pay.mode) : "UTR / transaction reference"} required>
                    <Input value={pay.utr} onChange={(e) => setPay((s) => ({ ...s, utr: e.target.value }))} autoComplete="off" />
                  </Field>
                  <Field label="Payment Date" required>
                    <Input type="date" value={pay.date} min={f.date} max={today} onChange={(e) => setPay((s) => ({ ...s, date: e.target.value }))} />
                  </Field>
                  <Field label="Payment notes">
                    <Input value={pay.notes} onChange={(e) => setPay((s) => ({ ...s, notes: e.target.value }))} />
                  </Field>
                  <div className="rounded-lg border p-3 sm:col-span-2">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">Deduct TDS?</span>
                      <Switch checked={pay.tdsOn} onCheckedChange={(on) => setPay((s) => ({ ...s, tdsOn: on }))} aria-label="Deduct TDS" />
                    </label>
                    {pay.tdsOn && <TdsBreakdown percent={pay.tdsPercent} onPercent={(v) => setPay((s) => ({ ...s, tdsPercent: v }))} split={split} error={tdsErr ?? undefined} payee={vendors.find((v) => v.id === f.vendorId)?.name ?? "the vendor"} />}
                  </div>
                  {extra > 0 && (
                    <label className="flex items-start gap-2 rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm sm:col-span-2 dark:border-sky-800 dark:bg-sky-950/40">
                      <Checkbox checked={pay.acceptAdvance} onCheckedChange={(c) => setPay((s) => ({ ...s, acceptAdvance: c === true }))} className="mt-0.5" />
                      <span>
                        Keep the extra <span className="num font-medium">{formatINR(extra)}</span> as advance credit with the vendor
                        <span className="block text-xs text-muted-foreground">Not on any purchase yet — apply it later from the vendor&apos;s account.</span>
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
            <span>
              {purchase ? "Paid so far" : "Paid now"} <span className="num font-medium">{formatINR(purchase ? paidSoFar : paying ? payAmount : 0)}</span>
              {purchase && paying ? <span className="text-muted-foreground"> + now <span className="num font-medium text-foreground">{formatINR(Math.min(payAmount, owed))}</span></span> : null}
            </span>
            <span>
              Outstanding after saving <span className="num font-semibold">{formatINR(Math.max(0, owed - (paying ? payAmount : 0)))}</span>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Paying never changes the purchase or its stock — it only records a payment against it.</p>
        </section>
      )}
    </FormModal>
  )
}

/** Dashboard: AdBlue stock at a glance (same calculations as the AdBlue Inventory page). */
export function AdBlueDashboardCards() {
  const purchases = useAdBluePurchases()
  const entries = useAdBlueEntries()
  const d = useMemo(() => {
    if (!purchases.data || !entries.data) return null
    const month = monthKey(todayISO())
    const draws = stockDraws(entries.data) // direct vendor purchases never touch bulk stock
    return { v: valueInventory(purchases.data, draws), m: stockFor(inventoryLedger(purchases.data, draws, month), [month]) }
  }, [purchases.data, entries.data])
  if (!d) return null
  return (
    <>
      <StatsCard label="Current AdBlue Stock" icon={Package} value={L(d.v.stockLitres)} hint="As of today" href="/adblue" />
      <StatsCard label="AdBlue Inventory Value" icon={IndianRupee} value={formatINR(d.v.stockValue)} hint={d.v.avgRate ? `Avg ${formatINR(d.v.avgRate)} / L` : "No stock"} href="/adblue" />
      <StatsCard label="AdBlue This Month" icon={PackageMinus} value={L(d.m.consumed)} hint={`Consumed · ${formatINR(d.m.consumedCost)}`} href="/adblue" />
    </>
  )
}

const UNATTRIBUTED = "unattributed"
type VendorRow = VendorPurchases & VendorStockUse & { opening?: number }

/**
 * One purchase type, vendor-wise (highest value first), with a Total row: litres purchased, used, remaining and value.
 * Bulk: an "Unattributed / Opening stock" row (never a purchase: no count, litres or value of its own) holds opening stock
 * and stock whose vendor is unknown, so vendors + unattributed = the stock of the period's lots.
 */
function VendorPurchasesTable({ title, rows, total, empty, note }: { title: string; rows: VendorRow[]; total: { litres: number; value: number }; empty: string; note?: string }) {
  const sum = (f: (r: VendorRow) => number) => round2(rows.reduce((t, r) => t + f(r), 0))
  const dash = <span className="text-muted-foreground">—</span>
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <DataTable
        data={rows}
        getRowId={(r) => r.key}
        dense
        showFooter
        initialSort={{ id: "v", desc: true }}
        emptyMessage={empty}
        columns={[
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (r) => r.vendor,
            cell: (r) => (
              <span>
                <span className={r.key === UNATTRIBUTED ? "font-medium text-muted-foreground" : "font-medium"}>{r.vendor}</span>
                {r.key === UNATTRIBUTED && <span className="block text-xs text-muted-foreground">Not a purchase · no vendor recorded</span>}
                {r.moved > 0 && <span className="block text-xs text-muted-foreground">{L(r.moved)} became unattributed (an old draw&apos;s vendor is unknown)</span>}
              </span>
            ),
            footer: "Total",
          },
          { id: "n", header: "Purchases", align: "right", sortValue: (r) => r.purchases, cell: (r) => (r.key === UNATTRIBUTED ? dash : <span className="num">{formatNumber(r.purchases)}</span>), footer: formatNumber(rows.reduce((t, r) => t + r.purchases, 0)) },
          { id: "l", header: "Litres Purchased", align: "right", sortValue: (r) => r.litres, cell: (r) => (r.key === UNATTRIBUTED ? (r.opening ? <span className="num text-muted-foreground">Opening {L(r.opening)}</span> : dash) : <span className="num">{L(r.litres)}</span>), footer: L(total.litres) },
          { id: "u", header: "Used", align: "right", sortValue: (r) => r.used, cell: (r) => <span className="num">{L(r.used)}</span>, footer: L(sum((r) => r.used)) },
          { id: "r", header: "Remaining Stock", align: "right", sortValue: (r) => r.remaining, cell: (r) => <span className="num">{L(r.remaining)}</span>, footer: L(sum((r) => r.remaining)) },
          { id: "v", header: "Purchase Value", align: "right", sortValue: (r) => r.value, cell: (r) => (r.key === UNATTRIBUTED ? dash : <span className="num font-medium">{formatINR(r.value)}</span>), footer: formatINR(total.value) },
        ]}
      />
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </section>
  )
}

/**
 * Stock Usage (owner, 24 Nov 2026): one row per vehicle AdBlue entry, as the API values it — bulk draws at their FIFO
 * cost (`amount`, `sourceVendor`, `costRate` = cost ÷ litres), direct purchases at litres × their recorded rate. Newest
 * first; the Total row is the sum of the rows shown.
 */
function UsageTable({ title, description, vendorHeader, rows, regOf, empty, note }: { title: string; description: string; vendorHeader: string; rows: AdBlueEntry[]; regOf: (vehicleId: string) => string; empty: string; note: string }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mb-2 text-xs text-muted-foreground">{description}</p>
      <DataTable
        data={rows}
        getRowId={(e) => e.id}
        dense
        showFooter
        pageSize={25}
        initialSort={{ id: "d", desc: true }}
        emptyMessage={empty}
        columns={[
          { id: "d", header: "Date", sortValue: (e) => e.date, cell: (e) => <span className="num">{formatDate(e.date)}</span>, footer: "Total" },
          { id: "v", header: "Vehicle", sortValue: (e) => regOf(e.vehicleId), cell: (e) => <span className="font-medium">{regOf(e.vehicleId)}</span> },
          { id: "vendor", header: vendorHeader, sortValue: (e) => e.sourceVendor ?? "", cell: (e) => <span className={e.adblueVendorId || isDirectAdBlue(e) ? "" : "text-muted-foreground"}>{e.sourceVendor || "—"}</span> },
          { id: "l", header: "Litres", align: "right", sortValue: (e) => e.quantityLitres, cell: (e) => <span className="num">{L(e.quantityLitres)}</span>, footer: L(round2(rows.reduce((t, e) => t + e.quantityLitres, 0))) },
          { id: "r", header: "Rate / L", align: "right", sortValue: (e) => e.costRate ?? 0, cell: (e) => <span className="num">{e.costRate ? formatINR(e.costRate) : "—"}</span> },
          { id: "a", header: "Total Cost", align: "right", sortValue: (e) => e.amount, cell: (e) => <span className="num font-medium">{formatINR(e.amount)}</span>, footer: formatINR(round2(rows.reduce((t, e) => t + e.amount, 0))) },
        ]}
      />
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </section>
  )
}
