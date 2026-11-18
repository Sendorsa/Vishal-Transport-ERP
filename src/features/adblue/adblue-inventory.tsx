"use client"

import { useMemo, useState } from "react"
import { endOfMonth, format, parseISO } from "date-fns"
import Link from "next/link"
import { IndianRupee, Landmark, Package, PackageMinus, PackagePlus, Plus, Store, Sigma, Wallet, WalletCards } from "lucide-react"
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
import { inventoryLedger, isDirectAdBlue, purchasedIn, stockDraws, stockFor, totalsFor, valueInventory } from "@/domain/adblue-inventory"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { AdBlueVendorsSection } from "./adblue-vendors"
import { useAdBlueFinance, type AdBlueFinance } from "./adblue-data"
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
import { formatDate, formatINR, formatNumber, monthKey, todayISO, formatLitres } from "@/lib/format"
import type { AdBluePayment, AdBluePurchase, AdBlueVendor, Vehicle } from "@/lib/types"
import { MonthLockControl, useDieselIndex } from "../diesel/parts"
import { usePeriod } from "../diesel/period"

const L = formatLitres

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
      return sessionStorage.getItem("vt:ui:adblueTab") || "overview"
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
    return { totals: totals.data, ledger: totals.data.ledger, all: inEntryOrder(entries.data), history: inEntryOrder(purchases.data), vendorStock: valueInventory(purchases.data, stockDraws(entries.data)).vendorStock }
  }, [purchases.data, entries.data, totals.data])

  if (!can("adblue")) return <NoAccess what="AdBlue inventory" />
  if (!d || !f.ready) return <PageSkeleton />
  const allBought = purchasedIn(purchases.data ?? [], () => true)
  const m = stockFor(d.ledger, period.periodMonths)
  // Money spent buying AdBlue in the period — only batches dated in it, never carry-forward or stock value.
  const bought = purchasedIn(purchases.data ?? [], period.match)
  const p = period.label
  // A period that ended before this month shows stock and value at its month end, never today's.
  const lastMonth = period.periodMonths?.at(-1)
  const endedMonth = lastMonth && lastMonth < monthKey(todayISO()) ? lastMonth : null
  // Every card and the direct purchases table are company-wide, for every role (Tata Adblue too: owner, 12 Nov 2026).
  const { stock, directCost, directLitres, directCount } = totalsFor(d.totals, period.periodMonths, endedMonth)
  const entriesInPeriod = d.all.filter(period.match)
  const issued = { cost: m.consumedCost, litres: m.consumed }
  const regOf = (id: string) => idx?.vehicles.get(id)?.regNo ?? regs.data?.find((v) => v.id === id)?.regNo ?? "Unknown"
  const asOf = endedMonth ? `As of ${format(endOfMonth(parseISO(`${endedMonth}-01`)), "d MMM yyyy")}` : "As of today"
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
        <h2 className="mb-2 text-sm font-semibold">AdBlue at a glance · all time</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          <StatsCard label="Total AdBlue Purchased" icon={PackagePlus} value={L(allBought.litres)} hint={`${allBought.purchases} bulk purchase${allBought.purchases === 1 ? "" : "s"}`} info="Σ litres of every bulk purchase recorded (opening stock is not a purchase)." />
          <StatsCard label="Total AdBlue Available" icon={Package} value={L(d.totals.current.stockLitres)} hint={`As of today · worth ${formatINR(d.totals.current.stockValue)}`} info="Litres left after every vehicle refill (FIFO by vendor). Payments never change it." />
          {f.canPay && (
            <>
              <StatsCard label="Total Purchase Value" icon={IndianRupee} value={formatINR(f.totals.purchased)} hint="Bulk purchases incl. GST" info="Σ value owed for every bulk purchase: taxable + GST. Not Inventory Value (stock still on hand at cost)." prominent />
              <StatsCard label="Total Amount Paid" icon={Landmark} value={formatINR(f.totals.settled)} hint={f.totals.tds ? `${formatINR(f.totals.cashPaid)} paid + ${formatINR(f.totals.tds)} TDS` : "Payments to vendors"} info="Σ of what the payments to AdBlue vendors settle: the money paid plus any TDS deducted (counted once)." />
              <StatsCard label="Total Outstanding Credit" icon={Wallet} value={formatINR(f.totals.outstanding)} hint="Still owed to vendors" info="Σ over purchases of (value − paid). Advance with a vendor is never subtracted — it is shown on its own." />
              <StatsCard label="Total Advance Credit" icon={WalletCards} value={formatINR(f.totals.advance)} hint="Paid, not yet on a purchase" info="Σ of payments not allocated to any purchase — credit the vendors hold for later purchases." />
            </>
          )}
        </div>
      </section>

      <Tabs value={tab} onValueChange={pickTab} className="gap-4">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Inventory Overview</TabsTrigger>
          <TabsTrigger value="vendors">Vendor Accounts</TabsTrigger>
          <TabsTrigger value="purchases">Purchase History</TabsTrigger>
          {f.canPay && <TabsTrigger value="payments">Payments</TabsTrigger>}
          <TabsTrigger value="stock">Stock History</TabsTrigger>
        </TabsList>
        {tab !== "payments" && tab !== "purchases" && (
          <div className="flex flex-wrap items-center gap-3">
            {period.control}
            {month && <MonthLockControl month={month} />}
          </div>
        )}

        <TabsContent value="overview" className="mt-0 space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold">{endedMonth ? `Inventory at month end · ${p}` : "Current inventory"}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatsCard
                label={endedMonth ? "Closing Stock" : "Current Stock"}
                icon={Package}
                value={L(stock.stockLitres)}
                hint={asOf}
                info={endedMonth ? "Σ litres purchased − Σ litres drawn by vehicles, up to the period's month end." : "Σ litres purchased − Σ litres drawn by vehicles, all time."}
              />
              <StatsCard
                label="Inventory Value"
                icon={IndianRupee}
                value={formatINR(stock.stockValue)}
                hint={`${asOf}${stock.avgRate ? ` · Average ${formatINR(stock.avgRate)} / L` : " · No stock"}`}
                info="The stock still on hand, at the purchase rate of the batches it is left from (each vendor's batches are used oldest first). For a past period, the value at its month end."
              />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">AdBlue purchased · {p}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatsCard
                label="AdBlue Purchased"
                icon={IndianRupee}
                value={formatINR(bought.cost)}
                hint={`${p} · ${bought.purchases} purchase${bought.purchases === 1 ? "" : "s"}`}
                info="Σ Total Purchase Cost of AdBlue batches dated in the period. Stock carried forward and the value of stock already held are never included — that is Inventory Value."
              />
              <StatsCard label="AdBlue Litres Purchased" icon={PackagePlus} value={L(bought.litres)} hint={p} info="Σ Total Litres of AdBlue batches dated in the period — carry-forward stock excluded." />
              <StatsCard label="Average Purchase Rate" icon={IndianRupee} value={bought.avgRate ? `${formatINR(bought.avgRate)} / L` : "—"} hint={p} info="AdBlue Purchased ÷ AdBlue Litres Purchased, for batches in the period." />
              <StatsCard label="Vendors Bought From" icon={Package} value={bought.vendors} hint={p} info="Distinct vendors of the AdBlue batches dated in the period." />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Stock movement · {p}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatsCard
                label="Opening Stock"
                icon={Package}
                value={L(m.opening + m.openingStock)}
                hint={m.openingStock ? `Opening stock recorded · ${p}` : m.carriedFrom && m.opening ? `Carried forward from ${format(parseISO(`${m.carriedFrom}-01`), "MMMM yyyy")}` : p}
                info="Closing stock before the period (carried forward), plus any opening stock recorded in it. Never a purchase."
              />
              <StatsCard label="Purchased (in)" icon={PackagePlus} value={L(m.purchased)} hint={p} info="Litres of AdBlue batches dated in the period." />
              <StatsCard label="Consumed (out)" icon={PackageMinus} value={L(m.consumed)} hint={`${formatINR(m.consumedCost)} at purchase cost`} info="Σ litres of vehicle AdBlue entries dated in the period, each at the purchase rate of the vendor's batches it used (oldest first)." />
              <StatsCard label="Closing Stock" icon={Package} value={L(m.closing)} hint="Carries into the next period" info={`Opening ${L(m.opening + m.openingStock)} + Purchased ${L(m.purchased)} − Consumed ${L(m.consumed)} = ${L(m.closing)}.`} />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Direct vendor purchases & total AdBlue expense · {p}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatsCard label="Direct Vendor Purchases" icon={Store} value={formatINR(directCost)} hint={`${p} · ${directCount} purchase${directCount === 1 ? "" : "s"}`} info="Σ amount (litres × rate) of AdBlue bought from a vendor straight into a vehicle, dated in the period. Never part of bulk stock or bulk purchases." />
              <StatsCard label="Direct Litres" icon={PackagePlus} value={L(directLitres)} hint={p} info="Σ litres of direct vendor purchases dated in the period. Not in bulk stock." />
              <StatsCard label="Bulk Issued to Vehicles" icon={PackageMinus} value={formatINR(issued.cost)} hint={`${L(issued.litres)} at purchase cost`} info="Σ bulk-stock draws by vehicles dated in the period, each at the purchase rate of the vendor's batches it used (oldest first)." />
              <StatsCard
                label="Total AdBlue Expense"
                icon={Sigma}
                value={formatINR(issued.cost + directCost)}
                hint={`${L(issued.litres + directLitres)} used`}
                info="Bulk issued to vehicles (at purchase cost) + direct vendor purchases. Bulk purchases are stock, not expense, so they're not added again — nothing is counted twice."
              />
            </div>
          </section>
        </TabsContent>

        <TabsContent value="vendors" className="mt-0 space-y-5">
          {f.canPay && <VendorAccountsTable f={f} stockOf={(id) => d.vendorStock.get(id)?.litres ?? 0} />}
          <AdBlueVendorsSection
            vendors={vendors.data ?? []}
            purchases={purchases.data ?? []}
            entries={entries.data ?? []}
            months={period.periodMonths}
            endedMonth={endedMonth}
            periodLabel={p}
            regOf={regOf}
            mayManage={mayManageVendors}
          />
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
          <section>
            <h2 className="mb-2 text-sm font-semibold">AdBlue added to vehicles · {p}</h2>
            <DataTable
              data={entriesInPeriod}
              getRowId={(e) => e.id}
              dense
              pageSize={15}
              emptyMessage="No AdBlue added to vehicles in this period."
              columns={[
                { id: "d", header: "Date", cell: (e) => <span className="num">{formatDate(e.date)}</span> },
                { id: "v", header: "Vehicle", cell: (e) => <span className="font-medium">{regOf(e.vehicleId)}</span> },
                { id: "src", header: "Source", hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{isDirectAdBlue(e) ? "Direct purchase" : "Bulk stock"}</span> },
                { id: "vendor", header: "Source Vendor", cell: (e) => <span className={e.adblueVendorId || isDirectAdBlue(e) ? "" : "text-muted-foreground"}>{e.sourceVendor || "—"}</span> },
                { id: "l", header: "Litres", align: "right", cell: (e) => <span className="num">{L(e.quantityLitres)}</span> },
                { id: "r", header: "Rate / L", align: "right", cell: (e) => <span className="num">{e.costRate ? formatINR(e.costRate) : "—"}</span> },
                { id: "a", header: "Total", align: "right", cell: (e) => <span className="num font-medium">{formatINR(e.amount)}</span> },
                { id: "pm", header: "Paid", hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{e.paymentMode ?? "—"}</span> },
                { id: "notes", header: "Notes", hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{[e.invoiceNo, e.notes].filter(Boolean).join(" · ") || "—"}</span> },
              ]}
            />
            <p className="mt-1 text-xs text-muted-foreground">Bulk stock is costed at the purchase rate of the vendor&apos;s batches used (oldest first). Edit or delete an entry on the vehicle&apos;s AdBlue tab.</p>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Monthly AdBlue ledger · each closing carries forward</h2>
            <DataTable
              data={[...d.ledger].reverse()}
              getRowId={(r) => r.month}
              dense
              pageSize={24}
              emptyMessage="No AdBlue purchased or consumed yet."
              columns={[
                { id: "m", header: "Month", cell: (r) => <span className={period.periodMonths?.includes(r.month) ? "font-semibold" : ""}>{monthLabel(r.month)}</span> },
                {
                  id: "open",
                  header: "Opening Stock",
                  align: "right",
                  cell: (r) => {
                    const prev = d.ledger[d.ledger.indexOf(r) - 1]
                    return (
                      <div className="flex flex-col items-end">
                        <span className="num">{L(r.opening + r.openingStock)}</span>
                        {r.openingStock > 0 ? (
                          <span className="text-xs text-muted-foreground">Opening stock</span>
                        ) : (
                          prev && r.opening > 0 && <span className="text-xs text-muted-foreground">Carried forward from {format(parseISO(`${prev.month}-01`), "MMMM")}</span>
                        )}
                      </div>
                    )
                  },
                },
                { id: "in", header: "Purchased", align: "right", cell: (r) => <span className="num">{L(r.purchased)}</span> },
                { id: "out", header: "Consumed", align: "right", cell: (r) => <span className="num">{L(r.consumed)}</span> },
                { id: "close", header: "Closing Stock", align: "right", cell: (r) => <span className="num font-semibold">{L(r.closing)}</span> },
              ]}
            />
          </section>
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
 * AdBlue → Vendor Accounts (owner, 18 Nov 2026): every vendor with its whole history — purchased (incl. GST), paid
 * (settled), outstanding credit and advance credit (never netted), stock left in its batches and litres bought. Archived
 * vendors stay listed when they have history. A row opens the vendor's account.
 */
function VendorAccountsTable({ f, stockOf }: { f: AdBlueFinance; stockOf: (vendorId: string) => number }) {
  const rows = f.vendors
    .filter((v) => v.status === "ACTIVE" || f.accounts.some((a) => a.vendorId === v.id) || stockOf(v.id) > 0)
    .map((v) => ({ v, a: f.accounts.find((x) => x.vendorId === v.id) ?? { purchased: 0, settled: 0, outstanding: 0, advance: 0, litres: 0, tds: 0, cashPaid: 0 }, stock: stockOf(v.id) }))
    .sort((x, y) => y.a.outstanding - x.a.outstanding || x.v.name.localeCompare(y.v.name))
  const t = f.totals
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">AdBlue Vendor Accounts · all history</h2>
      <DataTable
        data={rows}
        getRowId={(r) => r.v.id}
        showFooter
        cardsBelow="xl"
        emptyMessage="No AdBlue vendors yet."
        mobileColumns={["purchased", "paid", "out", "adv"]}
        columns={[
          {
            id: "vendor",
            header: "Vendor",
            sortValue: (r) => r.v.name,
            cell: (r) => (
              <Link href={`/adblue/vendors/${r.v.id}`} className="font-medium underline-offset-2 hover:underline">
                {r.v.name}
                {r.v.status === "ARCHIVED" && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(archived)</span>}
              </Link>
            ),
            footer: "Total",
          },
          { id: "purchased", header: "Total Purchased", align: "right", sortValue: (r) => r.a.purchased, cell: (r) => <span className="num">{formatINR(r.a.purchased)}</span>, footer: <span className="num">{formatINR(t.purchased)}</span> },
          { id: "paid", header: "Total Paid", align: "right", sortValue: (r) => r.a.settled, cell: (r) => <span className="num">{formatINR(r.a.settled)}</span>, footer: <span className="num">{formatINR(t.settled)}</span> },
          { id: "out", header: "Outstanding Credit", align: "right", sortValue: (r) => r.a.outstanding, cell: (r) => <span className={r.a.outstanding > 0 ? "num font-medium text-rose-700 dark:text-rose-400" : "num"}>{formatINR(r.a.outstanding)}</span>, footer: <span className="num">{formatINR(t.outstanding)}</span> },
          { id: "adv", header: "Advance Credit", align: "right", sortValue: (r) => r.a.advance, cell: (r) => <span className={r.a.advance > 0 ? "num text-sky-700 dark:text-sky-400" : "num"}>{formatINR(r.a.advance)}</span>, footer: <span className="num">{formatINR(t.advance)}</span> },
          { id: "stock", header: "Available Stock", align: "right", sortValue: (r) => r.stock, cell: (r) => <span className="num">{L(r.stock)}</span> },
          { id: "litres", header: "Litres Purchased", align: "right", sortValue: (r) => r.a.litres, cell: (r) => <span className="num">{L(r.a.litres)}</span> },
        ]}
      />
      <p className="mt-1 text-xs text-muted-foreground">Outstanding and advance are shown separately for each vendor — never netted. Open a vendor to add a payment, apply advance or see its ledger.</p>
    </section>
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
