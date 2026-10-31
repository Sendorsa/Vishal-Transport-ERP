"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { differenceInCalendarDays, parseISO } from "date-fns"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { vehicleProfitability, type VehicleProfit } from "@/domain/analytics"
import { rangeForPreset } from "@/domain/periods"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatNumber, todayISO } from "@/lib/format"
import type { Vehicle } from "@/lib/types"

/** Earliest-expiring compliance document for a vehicle. */
export function worstCompliance(v: Vehicle, today = todayISO()) {
  const docs: [string, string][] = [
    ["Insurance", v.insurance.validTill],
    ["Road tax", v.roadTax.validTill],
    ["Fitness", v.fitnessValidTill],
    ["Permit", v.permitValidTill],
  ]
  const [doc, date] = docs.sort((a, b) => a[1].localeCompare(b[1]))[0]
  const days = differenceInCalendarDays(parseISO(date), parseISO(today))
  return { doc, date, days, state: days < 0 ? "EXPIRED" : days <= 30 ? "EXPIRING" : "VALID" }
}

type Row = VehicleProfit & { customerName: string; driverName: string; typeName: string; compliance: ReturnType<typeof worstCompliance> }

export function VehicleList() {
  const can = useCan()
  const [scope] = useCompanyScope()
  const finance = can("finance", "view")
  const { data: ds, isLoading } = useDataset()
  const [q, setQ] = useState("")
  const [type, setType] = useState(ALL)
  const [status, setStatus] = useState("ACTIVE")
  const [compliance, setCompliance] = useState(ALL)
  const [ownership, setOwnership] = useState(ALL)

  const rows = useMemo<Row[] | undefined>(() => {
    if (!ds) return undefined
    const customers = new Map(ds.customers.map((c) => [c.id, c]))
    const drivers = new Map(ds.drivers.map((d) => [d.id, d]))
    const types = new Map(ds.settings.vehicleTypes.map((t) => [t.code, t]))
    return vehicleProfitability(ds, rangeForPreset("fy_to_date")).map((p) => ({
      ...p,
      customerName: p.vehicle.assignedCustomerId ? customers.get(p.vehicle.assignedCustomerId)?.name ?? "—" : "Spare",
      driverName: p.vehicle.defaultDriverId ? drivers.get(p.vehicle.defaultDriverId)?.name ?? "—" : p.vehicle.ownership === "ATTACHED" ? "Owner's driver" : "—",
      typeName: types.get(p.vehicle.typeCode)?.name ?? p.vehicle.typeCode,
      compliance: worstCompliance(p.vehicle),
    }))
  }, [ds])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s/g, "")
    return rows?.filter((r) => {
      const v = r.vehicle
      if (type !== ALL && v.typeCode !== type) return false
      // "Active" = in service, including vehicles in the workshop.
      if (status === "ACTIVE" ? v.status !== "ACTIVE" && v.status !== "MAINTENANCE" : status !== ALL && v.status !== status) return false
      if (ownership !== ALL && v.ownership !== ownership) return false
      if (compliance !== ALL && r.compliance.state !== compliance) return false
      if (!needle) return true
      return [v.regNo, v.make, v.model, r.customerName, r.driverName].some((f) => f.toLowerCase().replace(/\s/g, "").includes(needle))
    })
  }, [rows, q, type, status, compliance, ownership])

  if (!can("vehicles")) return <NoAccess what="vehicles" />

  const columns: Column<Row>[] = [
    {
      id: "reg",
      header: "Vehicle",
      sortValue: (r) => r.vehicle.regNo,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={r.vehicle.status === "ARCHIVED" ? "font-medium text-muted-foreground" : "font-medium"}>{r.vehicle.regNo}</span>
            {r.vehicle.status === "ARCHIVED" && <span className="text-xs text-muted-foreground">(Archived)</span>}
            {ds?.tankers?.some((t) => t.vehicleId === r.vehicle.id) && <span className="text-xs text-muted-foreground">Tanker · {ds.tankers.find((t) => t.vehicleId === r.vehicle.id)!.name}</span>}
            {scope === "GROUP" && <CompanyBadge code={r.vehicle.companyCode} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {r.typeName} · {r.vehicle.make} {r.vehicle.model}
          </div>
        </div>
      ),
    },
    { id: "customer", header: "Deployed at", hideOnMobile: true, sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { id: "driver", header: "Driver", hideOnMobile: true, sortValue: (r) => r.driverName, cell: (r) => <span className="text-muted-foreground">{r.driverName}</span> },
    { id: "km", header: "Km (FY)", align: "right", hideOnMobile: true, sortValue: (r) => r.km, cell: (r) => formatNumber(r.km) },
    { id: "kmpl", header: "Kmpl", align: "right", hideOnMobile: true, sortValue: (r) => r.kmpl, cell: (r) => r.kmpl?.toFixed(2) ?? "—" },
    ...(finance
      ? ([
          { id: "contrib", header: "Contribution (FY)", align: "right", sortValue: (r) => r.contribution, cell: (r) => (r.trips ? <Money value={r.contribution} signed /> : "—") },
        ] satisfies Column<Row>[])
      : []),
    {
      id: "compliance",
      header: "Documents",
      sortValue: (r) => r.compliance.days,
      cell: (r) =>
        r.compliance.state === "VALID" ? (
          <StatusBadge status="VALID" label="All valid" />
        ) : (
          <StatusBadge status={r.compliance.state} label={`${r.compliance.doc} ${r.compliance.days < 0 ? "expired" : `${r.compliance.days}d`}`} />
        ),
    },
    {
      id: "status",
      header: "Status",
      hideOnMobile: true,
      cell: (r) => (
        <div className="flex gap-1">
          <StatusBadge status={r.vehicle.status} />
          {r.vehicle.ownership === "ATTACHED" && <StatusBadge status="ATTACHED" />}
        </div>
      ),
    },
  ]

  const canReset = q !== "" || type !== ALL || status !== "ACTIVE" || compliance !== ALL || ownership !== ALL

  return (
    <div>
      <PageHeader
        title="Vehicles"
        description="Fleet register with deployment, compliance and FY profitability."
        actions={
          can("vehicles", "create") && (
            <Button asChild>
              <Link href="/vehicles/new">
                <Plus /> Add vehicle
              </Link>
            </Button>
          )
        }
      />
      <FilterBar
        canReset={canReset}
        onReset={() => {
          setQ("")
          setType(ALL)
          setStatus("ACTIVE")
          setCompliance(ALL)
          setOwnership(ALL)
        }}
        right={filtered && `${filtered.length} vehicles`}
      >
        <SearchBar value={q} onChange={setQ} placeholder="Search reg no, customer, driver…" />
        <FilterSelect value={type} onChange={setType} placeholder="Types" options={(ds?.settings.vehicleTypes ?? []).map((t) => ({ value: t.code, label: t.name }))} />
        <FilterSelect
          value={status}
          onChange={setStatus}
          placeholder="Statuses"
          allLabel="All"
          options={[
            { value: "ACTIVE", label: "Active" },
            { value: "MAINTENANCE", label: "In workshop" },
            { value: "INACTIVE", label: "Inactive" },
            { value: "ARCHIVED", label: "Archived" },
          ]}
        />
        <FilterSelect value={ownership} onChange={setOwnership} placeholder="Ownership" allLabel="Owned + attached" options={[{ value: "OWNED", label: "Owned" }, { value: "ATTACHED", label: "Attached" }]} />
        <FilterSelect
          value={compliance}
          onChange={setCompliance}
          placeholder="Documents"
          allLabel="Any document status"
          options={[
            { value: "EXPIRED", label: "Expired" },
            { value: "EXPIRING", label: "Expiring ≤ 30 days" },
            { value: "VALID", label: "All valid" },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading}
        getRowId={(r) => r.vehicle.id}
        rowHref={(r) => `/vehicles/${r.vehicle.id}`}
        initialSort={{ id: "reg", desc: false }}
        pageSize={50}
      />
    </div>
  )
}
