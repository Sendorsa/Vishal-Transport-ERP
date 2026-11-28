"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AlertTriangle, ArrowLeft, Loader2, Pencil, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { DataTable } from "@/components/shared/data-table"
import { EmptyState, Field, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { companyOn, currentDeployment, driverDeployments, driverVehicleHistory } from "@/domain/drivers"
import { useDrivers, useVehicleDriver, useVehicles } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatDate, todayISO } from "@/lib/format"
import type { Vehicle } from "@/lib/types"
import { DriverDialog } from "./driver-form"
import { DeploymentBadges, LicenceExpiry, useCanEditDrivers } from "./driver-list"

const until = (d: string | null) => (d ? formatDate(d) : <span className="font-medium text-emerald-700 dark:text-emerald-400">Present</span>)

/** One driver (Operations → Drivers → driver): details, current deployment, company and vehicle history, assignments. */
export function DriverDetail({ id }: { id: string }) {
  const can = useCan()
  const editable = useCanEditDrivers()
  const drivers = useDrivers()
  const vehicles = useVehicles()
  const [editing, setEditing] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [ending, setEnding] = useState<Vehicle | null>(null)
  const today = todayISO()
  const driver = drivers.data?.find((d) => d.id === id)
  const vs = useMemo(() => vehicles.data ?? [], [vehicles.data])
  const now = useMemo(() => currentDeployment(id, vs, today), [id, vs, today])
  const deployments = useMemo(() => driverDeployments(id, vs, today).reverse(), [id, vs, today])
  const history = useMemo(() => driverVehicleHistory(id, vs), [id, vs])
  // Default driver of a vehicle with no dated period: current, but its start date was never recorded.
  const undated = vs.filter((v) => v.defaultDriverId === id && !(v.driverPeriods ?? []).some((p) => p.driverId === id))

  if (!can("vehicles")) return <NoAccess what="drivers" />
  if (!drivers.data || !vehicles.data) return <PageSkeleton />
  if (!driver) return <EmptyState title="Driver not found" description="It may have been removed from this browser's data." action={<Button asChild variant="outline"><Link href="/drivers">Back to Drivers</Link></Button>} />

  const details: [string, React.ReactNode][] = [
    ["Father's Name", driver.fatherName || "—"],
    ["Date of Birth", driver.dateOfBirth ? formatDate(driver.dateOfBirth) : "—"],
    ["Phone Number", driver.phone || "—"],
    ["DL Number", driver.licenseNo ? <span className="font-mono">{driver.licenseNo}</span> : "—"],
    ["DL Expiry Date", <LicenceExpiry key="exp" date={driver.licenseValidTill} />],
    ["Address", driver.address || "—"],
  ]

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link href="/drivers">
          <ArrowLeft /> Drivers
        </Link>
      </Button>
      <PageHeader
        title={driver.name}
        meta={<StatusBadge status={driver.status} />}
        actions={
          editable && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit Driver
            </Button>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Driver details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {details.map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-sm break-words">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Current company</CardTitle>
            <CardDescription>From the vehicle{now.vehicles.length === 1 ? "" : "s"} the driver drives today.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <DeploymentBadges companies={now.companies} />
            {now.vehicles.length > 0 && <p className="text-muted-foreground">{now.vehicles.map((v) => `${v.regNo} (${companyOn(v, today)})`).join(", ")}</p>}
            {now.companies.length > 1 && <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />Drives vehicles of both companies at once — check the vehicle assignments.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Company deployment history</CardTitle>
          <CardDescription>From the driver&apos;s dated vehicle assignments and each vehicle&apos;s company on those dates. A change of vehicle within one company is one deployment.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            data={deployments}
            getRowId={(r) => `${r.companyCode}-${r.startDate}`}
            dense
            emptyMessage={undated.length ? "No dated assignment yet — the vehicle below names this driver without a start date." : "No vehicle assignment recorded."}
            columns={[
              { id: "c", header: "Company", cell: (r) => (
                <span className="inline-flex items-center gap-1.5">
                  <CompanyBadge code={r.companyCode} />
                  {r.overlaps && <span title="Another company's deployment covers some of the same days"><AlertTriangle className="size-3.5 text-amber-600" /></span>}
                </span>
              ) },
              { id: "f", header: "From Date", cell: (r) => formatDate(r.startDate) },
              { id: "t", header: "To Date", cell: (r) => until(r.endDate) },
              { id: "v", header: "Vehicles", cell: (r) => r.vehicles.join(", ") },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vehicle assignment history</CardTitle>
          <CardDescription>Every vehicle this driver has driven, with dates. Ending an assignment keeps it here.</CardDescription>
          {can("vehicles", "edit") && driver.status !== "ARCHIVED" && (
            <CardAction>
              <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
                <Plus /> Assign to vehicle
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            data={[...undated.map((v) => ({ key: `default-${v.id}`, vehicle: v, startDate: null as string | null, endDate: null as string | null })), ...history.map((h) => ({ key: h.periodId, ...h }))]}
            getRowId={(r) => r.key}
            dense
            emptyMessage="No vehicle assignment recorded."
            columns={[
              { id: "v", header: "Vehicle", cell: (r) => <Link href={`/vehicles/${r.vehicle.id}`} className="font-medium hover:underline">{r.vehicle.regNo}</Link> },
              { id: "c", header: "Company", cell: (r) => <CompanyBadge code={companyOn(r.vehicle, r.endDate ?? today)} /> },
              { id: "f", header: "From Date", cell: (r) => (r.startDate ? formatDate(r.startDate) : <span className="text-muted-foreground">Not recorded (default driver)</span>) },
              { id: "t", header: "To Date", cell: (r) => until(r.endDate) },
              {
                id: "a",
                header: "",
                align: "right",
                cell: (r) =>
                  can("vehicles", "edit") && r.endDate === null ? (
                    <Button variant="ghost" size="sm" onClick={() => setEnding(r.vehicle)}>
                      End
                    </Button>
                  ) : null,
              },
            ]}
          />
        </CardContent>
      </Card>

      {editing && <DriverDialog driver={driver} deployment={now.label} onClose={() => setEditing(false)} />}
      {assigning && <AssignDialog driverId={id} driverName={driver.name} vehicles={vs} onClose={() => setAssigning(false)} />}
      {ending && <EndDialog driverId={id} driverName={driver.name} vehicle={ending} onClose={() => setEnding(null)} />}
    </div>
  )
}

/** The driver starts driving a vehicle from a date (the vehicle's dated driver periods — the same as the vehicle page's Add driver). */
function AssignDialog({ driverId, driverName, vehicles, onClose }: { driverId: string; driverName: string; vehicles: Vehicle[]; onClose: () => void }) {
  const assign = useVehicleDriver()
  const [vehicleId, setVehicleId] = useState("")
  const [since, setSince] = useState(todayISO())
  const options = vehicles
    .filter((v) => v.status !== "ARCHIVED" && !(v.driverPeriods ?? []).some((p) => p.driverId === driverId && p.endDate === null))
    .sort((a, b) => a.regNo.localeCompare(b.regNo))
    .map((v) => ({ value: v.id, label: `${v.regNo} · ${v.companyCode}` }))
  const vehicle = vehicles.find((v) => v.id === vehicleId)
  return (
    <Dialog open onOpenChange={(o) => !o && !assign.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign {driverName} to a vehicle</DialogTitle>
          <DialogDescription>The company deployment follows the vehicle&apos;s company from this date.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Vehicle" required>
            <CreatableSelect value={vehicleId} onChange={setVehicleId} options={options} placeholder="Search registration" />
          </Field>
          <Field label="Driving since" required hint={vehicle ? `Company on that date: ${companyOn(vehicle, since || todayISO())}` : undefined}>
            <Input type="date" value={since} max={todayISO()} onChange={(e) => setSince(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={assign.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!vehicle || !since || assign.isPending}
            onClick={async () => {
              try {
                await assign.mutateAsync({ id: vehicle!.id, version: vehicle!.updatedAt, driverId, date: since })
                toast.success(`${driverName} assigned to ${vehicle!.regNo}`)
                onClose()
              } catch {
                /* the hook shows why */
              }
            }}
          >
            {assign.isPending && <Loader2 className="animate-spin" />} Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The driver stops driving a vehicle: their last day on it (kept as history). */
function EndDialog({ driverId, driverName, vehicle, onClose }: { driverId: string; driverName: string; vehicle: Vehicle; onClose: () => void }) {
  const end = useVehicleDriver()
  const [lastDay, setLastDay] = useState(todayISO())
  return (
    <Dialog open onOpenChange={(o) => !o && !end.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            End {driverName} on {vehicle.regNo}
          </DialogTitle>
          <DialogDescription>The assignment is kept in the history with this last day. An assignment started today is removed instead.</DialogDescription>
        </DialogHeader>
        <Field label="Last day on this vehicle" required>
          <Input type="date" value={lastDay} max={todayISO()} onChange={(e) => setLastDay(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" disabled={end.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!lastDay || end.isPending}
            onClick={async () => {
              try {
                await end.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, driverId, date: lastDay, remove: true })
                toast.success(`${driverName} no longer on ${vehicle.regNo}`)
                onClose()
              } catch {
                /* the hook shows why */
              }
            }}
          >
            {end.isPending && <Loader2 className="animate-spin" />} End assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
