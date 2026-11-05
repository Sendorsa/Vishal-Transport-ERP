"use client"

import { EditedBadge } from "@/components/shared/audit"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Bus, Droplets, ExternalLink, Fuel, Gauge, IndianRupee, Plus, Route } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTable } from "@/components/shared/data-table"
import { DetailList } from "@/components/shared/entity-drawer"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { asOfMonth, statusOn } from "@/domain/status-history"
import { assignmentIndex, handoverFrom } from "@/domain/assignments"
import { fillRow, findGroup, monthLabel, monthProgress, prevMonthKey, shortMonthLabel, vehicleMonth } from "@/domain/diesel"
import { useCan, useRole } from "@/lib/app-state"
import { useAdBlueEntries, useDeleteDiesel } from "@/lib/api/hooks"
import { isTankerFill, tankerLabel, tankerOf } from "@/domain/tanker"
import { adBlueStats } from "@/domain/adblue"
import { fuelLabel } from "@/lib/constants"
import type { DieselEntry } from "@/lib/types"
import type { Dataset } from "@/domain/analytics"
import { formatDate, formatINR, formatNumber, monthKey, todayISO } from "@/lib/format"
import { AddDieselEntryDialog } from "./add-diesel-entry-dialog"
import { AddAdBlueDialog } from "./add-adblue-dialog"
import { AdBlueSection } from "./adblue-section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CompanyLogo, DieselBreadcrumb, FillPaymentBadge, MileageHeader, mileageText, MonthSelect, dieselHref, kpiExplain, useDieselIndex, useDieselMonthOptions, useSyncDieselMonth, MonthLockControl, useMonthLock } from "./parts"
import { OpeningOdometerDialog } from "@/features/go-live/opening-dialogs"
import { hasOwnerAuthority } from "@/lib/permissions"

/** Vehicle page: vehicle information → diesel entries (+ add) → monthly history. */
export function VehicleDiesel({ slug, month, reg }: { slug: string; month: string; reg: string }) {
  const can = useCan()
  const router = useRouter()
  const { idx, ds, isLoading } = useDieselIndex()
  const allMonths = useDieselMonthOptions(idx)
  useSyncDieselMonth(month)
  const adblue = useAdBlueEntries()
  const monthLock = useMonthLock(month)
  const [addOpen, setAddOpen] = useState(false)
  const [adBlueOpen, setAdBlueOpen] = useState(false)
  const [tab, setTab] = useState<"diesel" | "adblue">("diesel")
  const [editing, setEditing] = useState<DieselEntry | null>(null)
  const [deleting, setDeleting] = useState<DieselEntry | null>(null)
  const [odometerOpen, setOdometerOpen] = useState(false)
  const [role] = useRole()
  const del = useDeleteDiesel()
  const today = todayISO()
  const group = idx ? findGroup(idx, slug) : null
  const vehicle = idx ? [...idx.vehicles.values()].find((v) => v.regNo.toLowerCase() === reg.toLowerCase()) ?? null : null

  const d = useMemo(() => {
    if (!idx || !ds || !group || !vehicle) return null
    const prog = monthProgress(month, today)
    const cur = vehicleMonth(idx, group.id, vehicle.id, month)
    const prevKey = prevMonthKey(month)
    const prev = vehicleMonth(idx, group.id, vehicle.id, prevKey)
    // Same fill rows the KPIs are built from; the previous fill may be last month or for another customer.
    const fills = (cur?.entries ?? []).map((e) => fillRow(idx, e)).reverse()
    const history = allMonths.flatMap((m) => {
      const vm = vehicleMonth(idx, group.id, vehicle.id, m)
      return vm && (vm.fills > 0 || vm.km > 0 || m === month) ? [{ month: m, ...vm }] : []
    })
    return {
      prog,
      cur,
      prev,
      prevKey,
      fills,
      history,
      vendors: new Map(ds.fuelStations.map((v) => [v.id, v])),
      tankers: new Map((ds.tankers ?? []).map((t) => [t.id, t])),
      typeName: ds.settings.vehicleTypes.find((t) => t.code === vehicle.typeCode)?.name ?? vehicle.typeCode,
    }
  }, [idx, ds, group, vehicle, month, today, allMonths])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !idx) return <PageSkeleton />
  if (!group || !vehicle || !d || !d.cur)
    return (
      <EmptyState
        icon={Bus}
        title="Vehicle not found for this customer"
        action={
          <Button variant="outline" asChild>
            <Link href={group ? dieselHref(group.slug) : "/diesel"}>Back</Link>
          </Button>
        }
      />
    )

  const { cur, prev } = d
  const unit = vehicle.fuelType === "EV" ? "kWh" : "L" // an EV's "litres" are units charged
  const why = kpiExplain(cur)
  // AdBlue for this vehicle with this customer, selected month — its own entries and formulas.
  const ab = adBlueStats((adblue.data ?? []).filter((e) => e.vehicleId === vehicle.id && e.customerId === (group.customer?.id ?? null) && e.date.startsWith(month)))
  const period = shortMonthLabel(month) + (d.prog.inProgress ? " (to date)" : "")
  const vsLabel = `vs ${shortMonthLabel(d.prevKey)}`
  const pct = (a: number | null | undefined, b: number | null | undefined) => (a && b ? ((a - b) / b) * 100 : null)
  // Archived vehicle or customer: history stays, new entries are blocked (the API refuses them too).
  // Judged on the selected month's status, not today's: a September view of a vehicle archived in October is normal.
  const asOf = asOfMonth(month, todayISO())
  const vehicleThen = statusOn(vehicle, asOf)
  // Previous owner (vehicle transferred away by this month): read-only history, no new entries or edits.
  const handover = group.id && ds ? handoverFrom(assignmentIndex(ds.assignments ?? []).get(vehicle.id) ?? [], group.id, asOf) : null
  const newOwner = handover ? (ds?.customers.find((c) => c.id === handover.toCustomerId)?.shortName ?? "another customer") : null
  const locked = handover
    ? `Transferred to ${newOwner}${handover.effectiveDate ? ` · effective ${formatDate(handover.effectiveDate)}` : ""} — read-only history here`
    : vehicleThen === "ARCHIVED"
      ? `${vehicle.regNo} is archived — history only, restore to add entries`
      : group.customer && statusOn(group.customer, asOf) === "ARCHIVED"
        ? `${group.shortName} is archived — history only, restore to add entries`
        : !monthLock.canEdit
          ? `${monthLabel(month)} is locked — only the Owner can add or change entries`
          : null
  // Row actions: ✏️ / 🗑 by permission; a 🔒 explains a locked month. A previous owner gets none.
  const mayEdit = can("diesel", "edit") && !handover
  const mayDelete = can("diesel", "delete") && !handover
  const rowLock = (mayEdit || mayDelete) && !monthLock.canEdit ? monthLockedReason(monthLabel(month)) : null
  const addButton = can("diesel", "create") && !locked && (
    <Button onClick={() => setAddOpen(true)}>
      <Plus /> Add Diesel Entry
    </Button>
  )
  const addAdBlueButton = can("diesel", "create") && !locked && (
    <Button onClick={() => setAdBlueOpen(true)}>
      <Plus /> Add AdBlue Entry
    </Button>
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <DieselBreadcrumb
          items={[
            { label: "Diesel", href: "/diesel" },
            { label: monthLabel(month), href: "/diesel" },
            { label: group.shortName, href: dieselHref(group.slug) },
            { label: vehicle.regNo },
          ]}
        />
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
                {vehicle.regNo}
                {vehicleThen === "ARCHIVED" && <StatusBadge status="ARCHIVED" />}
                {newOwner && <StatusBadge status="TRANSFERRED" tone="gray" label={`Transferred to ${newOwner}`} />}
              </h1>
              {vehicle.ownership === "ATTACHED" && <StatusBadge status="ATTACHED" />}
            </div>
            <p className="text-sm text-muted-foreground">
              {d.typeName} · diesel costed to {group.shortName}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Go-live opening (owner, 3 Nov 2026): the odometer at its last fill before records began — Owner / Dev. */}
            {hasOwnerAuthority(role) && (
              <Button variant="outline" size="sm" onClick={() => setOdometerOpen(true)} title={vehicle.openingOdometerKm != null ? `Opening odometer ${formatNumber(vehicle.openingOdometerKm)} km (${formatDate(vehicle.openingOdometerDate!)})` : undefined}>
                <Gauge /> {vehicle.openingOdometerKm != null ? "Opening odometer ✓" : "Opening odometer"}
              </Button>
            )}
            <MonthSelect months={allMonths} value={month} onChange={(m) => router.push(dieselHref(group.slug, m, vehicle.regNo))} prominent />
          </div>
        </div>
        <div className="mt-2">
          <MonthLockControl month={month} />
        </div>
      </div>

      {odometerOpen && <OpeningOdometerDialog vehicle={vehicle} onOpenChange={setOdometerOpen} />}
      {/* 1. Vehicle information */}
      <Card size="sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-semibold">Vehicle information</CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/vehicles/${vehicle.id}`}>
              Full vehicle record <ExternalLink />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <DetailList
            className="sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]"
            items={[
              ["Customer", <span key="c" className="flex items-center gap-1.5"><CompanyLogo group={group} size="sm" />{group.shortName}</span>],
              ["Driver", cur.driver?.name ?? "Owner-driven"],
              ["Type", d.typeName],
              ["Make / model", [vehicle.make, vehicle.model].filter(Boolean).join(" ") || "—"],
              ["Ownership", vehicle.ownership === "ATTACHED" ? `Attached — ${vehicle.ownerName}` : "Owned"],
              ["Rated mileage", `${vehicle.mileageKmpl} km/L`],
              ["Odometer", `${formatNumber(vehicle.odometerKm)} km`],
              ["Fuel type", fuelLabel(vehicle.fuelType)],
            ]}
          />
        </CardContent>
      </Card>

      {/* Vehicle summary — Diesel and AdBlue metrics side by side, calculated separately */}
      <div className="space-y-3">
        <SummaryRow title="Diesel">
          <StatsCard label="Total Diesel Used" icon={Fuel} value={`${formatNumber(cur.litres, 2)} L`} hint={`${period} · ${cur.fills} fills${cur.kwh ? ` · ${cur.kwh} kWh` : ""}`} info={why.litres} />
          <StatsCard label="Total Diesel Spend" icon={IndianRupee} value={formatINR(cur.spend)} delta={pct(cur.spend, prev?.spend)} invertDelta hint={`${period} · ${vsLabel}`} info={why.spend} />
          <StatsCard label="Diesel KM/L" icon={Gauge} value={cur.kmpl ?? "—"} hint={`${period} · ${formatNumber(cur.km)} km · rated ${vehicle.mileageKmpl}`} info={`${why.km} ${why.kmpl}`} />
          <StatsCard label="Diesel Cost per KM" icon={Route} value={cur.costPerKm ? formatINR(cur.costPerKm) : "—"} delta={pct(cur.costPerKm, prev?.costPerKm)} invertDelta hint={`${period} · ${vsLabel}`} info={why.costPerKm} />
        </SummaryRow>
        <SummaryRow title="AdBlue">
          <StatsCard label="Total AdBlue Used" icon={Droplets} value={`${formatNumber(ab.litres, 2)} L`} hint={`${period} · ${ab.entries} entries`} info={`Σ litres of this vehicle's AdBlue entries in the month = ${formatNumber(ab.litres, 2)} L.`} />
          <StatsCard label="Total AdBlue Spend" icon={IndianRupee} value={formatINR(ab.spend)} hint={period} info={`Σ amount of AdBlue entries = ${formatINR(ab.spend)} — not part of diesel spend.`} />
          <StatsCard
            label="AdBlue KM/L"
            icon={Gauge}
            value={ab.kmPerLitre ?? "—"}
            hint={`${period} · ${formatNumber(ab.km)} km`}
            info={ab.kmPerLitre ? `${formatNumber(ab.km)} km (closing − opening on AdBlue entries) ÷ ${formatNumber(ab.litres, 2)} L = ${ab.kmPerLitre}.` : "Needs AdBlue entries this month."}
          />
          <StatsCard
            label="AdBlue Cost per KM"
            icon={Route}
            value={ab.costPerKm !== null ? formatINR(ab.costPerKm) : "—"}
            hint={period}
            info={ab.costPerKm !== null ? `${formatINR(ab.spend)} ÷ ${formatNumber(ab.km)} km = ${formatINR(ab.costPerKm)} per km.` : "Needs AdBlue entries this month."}
          />
        </SummaryRow>
      </div>

      {/* Fuel & Consumables — Diesel and AdBlue are tracked and shown separately */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Fuel & Consumables</h2>
            <TabsList>
              <TabsTrigger value="diesel">Diesel</TabsTrigger>
              <TabsTrigger value="adblue">AdBlue</TabsTrigger>
            </TabsList>
          </div>
          {locked ? <span className="text-xs text-muted-foreground">{locked}</span> : tab === "diesel" ? addButton : addAdBlueButton}
        </div>
        <TabsContent value="diesel" className="mt-3 space-y-5">

          {/* 2. Diesel entries — selected month */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Diesel entries · {monthLabel(month)}</h2>

            </div>
            {d.fills.length === 0 ? (
              <EmptyState
                icon={Fuel}
                title={`No diesel entries for ${vehicle.regNo} in ${monthLabel(month)}`}
                description={`Fills recorded here are costed to ${group.shortName}.`}
                action={addButton || undefined}
              />
            ) : (
              <DataTable
                data={d.fills}
                getRowId={(f) => f.entry.id}
                pageSize={50}
                columns={[
                  { id: "date", header: "Date", cell: (f) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="num">{formatDate(f.entry.date)}</span>
                    <EditedBadge id={f.entry.id} />
                  </span>
                ) },
                  {
                    id: "vendor",
                    header: "Source",
                    cell: (f) => {
                      if (isTankerFill(f.entry)) {
                        const t = d.tankers.get(tankerOf(f.entry))
                        return (
                          <span className="flex items-center gap-1.5">
                            <StatusBadge status="TANKER" label="Tanker" tone="gray" className="h-4.5 px-1.5 text-[10px]" />
                            <span className="truncate">{t ? tankerLabel(t) : "Diesel Tanker"}</span>
                          </span>
                        )
                      }
                      const v = d.vendors.get(f.entry.vendorId)
                      return (
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">{v?.name ?? f.entry.vendorId}</span>
                          {v?.isInterCompany && <StatusBadge status="IC" label="VT outlet" tone="violet" className="h-4.5 px-1.5 text-[10px]" />}
                        </span>
                      )
                    },
                  },
                  { id: "bill", header: "Bill no.", hideOnMobile: true, cell: (f) => <span className="text-muted-foreground">{f.entry.billNo || "—"}</span> },
                  { id: "litres", header: vehicle.fuelType === "EV" ? "kWh" : "Litres", align: "right", cell: (f) => formatNumber(f.entry.litres, 2) },
                  { id: "rate", header: "Rate ₹/L", align: "right", hideOnMobile: true, cell: (f) => f.entry.rate.toFixed(2) },
                  { id: "amount", header: "Amount", align: "right", cell: (f) => <span className="font-medium">{formatINR(f.entry.amount)}</span> },
                  { id: "prevodo", header: "Previous odometer", align: "right", className: "hidden 2xl:table-cell", cell: (f) => (f.prevOdometer !== null ? formatNumber(f.prevOdometer) : "first fill") },
                  { id: "odo", header: "Odometer", align: "right", hideOnMobile: true, cell: (f) => (f.entry.odometerKm === null ? "—" : formatNumber(f.entry.odometerKm)) },
                  {
                    id: "since",
                    header: "KM since last fill",
                    align: "right",
                    cell: (f) =>
                      f.kmSince === null ? "—" : f.kmSince < 0 ? <span className="text-destructive" title="Odometer is lower than the previous fill — counted as 0">{formatNumber(f.kmSince)}</span> : formatNumber(f.kmSince),
                  },
                  { id: "kmpl", header: <MileageHeader unit={unit} />, align: "right", cell: (f) => mileageText(f.kmpl, unit) },
                  { id: "mode", header: "Payment", hideOnMobile: true, cell: (f) => <FillPaymentBadge entry={f.entry} /> },
                  ...(mayEdit || mayDelete
                    ? [{
                        id: "act",
                        header: "",
                        align: "right" as const,
                        // Editing is explicit: only ✏️ opens the edit dialog, never a row click; 🗑 asks first.
                        cell: (f: (typeof d.fills)[number]) => (
                          <RowActions lockedReason={rowLock} onEdit={mayEdit ? () => setEditing(f.entry) : undefined} onDelete={mayDelete ? () => setDeleting(f.entry) : undefined} />
                        ),
                      }]
                    : []),
                ]}
              />
            )}
          </section>

          {/* 3. Monthly history */}
          <section>
            <h2 className="mb-2 text-sm font-semibold">Monthly history · {vehicle.regNo} with {group.shortName}</h2>
            <DataTable
              data={d.history}
              getRowId={(h) => h.month}
              rowHref={(h) => dieselHref(group.slug, h.month, vehicle.regNo)}
              pageSize={24}
              columns={[
                {
                  id: "month",
                  header: "Month",
                  cell: (h) => (
                    <span className={h.month === month ? "font-semibold" : ""}>
                      {monthLabel(h.month)}
                      {h.month === monthKey(today) && <span className="font-normal text-muted-foreground"> · to date</span>}
                    </span>
                  ),
                },
                { id: "fills", header: "Fills", align: "right", hideOnMobile: true, cell: (h) => h.fills },
                { id: "litres", header: "Litres", align: "right", cell: (h) => formatNumber(h.litres) },
                { id: "spend", header: "Diesel Spend", align: "right", cell: (h) => (h.spend ? formatINR(h.spend) : "—") },
                { id: "km", header: "KM Run", align: "right", hideOnMobile: true, cell: (h) => formatNumber(h.km) },
                { id: "cpk", header: "Diesel ₹ / KM", align: "right", cell: (h) => (h.costPerKm ? formatINR(h.costPerKm) : "—") },
                { id: "kmpl", header: "KM / Litre", align: "right", hideOnMobile: true, cell: (h) => h.kmpl ?? "—" },
              ]}
            />
          </section>
        </TabsContent>
        <TabsContent value="adblue" className="mt-3">
          <AdBlueSection vehicle={vehicle} customer={group.customer} month={month} canEdit={mayEdit} canDelete={mayDelete} />
        </TabsContent>
      </Tabs>

      <AddAdBlueDialog open={adBlueOpen} onOpenChange={setAdBlueOpen} vehicle={vehicle} customer={group.customer} month={month} />
      <AddDieselEntryDialog open={addOpen} onOpenChange={setAddOpen} vehicle={vehicle} customer={group.customer} month={month} />
      {editing && (
        <AddDieselEntryDialog key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} vehicle={vehicle} customer={group.customer} month={month} entry={editing} />
      )}
      {deleting && (
        <DeleteDialog
          title="Delete this diesel entry?"
          record={`${vehicle.regNo} · ${formatDate(deleting.date)} · ${formatNumber(deleting.litres, 2)} L · ${formatINR(deleting.amount)} · ${sourceName(deleting, ds)}`}
          impact={
            isTankerFill(deleting)
              ? "This removes the fill from the vehicle's fuel history and the customer and monthly diesel totals, and returns its litres to tanker inventory."
              : `This removes the fill from the vehicle's fuel history, the customer and monthly diesel totals, and the fuel station's purchases and ledger${deleting.paymentMode === "CASH" ? " (including its cash-at-pump payment)" : ""}. A later fill's KM since last fill then covers the gap, so total KM Run is unchanged.`
          }
          pending={del.isPending}
          onConfirm={(reason) => del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/** Where a fill came from, for the delete confirmation: "from tanker JIO · TN70AX9480" or the pump's name. */
function sourceName(e: DieselEntry, ds: Pick<Dataset, "fuelStations" | "tankers"> | undefined) {
  if (!isTankerFill(e)) return ds?.fuelStations.find((s) => s.id === e.vendorId)?.name ?? "Unknown station"
  const t = ds?.tankers?.find((x) => x.id === tankerOf(e))
  return `from tanker ${t ? tankerLabel(t) : ""}`.trim()
}

function SummaryRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 lg:grid-cols-[72px_minmax(0,1fr)] lg:items-center">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{children}</div>
    </div>
  )
}
