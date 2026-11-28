"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Pencil, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { expiryOf } from "@/domain/compliance"
import { currentDeployment, driverMatches } from "@/domain/drivers"
import { useDrivers, useVehicles } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatDate, todayISO } from "@/lib/format"
import type { Driver } from "@/lib/types"
import { DriverDialog } from "./driver-form"

type Row = Driver & { deployment: ReturnType<typeof currentDeployment> }

/** Whether this role may add / edit drivers — the API's rule (vehicles edit or settings edit). */
export const useCanEditDrivers = () => {
  const can = useCan()
  return can("vehicles", "edit") || can("settings", "edit")
}

/** DL expiry with its state: Expired (red), Expiring within 30 days (amber), or the date. */
export function LicenceExpiry({ date }: { date: string }) {
  if (!date) return <span className="text-muted-foreground">—</span>
  const { state } = expiryOf(date, todayISO())
  return (
    <span className="whitespace-nowrap">
      {formatDate(date)}
      {state === "EXPIRED" && <StatusBadge status="EXPIRED" label="Expired" className="ml-1.5" />}
      {state === "EXPIRING" && <StatusBadge status="EXPIRING" label="Expiring" className="ml-1.5" />}
    </span>
  )
}

export function DeploymentBadges({ companies }: { companies: string[] }) {
  return companies.length ? (
    <span className="inline-flex gap-1">
      {companies.map((c) => (
        <CompanyBadge key={c} code={c} />
      ))}
    </span>
  ) : (
    <span className="text-muted-foreground">Unassigned</span>
  )
}

/**
 * Operations → Drivers (owner, 27 Nov 2026): the central driver master. Search by name, DL number or phone; current
 * company and vehicle come from the vehicles the driver is assigned to (never typed on the driver).
 */
export function DriverList() {
  const can = useCan()
  const editable = useCanEditDrivers()
  const drivers = useDrivers()
  const vehicles = useVehicles()
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("ACTIVE")
  const [company, setCompany] = useState(ALL)
  const [editing, setEditing] = useState<{ driver?: Driver } | null>(null)
  const today = todayISO()

  const rows = useMemo<Row[]>(() => (drivers.data ?? []).map((d) => ({ ...d, deployment: currentDeployment(d.id, vehicles.data ?? [], today) })), [drivers.data, vehicles.data, today])
  const shown = useMemo(
    () =>
      rows
        .filter((r) => (status === ALL ? true : r.status === status))
        .filter((r) => (company === ALL ? true : company === "NONE" ? !r.deployment.companies.length : r.deployment.companies.includes(company as never)))
        .filter((r) => driverMatches(r, q))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows, status, company, q]
  )

  if (!can("vehicles")) return <NoAccess what="drivers" />
  if (!drivers.data || !vehicles.data) return <PageSkeleton />

  const columns: Column<Row>[] = [
    {
      id: "name",
      header: "Driver",
      sortValue: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/drivers/${r.id}`} className="font-medium hover:underline">
            {r.name}
          </Link>
          {r.fatherName && <div className="text-xs text-muted-foreground">S/o {r.fatherName}</div>}
        </div>
      ),
    },
    { id: "dl", header: "DL Number", sortValue: (r) => r.licenseNo, cell: (r) => (r.licenseNo ? <span className="font-mono text-xs">{r.licenseNo}</span> : <span className="text-muted-foreground">—</span>) },
    { id: "dlExpiry", header: "DL Expiry", sortValue: (r) => r.licenseValidTill || "9999", cell: (r) => <LicenceExpiry date={r.licenseValidTill} /> },
    { id: "company", header: "Current Company", sortValue: (r) => r.deployment.label, cell: (r) => <DeploymentBadges companies={r.deployment.companies} /> },
    {
      id: "vehicle",
      header: "Current Vehicle",
      sortValue: (r) => r.deployment.vehicles.map((v) => v.regNo).join(", "),
      cell: (r) => (r.deployment.vehicles.length ? r.deployment.vehicles.map((v) => v.regNo).join(", ") : <span className="text-muted-foreground">—</span>),
    },
    { id: "phone", header: "Phone", hideOnMobile: true, cell: (r) => r.phone || <span className="text-muted-foreground">—</span> },
    { id: "status", header: "Status", sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        editable ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name}`} onClick={(e) => { e.stopPropagation(); setEditing({ driver: r }) }}>
            <Pencil />
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Drivers"
        description="Every driver, once — vehicles, trips and fines refer to this record. Company deployment follows the vehicle each driver is assigned to."
        actions={
          editable && (
            <Button onClick={() => setEditing({})}>
              <Plus /> Add Driver
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <SearchBar value={q} onChange={setQ} placeholder="Name, DL number or phone…" className="md:w-72" />
        <FilterSelect value={company} onChange={setCompany} placeholder="Company" allLabel="All companies" options={[{ value: "VT", label: "VT" }, { value: "VTHPL", label: "VTHPL" }, { value: "NONE", label: "Unassigned" }]} />
        <FilterSelect value={status} onChange={setStatus} placeholder="Status" allLabel="All statuses" options={[{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }, { value: "ARCHIVED", label: "Archived" }]} />
      </div>
      <DataTable data={shown} getRowId={(r) => r.id} rowHref={(r) => `/drivers/${r.id}`} columns={columns} pageSize={50} emptyMessage="No driver matches." mobileColumns={["company", "vehicle", "dl", "status"]} />
      {editing && <DriverDialog driver={editing.driver} deployment={editing.driver ? rows.find((r) => r.id === editing.driver!.id)?.deployment.label : undefined} onClose={() => setEditing(null)} />}
    </div>
  )
}
