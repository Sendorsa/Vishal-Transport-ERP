"use client"

import { useMemo, useState } from "react"
import { endOfMonth, format, parseISO } from "date-fns"
import { IndianRupee, Package, PackageMinus, PackagePlus, Plus, Store, Sigma } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { SimpleSelect } from "@/components/shared/simple-select"
import { AddAdBlueDialog } from "../diesel/add-adblue-dialog"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { inEntryOrder } from "@/domain/payment-order"
import { useAdBlueEntries, useAdBluePurchases, useAdBlueTotals, useAdBlueVehicles, useAdBlueVendors, useCreateAdBlueVendorByName, useDeleteAdBluePurchase, useMonthLocks, useSaveAdBluePurchase } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, monthKey, todayISO, formatLitres } from "@/lib/format"
import type { AdBluePurchase, AdBlueVendor, Vehicle } from "@/lib/types"
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

  const d = useMemo(() => {
    if (!purchases.data || !entries.data || !totals.data) return null
    // Purchased − Consumed = Current Stock is asserted in npm run check:diesel — an internal check, never shown to users.
    return { totals: totals.data, ledger: totals.data.ledger, all: inEntryOrder(entries.data), history: inEntryOrder(purchases.data) }
  }, [purchases.data, entries.data, totals.data])

  if (!can("adblue")) return <NoAccess what="AdBlue inventory" />
  if (!d) return <PageSkeleton />
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
      <div className="flex flex-wrap items-center gap-3">
        {period.control}
        {month && <MonthLockControl month={month} />}
      </div>

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

      <section>
        <h2 className="mb-2 text-sm font-semibold">Purchase history</h2>
        <DataTable
          data={d.history}
          getRowId={(p) => p.id}
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
            { id: "product", header: "Product", cell: (p) => <span className="text-muted-foreground">{p.opening ? "—" : p.product || "—"}</span> },
            { id: "buckets", header: "Buckets", align: "right", cell: (p) => (p.opening ? "—" : `${formatNumber(p.buckets)} × ${formatNumber(p.litresPerBucket, 2)} L`) },
            { id: "litres", header: "Litres", align: "right", cell: (p) => <span className="num">{L(p.totalLitres)}</span> },
            { id: "rate", header: "Rate", align: "right", cell: (p) => (p.opening ? "—" : <span className="num flex flex-col items-end"><span>{formatINR(p.pricePerBucket)} / bucket</span>{p.totalLitres > 0 && <span className="text-xs text-muted-foreground">{formatINR(p.totalCost / p.totalLitres)} / L</span>}</span>) },
            { id: "amt", header: "Amount", align: "right", cell: (p) => <span className="num font-medium">{formatINR(p.totalCost)}</span> },
            { id: "inv", header: "Voucher / Invoice", cell: (p) => <span className="text-muted-foreground">{p.invoiceNo || "—"}</span> },
            { id: "notes", header: "Notes", cell: (p) => <span className="text-xs text-muted-foreground">{p.notes || "—"}</span> },
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

      {openingOpen && <AdBlueOpeningDialog onOpenChange={setOpeningOpen} />}
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
      {editing && <PurchaseDialog key={editing.purchase?.id ?? "new"} purchase={editing.purchase} vendors={vendors.data ?? []} mayAddVendor={mayManageVendors} onOpenChange={(o) => !o && setEditing(null)} />}
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
function PurchaseDialog({ purchase, vendors, mayAddVendor, onOpenChange }: { purchase?: AdBluePurchase; vendors: AdBlueVendor[]; mayAddVendor: boolean; onOpenChange: (o: boolean) => void }) {
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
    invoiceNo: purchase?.invoiceNo ?? "",
    notes: purchase?.notes ?? "",
  })
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
  const totalLitres = buckets * perBucket
  const totalCost = buckets * price

  const submit = async () => {
    setError(null)
    if (!f.vendorId) return setError("Choose the vendor")
    if (!(buckets > 0) || !(perBucket > 0)) return setError("Enter the number of buckets and litres per bucket")
    if (!(price >= 0) || f.pricePerBucket === "") return setError("Enter the price per bucket")
    await save.mutateAsync({
      id: purchase?.id, version: purchase?.updatedAt,
      data: { date: f.date, adblueVendorId: f.vendorId, product: f.product, buckets, litresPerBucket: perBucket, pricePerBucket: price, invoiceNo: f.invoiceNo.trim(), notes: f.notes.trim() },
      reason,
    })
    toast.success(`${purchase ? "Purchase updated" : "Purchase saved"} — +${L(totalLitres)} to inventory`)
    onOpenChange(false)
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={purchase ? "Edit AdBlue purchase" : "Add AdBlue purchase"}
      description="Bulk AdBlue into inventory — stock goes up by the total litres."
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
        <Field label="Product / grade / quality" className="sm:col-span-2">
          <Input value={f.product} onChange={set("product")} placeholder="e.g. AdBlue ISO 22241" />
        </Field>
        <Field label="Number of buckets" required>
          <Input type="number" min={0} step="1" value={f.buckets} onChange={set("buckets")} />
        </Field>
        <Field label="Litres per bucket" required>
          <Input type="number" min={0} step="0.01" value={f.litresPerBucket} onChange={(e) => { const v = e.target.value; setF((s) => ({ ...s, litresPerBucket: v, pricePerBucket: priceTyped ? s.pricePerBucket : defaultPrice(s.vendorId, v) })) }} />
        </Field>
        <Field label="Price per bucket (₹)" required hint={price > 0 && perBucket > 0 ? `Actual rate ${formatINR(price / perBucket)} / L${(() => { const d = vendors.find((v) => v.id === f.vendorId)?.defaultRate; return d && Math.abs(d - price / perBucket) > 0.005 ? ` · vendor default ${formatINR(d)} / L` : "" })()}` : "Filled from the vendor's default rate — change it to the price actually paid"}>
          <Input type="number" min={0} step="0.01" value={f.pricePerBucket} onChange={(e) => { setPriceTyped(true); set("pricePerBucket")(e) }} />
        </Field>
        <Field label="Invoice number">
          <Input value={f.invoiceNo} onChange={set("invoiceNo")} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={1} value={f.notes} onChange={set("notes")} />
        </Field>
        {purchase && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Total Litres</div>
          <div className="num font-semibold">{totalLitres > 0 ? L(totalLitres) : "—"}</div>
          {totalLitres > 0 && <div className="num text-[11px] text-muted-foreground">{formatNumber(buckets)} × {formatNumber(perBucket, 2)} L</div>}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Total Purchase Cost</div>
          <div className="num font-semibold">{f.pricePerBucket !== "" && buckets > 0 ? formatINR(totalCost) : "—"}</div>
          {totalLitres > 0 && price > 0 && <div className="num text-[11px] text-muted-foreground">{formatINR(totalCost / totalLitres)} / L</div>}
        </div>
      </div>
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
