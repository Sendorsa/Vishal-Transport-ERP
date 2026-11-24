"use client"

import { EditedBadge, HistoryButton } from "@/components/shared/audit"
import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { Bus, Fuel, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable } from "@/components/shared/data-table"
import { DetailList } from "@/components/shared/entity-drawer"
import { EmptyState, Money, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { FillPaymentBadge, MileageHeader, mileageText } from "@/features/diesel/parts"
import { buildDieselIndex, fillRow } from "@/domain/diesel"
import { categoryName } from "@/domain/analytics"
import { vehicleFyFuel } from "@/domain/vehicle-summary"
import { useDataset } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatINR, formatDate, formatNumber, todayISO } from "@/lib/format"
import { VehicleDriversCard } from "./vehicle-drivers"
import { VehicleForm } from "./vehicle-form"
import { VehicleTyres } from "./vehicle-tyres"
import { VehicleDeletionsIndicator, VehicleDuesButton } from "./vehicle-notices"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { fuelName } from "@/domain/expenditure"

// Maintenance and tyre vouchers aren't fixed costs (they still count in vehicle profitability, e.g. Reports).
const MAINT = new Set(["MAINTENANCE", "TYRE"])

export function VehicleDetail({ id }: { id: string }) {
  const can = useCan()
  const finance = can("finance", "view")
  const { data: ds, isLoading } = useDataset()
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState("overview")
  const today = todayISO()

  const d = useMemo(() => {
    if (!ds) return null
    const vehicle = ds.vehicles.find((v) => v.id === id)
    if (!vehicle) return { vehicle: null }
    const diesel = inEntryOrder(ds.diesel.filter((e) => e.vehicleId === id))
    // KM since last fill and mileage per fill, from this vehicle's own readings (the Diesel module's fillRow).
    const fillIdx = buildDieselIndex({ ...ds, diesel, trips: [] })
    const mileage = new Map(diesel.map((e) => [e.id, fillRow(fillIdx, e).kmpl]))
    const payments = ds.payments.filter((p) => p.vehicleId === id && p.direction === "OUT")
    return {
      vehicle,
      fuel: vehicleFyFuel(vehicle, ds.diesel, today), // KM Run and mileage cards (domain/vehicle-summary.ts)
      diesel,
      mileage,
      fixedCosts: inEntryOrder(payments.filter((p) => !MAINT.has(p.categoryCode ?? ""))),
      customer: ds.customers.find((c) => c.id === vehicle.assignedCustomerId),
      drivers: ds.drivers,
      type: ds.settings.vehicleTypes.find((t) => t.code === vehicle.typeCode),
      vendors: new Map(ds.fuelStations.map((v) => [v.id, v])),
      settings: ds.settings,
    }
  }, [ds, id, today])

  if (!can("vehicles")) return <NoAccess what="vehicles" />
  if (isLoading || !d) return <PageSkeleton />
  if (!d.vehicle)
    return <EmptyState icon={Bus} title="Vehicle not found" action={<Button asChild variant="outline"><Link href="/vehicles">Back to vehicles</Link></Button>} />

  const v = d.vehicle
  const unit = v.fuelType === "EV" ? "kWh" : "L" // an EV's "litres" are units charged
  if (editing)
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title={`Edit ${v.regNo}`} backHref={`/vehicles/${v.id}`} backLabel={v.regNo} />
        <VehicleForm vehicle={v} onDone={() => setEditing(false)} />
      </div>
    )

  const f = d.fuel!
  // Fills whose litres / units count but add no usable KM gap: the mileage may read low, so it is shown as incomplete.
  const qty = v.fuelType === "EV" ? "kWh" : "L"
  const gapIssues = [
    [f.incomplete.noEarlier, "have no earlier odometer reading on record (first fill)"],
    [f.incomplete.uncovered, "have no odometer reading, and no later reading measures past them yet"],
    [f.incomplete.repeated, "repeat the previous odometer reading (0 km)"],
    [f.incomplete.lower, "have a reading below the previous one (counted 0 km, and the next gap is inflated)"],
  ] as const
  const incomplete = gapIssues.filter(([x]) => x.fills > 0)
  const shortBy = incomplete.reduce((t, [x]) => t + x.fills, 0)
  const unreliable = f.incomplete.lower.fills > 0 // a lower reading can push the figure either way
  const docs: [string, string, string][] = [
    ["Insurance", v.insurance.validTill, [v.insurance.provider, v.insurance.policyNo, v.insurance.premium ? `premium ${formatINR(v.insurance.premium)}` : ""].filter(Boolean).join(" · ") || "Vehicle insurance"],
    ["Road tax", v.roadTax.validTill, `${v.roadTax.period === "QUARTERLY" ? "Quarterly" : "Annual"}${v.roadTax.amount ? ` · ${formatINR(v.roadTax.amount)}` : ""}`],
    ["Fitness (FC)", v.fitnessValidTill, "RTO fitness certificate"],
    ["Permit", v.permitValidTill, v.typeCode.startsWith("TRUCK") || v.typeCode === "PICKUP" ? "Goods carriage permit" : "Contract carriage permit"],
    ["PUC", v.pucValidTill ?? "", "Pollution Under Control certificate"],
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        backHref="/vehicles"
        backLabel="Vehicles"
        title={v.regNo}
        meta={
          <>
            <VehicleDeletionsIndicator vehicleId={v.id} />
            <EditedBadge id={v.id} />
            <HistoryButton id={v.id} />
            <CompanyBadge code={v.companyCode} />
            <StatusBadge status={v.status} />
            {v.ownership === "ATTACHED" && <StatusBadge status="ATTACHED" />}
          </>
        }
        description={`${d.type?.name ?? v.typeCode} · ${v.make} ${v.model} (${v.year}) · ${d.customer ? `deployed at ${d.customer.name}` : "spare"}`}
        actions={
          <>
            {can("vehicles", "edit") && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can("tyres") && <VehicleDuesButton vehicleId={v.id} onOpen={() => setTab("tyres")} />}
            {can("diesel") && d.customer && (
              <Button variant="outline" asChild>
                <Link href={`/diesel/${d.customer.code.toLowerCase()}/${todayISO().slice(0, 7)}/${v.regNo}`}>
                  <Fuel /> {fuelName(v.fuelType)}
                </Link>
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <StatsCard
          label={`KM Run (${f.fyLabel})`}
          value={`${formatNumber(f.km)} km`}
          hint={[
            f.fills ? `Odometer gaps between this FY's ${formatNumber(f.fills)} fill${f.fills === 1 ? "" : "s"}` : "No fills recorded this FY",
            f.lastReading ? `Last reading ${formatNumber(f.lastReading.odometerKm!)} km on ${formatDate(f.lastReading.date)}` : `Odometer on vehicle record ${formatNumber(v.odometerKm)} km`,
          ].join(" · ")}
        />
        <StatsCard
          label={`Mileage (${f.fyLabel})`}
          value={f.mileage === null ? "Not enough data" : `${incomplete.length ? "≈ " : ""}${f.mileage.toFixed(2)} ${f.unit}`}
          hint={[
            f.mileage === null
              ? f.fills
                ? "No fill this FY with a usable odometer gap"
                : "No fills recorded this FY"
              : incomplete.length
                ? unreliable
                  ? `Unreliable — ${shortBy} of ${f.fills} fills have odometer problems, so it may be too high or too low`
                  : `Incomplete — ${shortBy} of ${f.fills} fills add fuel with no measured KM, so it may read low`
                : `Measured: KM Run ÷ ${v.fuelType === "EV" ? "units charged" : "litres filled"} over ${f.fills} fill${f.fills === 1 ? "" : "s"}`,
            v.mileageKmpl ? `Expected ${formatNumber(v.mileageKmpl, 2)} ${f.unit}` : `No expected ${v.fuelType === "EV" ? "efficiency" : "mileage"} set`,
          ].join(" · ")}
          info={[
            `Mileage = KM Run ÷ ${v.fuelType === "EV" ? "units charged" : "litres filled"} over this FY's fills: ${formatNumber(f.km)} km ÷ ${formatNumber(f.quantity, 2)} ${qty}${f.mileage === null ? "" : ` = ${f.mileage.toFixed(2)} ${f.unit}`}.`,
            ...incomplete.map(([x, why]) => `${x.fills} fill${x.fills === 1 ? "" : "s"} (${formatNumber(x.quantity, 2)} ${qty}) ${why}.`),
            ...(f.covered.fills ? [`${f.covered.fills} fill${f.covered.fills === 1 ? "" : "s"} without a reading ${f.covered.fills === 1 ? "is" : "are"} covered by the next reading's gap — counted, not a problem.`] : []),
            "No full-tank / partial-fill record exists, so this is the period's km ÷ fuel filled, not a tank-to-tank measurement.",
          ].join(" ")}
          tone={f.mileage !== null && (incomplete.length > 0 || (v.mileageKmpl && f.mileage < v.mileageKmpl * 0.92)) ? "warning" : "default"}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="diesel">{fuelName(v.fuelType)} ({d.diesel!.length})</TabsTrigger>
          {can("tyres") && <TabsTrigger value="tyres">Tyres</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-3 grid gap-4 lg:grid-cols-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                items={[
                  ["Type", d.type?.name ?? v.typeCode],
                  ["Make / model", `${v.make} ${v.model}`],
                  ["Year", v.year],
                  ["Seats", v.seats ?? "—"],
                  ["Fuel", <FuelBadge key="fuel" fuel={v.fuelType} />],
                  ["Ownership", v.ownership === "ATTACHED" ? `Attached — ${v.ownerName}` : "Owned"],
                  ["Monthly EMI", v.emiAmount ? formatINR(v.emiAmount) : "—"],
                  ["Deployed at", d.customer ? <Link className="hover:underline" href={`/customers/${d.customer.id}`}>{d.customer.name}</Link> : "Spare"],
                ]}
              />
            </CardContent>
          </Card>
          <div className="grid content-start gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Insurance, road tax, permits & PUC</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <ul className="divide-y">
                  {docs.map(([name, date, detail]) => {
                    return (
                      <li key={name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{name}</div>
                          <div className="truncate text-xs text-muted-foreground">{detail}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="num text-sm">{date ? formatDate(date) : <span className="text-muted-foreground">—</span>}</div>
                          {!date && <StatusBadge status="MISSING" label="Not recorded" tone="gray" />}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </CardContent>
            </Card>
            <VehicleDriversCard vehicle={v} drivers={d.drivers!} />
          </div>
          {finance && (
            <Card size="sm" className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Fixed & statutory costs (EMI, insurance, tax, salary)</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <DataTable
                  className="rounded-none border-x-0 border-b-0"
                  dense
                  pageSize={8}
                  data={d.fixedCosts}
                  getRowId={(r) => r.id}
                  columns={[
                    { id: "date", header: "Date", cell: (r) => (
                  <span className="inline-flex items-center gap-1.5">
                    {formatDate(r.date)}
                    <EditedBadge id={r.id} />
                  </span>
                ) },
                    { id: "cat", header: "Head", cell: (r) => categoryName(d.settings!, r.categoryCode) },
                    { id: "party", header: "Paid to", hideOnMobile: true, cell: (r) => r.partyName },
                    { id: "notes", header: "Notes", hideOnMobile: true, cell: (r) => <span className="text-muted-foreground">{r.notes}</span> },
                    { id: "amt", header: "Amount", align: "right", cell: (r) => <Money value={r.amount} /> },
                  ]}
                />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="diesel" className="mt-3 space-y-3">
          <DataTable
            data={d.diesel}
            getRowId={(r) => r.id}
            emptyMessage="No diesel fills recorded."
            pageSize={15}
            columns={[
              { id: "date", header: "Date", sortValue: (r) => r.date, cell: (r) => (
                  <span className="inline-flex items-center gap-1.5">
                    {formatDate(r.date)}
                    <EditedBadge id={r.id} />
                  </span>
                ) },
              { id: "vendor", header: "Vendor", cell: (r) => d.vendors!.get(r.vendorId)?.name ?? r.vendorId },
              { id: "bill", header: "Bill no.", hideOnMobile: true, cell: (r) => <span className="text-muted-foreground">{r.billNo}</span> },
              { id: "odo", header: "Odometer", align: "right", hideOnMobile: true, cell: (r) => (r.odometerKm === null ? "—" : formatNumber(r.odometerKm)) },
              { id: "litres", header: "Litres", align: "right", sortValue: (r) => r.litres, cell: (r) => formatNumber(r.litres, 2) },
              { id: "kmpl", header: <MileageHeader unit={unit} />, align: "right", hideOnMobile: true, cell: (r) => mileageText(d.mileage!.get(r.id) ?? null, unit) },
              { id: "rate", header: "₹/L", align: "right", hideOnMobile: true, cell: (r) => r.rate.toFixed(2) },
              { id: "amt", header: "Amount", align: "right", sortValue: (r) => r.amount, cell: (r) => <Money value={r.amount} /> },
              { id: "mode", header: "Mode", hideOnMobile: true, cell: (r) => <FillPaymentBadge entry={r} /> },
            ]}
          />
        </TabsContent>

        {/* Mounted only while open (Radix), so the Tyre data loads only when the tab is used. */}
        {can("tyres") && (
          <TabsContent value="tyres" className="mt-3">
            <VehicleTyres vehicleId={v.id} />
          </TabsContent>
        )}
      </Tabs>

    </div>
  )
}
