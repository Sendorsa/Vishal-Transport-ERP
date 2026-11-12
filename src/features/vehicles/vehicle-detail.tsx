"use client"

import { EditedBadge, HistoryButton } from "@/components/shared/audit"
import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { endOfMonth, parseISO } from "date-fns"
import { Bus, Fuel, Pencil, Plus, Wrench } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ChartCard } from "@/components/shared/chart-card"
import { DataTable } from "@/components/shared/data-table"
import { DetailList } from "@/components/shared/entity-drawer"
import { FormModal } from "@/components/shared/form-modal"
import { EmptyState, Field, Money, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { FillPaymentBadge, MileageHeader, mileageText } from "@/features/diesel/parts"
import { buildDieselIndex, fillRow } from "@/domain/diesel"
import { categoryName, complianceAlerts, vehicleProfitability } from "@/domain/analytics"
import { monthKeysInRange, rangeForPreset } from "@/domain/periods"
import { useCreatePayment, useDataset } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatINR, formatDate, formatMonthKey, formatNumber, formatPercent, toISODate, todayISO } from "@/lib/format"
import { VehicleForm } from "./vehicle-form"
import { worstCompliance } from "./vehicle-list"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { inrTick } from "@/components/shared/misc"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { fuelName } from "@/domain/expenditure"

const MAINT = new Set(["MAINTENANCE", "TYRE"])

export function VehicleDetail({ id }: { id: string }) {
  const can = useCan()
  const finance = can("finance", "view")
  const { data: ds, isLoading } = useDataset()
  const [editing, setEditing] = useState(false)
  const [maintOpen, setMaintOpen] = useState(false)
  const today = todayISO()

  const d = useMemo(() => {
    if (!ds) return null
    const vehicle = ds.vehicles.find((v) => v.id === id)
    if (!vehicle) return { vehicle: null }
    const fy = rangeForPreset("fy_to_date")
    const profit = vehicleProfitability(ds, fy).find((p) => p.vehicle.id === id)!
    const months = monthKeysInRange(rangeForPreset("last_6_months"), 6)
    const monthly = months.map((m) => {
      const r = { from: `${m}-01`, to: toISODate(endOfMonth(parseISO(`${m}-01`))) }
      const p = vehicleProfitability({ ...ds, vehicles: [vehicle] }, r)[0]
      return { month: m, label: formatMonthKey(m), revenue: p.revenue, cost: p.totalCost, contribution: p.contribution, km: p.km, litres: p.litres, kmpl: p.kmpl }
    })
    const diesel = inEntryOrder(ds.diesel.filter((e) => e.vehicleId === id))
    // KM since last fill and mileage per fill, from this vehicle's own readings (the Diesel module's fillRow).
    const fillIdx = buildDieselIndex({ ...ds, diesel, trips: [] })
    const mileage = new Map(diesel.map((e) => [e.id, fillRow(fillIdx, e).kmpl]))
    const payments = ds.payments.filter((p) => p.vehicleId === id && p.direction === "OUT")
    return {
      vehicle,
      profit,
      monthly,
      diesel,
      mileage,
      maintenance: inEntryOrder(payments.filter((p) => MAINT.has(p.categoryCode ?? ""))),
      fixedCosts: inEntryOrder(payments.filter((p) => !MAINT.has(p.categoryCode ?? ""))),
      trips: ds.trips.filter((t) => t.vehicleId === id),
      customer: ds.customers.find((c) => c.id === vehicle.assignedCustomerId),
      driver: ds.drivers.find((x) => x.id === vehicle.defaultDriverId),
      type: ds.settings.vehicleTypes.find((t) => t.code === vehicle.typeCode),
      vendors: new Map(ds.fuelStations.map((v) => [v.id, v])),
      customers: new Map(ds.customers.map((c) => [c.id, c])),
      alerts: complianceAlerts({ ...ds, vehicles: [vehicle] }, today, 30),
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

  const p = d.profit!
  const worst = worstCompliance(v, today)
  const maintTotal = d.maintenance!.reduce((s, x) => s + x.amount, 0)
  const docs: [string, string, string][] = [
    ["Insurance", v.insurance.validTill, `${v.insurance.provider} · ${v.insurance.policyNo} · premium ${formatINR(v.insurance.premium)}`],
    ["Road tax", v.roadTax.validTill, `${v.roadTax.period === "QUARTERLY" ? "Quarterly" : "Annual"} · ${formatINR(v.roadTax.amount)}`],
    ["Fitness (FC)", v.fitnessValidTill, "RTO fitness certificate"],
    ["Permit", v.permitValidTill, v.typeCode.startsWith("TRUCK") || v.typeCode === "PICKUP" ? "Goods carriage permit" : "Contract carriage permit"],
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        backHref="/vehicles"
        backLabel="Vehicles"
        title={v.regNo}
        meta={
          <>
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
            {can("diesel") && d.customer && (
              <Button variant="outline" asChild>
                <Link href={`/diesel/${d.customer.code.toLowerCase()}/${todayISO().slice(0, 7)}/${v.regNo}`}>
                  <Fuel /> {fuelName(v.fuelType)}
                </Link>
              </Button>
            )}
            {can("vehicles", "edit") && (
              <Button onClick={() => setMaintOpen(true)}>
                <Wrench /> Log maintenance
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {finance && <StatsCard label="Revenue (FY)" value={formatINR(p.revenue)} hint={`${formatNumber(p.trips)} trips`} />}
        {finance && (
          <StatsCard label="Contribution (FY)" value={formatINR(p.contribution)} tone={p.contribution < 0 ? "negative" : "positive"} hint={`Margin ${formatPercent(p.margin)}`} />
        )}
        <StatsCard label="Km (FY)" value={formatNumber(p.km)} hint={`Odometer ${formatNumber(v.odometerKm)} km`} />
        <StatsCard
          label="Mileage"
          value={p.kmpl ? `${p.kmpl.toFixed(2)} kmpl` : "—"}
          hint={`Expected ${v.mileageKmpl} kmpl`}
          tone={p.kmpl && p.kmpl < v.mileageKmpl * 0.92 ? "warning" : "default"}
        />
        <StatsCard
          label="Documents"
          value={worst.state === "VALID" ? "All valid" : worst.doc}
          hint={worst.state === "VALID" ? `Next: ${worst.doc} ${formatDate(worst.date)}` : worst.days < 0 ? `Expired ${-worst.days} days ago` : `Expires in ${worst.days} days`}
          tone={worst.state === "EXPIRED" ? "negative" : worst.state === "EXPIRING" ? "warning" : "default"}
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance ({d.maintenance!.length})</TabsTrigger>
          <TabsTrigger value="diesel">{fuelName(v.fuelType)} ({d.diesel!.length})</TabsTrigger>
          {finance && <TabsTrigger value="profitability">Profitability</TabsTrigger>}
          <TabsTrigger value="trips">Trips</TabsTrigger>
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
                  ["Default driver", d.driver ? `${d.driver.name} · ${d.driver.phone}` : "—"],
                ]}
              />
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Insurance, road tax & permits</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y">
                {docs.map(([name, date, detail]) => {
                  const days = Math.round((parseISO(date).getTime() - parseISO(today).getTime()) / 86400000)
                  return (
                    <li key={name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{name}</div>
                        <div className="truncate text-xs text-muted-foreground">{detail}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-sm">{formatDate(date)}</div>
                        <StatusBadge
                          status={days < 0 ? "EXPIRED" : days <= 30 ? "EXPIRING" : "VALID"}
                          label={days < 0 ? `Expired ${-days}d` : days <= 30 ? `${days}d left` : "Valid"}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>
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

        <TabsContent value="maintenance" className="mt-3 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {d.maintenance!.length} jobs · total <b className="num text-foreground">{formatINR(maintTotal)}</b>
            </span>
            {can("vehicles", "edit") && (
              <Button size="sm" variant="outline" onClick={() => setMaintOpen(true)}>
                <Plus /> Log maintenance
              </Button>
            )}
          </div>
          <DataTable
            data={d.maintenance}
            getRowId={(r) => r.id}
            emptyMessage="No maintenance recorded."
            columns={[
              { id: "date", header: "Date", sortValue: (r) => r.date, cell: (r) => (
                  <span className="inline-flex items-center gap-1.5">
                    {formatDate(r.date)}
                    <EditedBadge id={r.id} />
                  </span>
                ) },
              { id: "type", header: "Type", cell: (r) => categoryName(d.settings!, r.categoryCode) },
              { id: "work", header: "Work done", cell: (r) => r.notes },
              { id: "vendor", header: "Workshop / vendor", hideOnMobile: true, cell: (r) => <span className="text-muted-foreground">{r.partyName}</span> },
              { id: "mode", header: "Mode", hideOnMobile: true, cell: (r) => r.mode },
              { id: "amt", header: "Amount", align: "right", sortValue: (r) => r.amount, cell: (r) => <Money value={r.amount} /> },
            ]}
          />
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

        <TabsContent value="profitability" className="mt-3 space-y-3">
          <ChartCard title="Monthly contribution" description="Trip revenue vs vehicle costs (diesel, driver, EMI, insurance, tax, maintenance)">
            <ContributionChart data={d.monthly!} />
          </ChartCard>
          <DataTable
            data={[...d.monthly!].reverse()}
            getRowId={(r) => r.month}
            showFooter
            columns={[
              { id: "m", header: "Month", cell: (r) => r.label, footer: "FY to date" },
              { id: "km", header: "Km", align: "right", cell: (r) => formatNumber(r.km), footer: formatNumber(p.km) },
              { id: "kmpl", header: "Kmpl", align: "right", hideOnMobile: true, cell: (r) => r.kmpl?.toFixed(2) ?? "—", footer: p.kmpl?.toFixed(2) ?? "—" },
              { id: "rev", header: "Revenue", align: "right", cell: (r) => <Money value={r.revenue} />, footer: <Money value={p.revenue} /> },
              { id: "cost", header: "Cost", align: "right", cell: (r) => <Money value={r.cost} />, footer: <Money value={p.totalCost} /> },
              { id: "c", header: "Contribution", align: "right", cell: (r) => <Money value={r.contribution} signed />, footer: <Money value={p.contribution} signed /> },
            ]}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {(
              [
                [fuelName(v.fuelType), p.diesel],
                ["Driver", p.driver],
                ["Maintenance & tyres", p.maintenance],
                ["EMI / insurance / tax / hire", p.fixed],
                ["Cost per km", p.costPerKm ?? 0],
              ] as [string, number][]
            ).map(([label, value]) => (
              <Card key={label} size="sm" className="gap-1 px-4">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="num font-semibold">{label === "Cost per km" ? formatINR(value) : formatINR(value)}</span>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="trips" className="mt-3">
          <DataTable
            data={d.trips}
            getRowId={(t) => t.id}
            rowHref={(t) => `/trips/${t.id}`}
            initialSort={{ id: "date", desc: true }}
            pageSize={20}
            columns={[
              { id: "date", header: "Date", sortValue: (t) => t.date, cell: (t) => (
                  <span className="inline-flex items-center gap-1.5">
                    {formatDate(t.date)}
                    <EditedBadge id={t.id} />
                  </span>
                ) },
              { id: "no", header: "Trip", hideOnMobile: true, cell: (t) => t.tripNo },
              { id: "cust", header: "Customer", cell: (t) => d.customers!.get(t.customerId)?.name },
              { id: "route", header: "Route", hideOnMobile: true, cell: (t) => <span className="text-muted-foreground">{t.route}</span> },
              { id: "km", header: "Km", align: "right", sortValue: (t) => t.distanceKm, cell: (t) => formatNumber(t.distanceKm) },
              ...(finance ? [{ id: "rev", header: "Revenue", align: "right" as const, cell: (t: (typeof d.trips)[number]) => <Money value={t.revenue} /> }] : []),
            ]}
          />
        </TabsContent>
      </Tabs>

      <MaintenanceModal open={maintOpen} onOpenChange={setMaintOpen} vehicleId={v.id} companyCode={v.companyCode} regNo={v.regNo} />
    </div>
  )
}

function ContributionChart({ data }: { data: { label: string; revenue: number; cost: number }[] }) {
  return (
    <ChartContainer
      config={{ revenue: { label: "Revenue", color: "var(--chart-1)" }, cost: { label: "Cost", color: "var(--chart-5)" } }}
      className="aspect-auto h-[240px] w-full"
    >
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={formatINR} />} />
        <Bar isAnimationActive={false} dataKey="revenue" fill="var(--color-revenue)" radius={4} />
        <Bar isAnimationActive={false} dataKey="cost" fill="var(--color-cost)" radius={4} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

function MaintenanceModal({
  open,
  onOpenChange,
  vehicleId,
  companyCode,
  regNo,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  vehicleId: string
  companyCode: "VT" | "VTHPL"
  regNo: string
}) {
  const create = useCreatePayment()
  const [form, setForm] = useState({ date: todayISO(), category: "MAINTENANCE", vendor: "", work: "", amount: "", mode: "NEFT" })
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const amount = Number(form.amount)
  const valid = form.vendor.trim() && form.work.trim() && amount > 0

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Log maintenance — ${regNo}`}
      description="Recorded as a vehicle-linked expense payment."
      pending={create.isPending}
      submitLabel="Save"
      onSubmit={async () => {
        if (!valid) {
          toast.error("Fill workshop, work done and amount")
          return
        }
        await create.mutateAsync({
          companyCode,
          direction: "OUT",
          date: form.date,
          partyType: "VENDOR",
          customerId: null,
          vendorId: null,
          vehicleId,
          partyName: form.vendor.trim(),
          categoryCode: form.category,
          amount,
          tdsAmount: 0,
          mode: form.mode as "NEFT",
          reference: "",
          allocations: [],
          notes: form.work.trim(),
        })
        toast.success("Maintenance logged")
        setForm({ date: todayISO(), category: "MAINTENANCE", vendor: "", work: "", amount: "", mode: "NEFT" })
        onOpenChange(false)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" required>
          <Input type="date" value={form.date} onChange={(e) => set("date")(e.target.value)} />
        </Field>
        <Field label="Type" required>
          <SimpleSelect value={form.category} onChange={set("category")} options={[{ value: "MAINTENANCE", label: "Maintenance & repairs" }, { value: "TYRE", label: "Tyres" }]} />
        </Field>
        <Field label="Workshop / vendor" required className="sm:col-span-2">
          <Input value={form.vendor} onChange={(e) => set("vendor")(e.target.value)} placeholder="Ashok Leyland Service — Hosur" />
        </Field>
        <Field label="Work done" required className="sm:col-span-2">
          <Textarea value={form.work} onChange={(e) => set("work")(e.target.value)} rows={2} placeholder="Clutch overhaul, brake liner" />
        </Field>
        <Field label="Amount (₹)" required>
          <Input type="number" value={form.amount} onChange={(e) => set("amount")(e.target.value)} />
        </Field>
        <Field label="Payment mode">
          <SimpleSelect value={form.mode} onChange={set("mode")} options={["NEFT", "UPI", "CHEQUE", "CASH"].map((m) => ({ value: m, label: m }))} />
        </Field>
      </div>
    </FormModal>
  )
}
