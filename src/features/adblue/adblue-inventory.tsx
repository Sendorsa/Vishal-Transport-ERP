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
import { inventoryLedger, isDirectAdBlue, purchasedIn, stockDraws, stockFor, totalsFor, valueInventory, vendorAnalytics } from "@/domain/adblue-inventory"
import { SimpleSelect } from "@/components/shared/simple-select"
import { AddAdBlueDialog } from "../diesel/add-adblue-dialog"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { inEntryOrder } from "@/domain/payment-order"
import { useAdBlueEntries, useAdBluePurchases, useAdBlueTotals, useDeleteAdBluePurchase, useMonthLocks, useSaveAdBluePurchase } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, monthKey, todayISO, formatLitres } from "@/lib/format"
import type { AdBluePurchase, Vehicle } from "@/lib/types"
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
  const locks = useMonthLocks()
  const del = useDeleteAdBluePurchase()
  const [editing, setEditing] = useState<{ purchase?: AdBluePurchase } | null>(null)
  const [deleting, setDeleting] = useState<AdBluePurchase | null>(null)
  const [direct, setDirect] = useState<{ vehicle?: Vehicle } | null>(null)
  const [openingOpen, setOpeningOpen] = useState(false)

  const d = useMemo(() => {
    if (!purchases.data || !entries.data || !totals.data) return null
    // Purchased − Consumed = Current Stock is asserted in npm run check:diesel — an internal check, never shown to users.
    return { totals: totals.data, ledger: totals.data.ledger, directs: inEntryOrder(entries.data.filter(isDirectAdBlue)), vendors: vendorAnalytics(purchases.data), history: inEntryOrder(purchases.data) }
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
  // Every card is company-wide, from the totals (also for Tata Adblue, owner 11 Nov 2026); only the direct purchases
  // table lists entries — the role's own (Tata Adblue: its granted customers').
  const { stock, directCost, directLitres, directCount } = totalsFor(d.totals, period.periodMonths, endedMonth)
  const directInPeriod = d.directs.filter(period.match)
  const issued = { cost: m.consumedCost, litres: m.consumed }
  const regOf = (id: string) => idx?.vehicles.get(id)?.regNo ?? "Unknown"
  const asOf = endedMonth ? `As of ${format(endOfMonth(parseISO(`${endedMonth}-01`)), "d MMM yyyy")}` : "As of today"
  const open = (p: AdBluePurchase) => canEditMonth(role, p.date.slice(0, 7), todayISO(), locks.data ?? [])
  const mayEdit = canChangeAdBluePurchases(role, "edit")
  const mayDelete = canChangeAdBluePurchases(role, "delete")

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
            hint={`${asOf}${stock.avgRate ? ` · Weighted average ${formatINR(stock.avgRate)} / L` : " · No stock"}`}
            info="Stock valued at the moving weighted-average purchase rate: each purchase re-averages the rate, each draw is costed at the rate of that moment. For a past period, the value at its month end."
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
          <StatsCard label="Consumed (out)" icon={PackageMinus} value={L(m.consumed)} hint={`${formatINR(m.consumedCost)} at average cost`} info="Σ litres of vehicle AdBlue entries dated in the period, valued at the weighted-average rate." />
          <StatsCard label="Closing Stock" icon={Package} value={L(m.closing)} hint="Carries into the next period" info={`Opening ${L(m.opening + m.openingStock)} + Purchased ${L(m.purchased)} − Consumed ${L(m.consumed)} = ${L(m.closing)}.`} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Direct vendor purchases & total AdBlue expense · {p}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatsCard label="Direct Vendor Purchases" icon={Store} value={formatINR(directCost)} hint={`${p} · ${directCount} purchase${directCount === 1 ? "" : "s"}`} info="Σ amount (litres × rate) of AdBlue bought from a vendor straight into a vehicle, dated in the period. Never part of bulk stock or bulk purchases." />
          <StatsCard label="Direct Litres" icon={PackagePlus} value={L(directLitres)} hint={p} info="Σ litres of direct vendor purchases dated in the period. Not in bulk stock." />
          <StatsCard label="Bulk Issued to Vehicles" icon={PackageMinus} value={formatINR(issued.cost)} hint={`${L(issued.litres)} at average cost`} info="Σ bulk-stock draws by vehicles dated in the period, valued at the weighted-average rate." />
          <StatsCard
            label="Total AdBlue Expense"
            icon={Sigma}
            value={formatINR(issued.cost + directCost)}
            hint={`${L(issued.litres + directLitres)} used`}
            info="Bulk issued to vehicles (at average cost) + direct vendor purchases. Bulk purchases are stock, not expense, so they're not added again — nothing is counted twice."
          />
        </div>
        {directInPeriod.length > 0 && (
          <div className="mt-3">
            <DataTable
              data={directInPeriod}
              getRowId={(e) => e.id}
              dense
              pageSize={10}
              columns={[
                { id: "d", header: "Date", cell: (e) => <span className="num">{formatDate(e.date)}</span> },
                { id: "v", header: "Vehicle", cell: (e) => <span className="font-medium">{regOf(e.vehicleId)}</span> },
                { id: "vendor", header: "Vendor", cell: (e) => e.vendorName },
                { id: "l", header: "Litres", align: "right", cell: (e) => <span className="num">{L(e.quantityLitres)}</span> },
                { id: "r", header: "Rate / L", align: "right", cell: (e) => <span className="num">{e.rate ? formatINR(e.rate) : "—"}</span> },
                { id: "a", header: "Amount", align: "right", cell: (e) => <span className="num font-medium">{formatINR(e.amount)}</span> },
                { id: "pm", header: "Paid", hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{e.paymentMode ?? "—"}</span> },
                { id: "i", header: "Invoice", hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{e.invoiceNo || "—"}</span> },
              ]}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {role === "TATA_ADBLUE" && "Your customers' direct purchases only — the cards above are company-wide totals. "}Edit or delete a direct purchase on the vehicle&apos;s AdBlue tab.
            </p>
          </div>
        )}
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
            { id: "rate", header: "Rate", align: "right", cell: (p) => <span className="num">{p.opening ? "—" : `${formatINR(p.pricePerBucket)} / bucket`}</span> },
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

      <section>
        <h2 className="mb-2 text-sm font-semibold">Vendors</h2>
        <DataTable
          data={d.vendors}
          getRowId={(r) => r.vendor}
          initialSort={{ id: "amount", desc: true }}
          dense
          emptyMessage="No vendors yet."
          columns={[
            { id: "vendor", header: "Vendor", sortValue: (r) => r.vendor, cell: (r) => <span className="font-medium">{r.vendor}</span> },
            { id: "litres", header: "Total Litres Purchased", align: "right", sortValue: (r) => r.litres, cell: (r) => <span className="num">{L(r.litres)}</span> },
            { id: "amount", header: "Total Amount Purchased", align: "right", sortValue: (r) => r.amount, cell: (r) => <span className="num">{formatINR(r.amount)}</span> },
            { id: "rate", header: "Average Rate / Litre", align: "right", sortValue: (r) => r.avgRate, cell: (r) => <span className="num">{r.avgRate ? formatINR(r.avgRate) : "—"}</span> },
          ]}
        />
      </section>

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
      {editing && <PurchaseDialog key={editing.purchase?.id ?? "new"} purchase={editing.purchase} vendors={d.vendors.map((v) => v.vendor)} onOpenChange={(o) => !o && setEditing(null)} />}
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

/** Add / edit a bulk AdBlue purchase. Totals are Buckets × per-bucket values. */
function PurchaseDialog({ purchase, vendors, onOpenChange }: { purchase?: AdBluePurchase; vendors: string[]; onOpenChange: (o: boolean) => void }) {
  const save = useSaveAdBluePurchase()
  const today = todayISO()
  const [f, setF] = useState({
    date: purchase?.date ?? today,
    vendorName: purchase?.vendorName ?? "",
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
  const buckets = Number(f.buckets)
  const perBucket = Number(f.litresPerBucket)
  const price = Number(f.pricePerBucket)
  const totalLitres = buckets * perBucket
  const totalCost = buckets * price

  const submit = async () => {
    setError(null)
    if (!f.vendorName.trim()) return setError("Enter the vendor name")
    if (!(buckets > 0) || !(perBucket > 0)) return setError("Enter the number of buckets and litres per bucket")
    if (!(price >= 0) || f.pricePerBucket === "") return setError("Enter the price per bucket")
    await save.mutateAsync({
      id: purchase?.id, version: purchase?.updatedAt,
      data: { date: f.date, vendorName: f.vendorName, product: f.product, buckets, litresPerBucket: perBucket, pricePerBucket: price, invoiceNo: f.invoiceNo.trim(), notes: f.notes.trim() },
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
        <Field label="Vendor name" required error={error ?? undefined}>
          <Input value={f.vendorName} onChange={set("vendorName")} list="adblue-vendors" placeholder="e.g. XYZ Chemicals" autoFocus />
          <datalist id="adblue-vendors">
            {vendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="Product / grade / quality" className="sm:col-span-2">
          <Input value={f.product} onChange={set("product")} placeholder="e.g. AdBlue ISO 22241" />
        </Field>
        <Field label="Number of buckets" required>
          <Input type="number" min={0} step="1" value={f.buckets} onChange={set("buckets")} />
        </Field>
        <Field label="Litres per bucket" required>
          <Input type="number" min={0} step="0.01" value={f.litresPerBucket} onChange={set("litresPerBucket")} />
        </Field>
        <Field label="Price per bucket (₹)" required>
          <Input type="number" min={0} step="0.01" value={f.pricePerBucket} onChange={set("pricePerBucket")} />
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
