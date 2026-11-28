"use client"

import { useState } from "react"
import { Loader2, Pencil, Plus, UserRound, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { Field } from "@/components/shared/misc"
import { StatusBadge } from "@/components/shared/status-badge"
import { cleanLicenceNo, currentDriverIds, pastDriverPeriods, vehicleDrivers } from "@/domain/compliance"
import { useCreateDriverByName, useUpdateDriver, useVehicleDriver } from "@/lib/api/hooks"
import { driverLabel } from "@/domain/drivers"
import { useCan } from "@/lib/app-state"
import { formatDate, todayISO } from "@/lib/format"
import type { Driver, Vehicle } from "@/lib/types"

/**
 * Vehicle page → the drivers who drive this vehicle and their DL numbers (owner, 21 Nov 2026). The DL number is the
 * driver's (one record, shown on every vehicle they drive); the dated period is the vehicle's (an audited vehicle edit),
 * so who drove it when stays known after a driver leaves (Previous drivers).
 */
export function VehicleDriversCard({ vehicle, drivers }: { vehicle: Vehicle; drivers: Driver[] }) {
  const can = useCan()
  const mayEdit = can("vehicles", "edit")
  const change = useVehicleDriver()
  const today = todayISO()
  const [dialog, setDialog] = useState<{ editing: Driver | null } | null>(null)
  const [removing, setRemoving] = useState<{ driver: Driver; isDefault: boolean; since: string | null } | null>(null)
  const [lastDay, setLastDay] = useState(today)
  const list = vehicleDrivers(vehicle, drivers)
  const past = pastDriverPeriods(vehicle)
  const nameOf = new Map(drivers.map((d) => [d.id, d]))
  const addedToday = removing?.since === today // removing it undoes the add: no history kept

  const remove = async () => {
    if (!removing) return
    try {
      await change.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, driverId: removing.driver.id, date: lastDay, remove: true })
      toast.success(`${removing.driver.name} removed from ${vehicle.regNo}`)
      setRemoving(null)
    } catch {
      /* the hook shows the error; the dialog stays open */
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Drivers & DL numbers</CardTitle>
        {mayEdit && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setDialog({ editing: null })}>
              <Plus /> Add driver
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-0">
        {list.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No drivers recorded for this vehicle.{mayEdit ? " Add the drivers who drive it, with their DL numbers." : ""}</p>
        ) : (
          <ul className="divide-y">
            {list.map(({ driver: d, isDefault, since }) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                <UserRound className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {d.name}
                    {isDefault && <StatusBadge status="DEFAULT" label="Default" tone="blue" />}
                    {d.status !== "ACTIVE" && <StatusBadge status={d.status} />}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.licenseNo ? <span className="num text-foreground">DL {d.licenseNo}</span> : <span className="text-amber-700 dark:text-amber-400">DL number not recorded</span>}
                    {d.phone && ` · ${d.phone}`}
                    {` · ${since ? `since ${formatDate(since)}` : "driving since not recorded"}`}
                  </div>
                </div>
                {mayEdit && (
                  <div className="flex shrink-0 gap-0.5">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${d.name}'s DL number`} onClick={() => setDialog({ editing: d })}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${d.name} from ${vehicle.regNo}`} onClick={() => {
                        setLastDay(today)
                        setRemoving({ driver: d, isDefault, since })
                      }}
                    >
                      <X />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {past.length > 0 && (
          <details className="border-t px-4 pt-2.5 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Previous drivers ({past.length})</summary>
            <ul className="mt-1.5 space-y-1 pb-1">
              {past.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-x-3 text-xs">
                  <span>
                    <span className="font-medium">{nameOf.get(p.driverId)?.name ?? p.driverId}</span>
                    {nameOf.get(p.driverId)?.licenseNo && <span className="num text-muted-foreground"> · DL {nameOf.get(p.driverId)!.licenseNo}</span>}
                  </span>
                  <span className="num text-muted-foreground">
                    {formatDate(p.startDate)} – {formatDate(p.endDate)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>

      {dialog && <DriverDialog vehicle={vehicle} drivers={drivers} editing={dialog.editing} onClose={() => setDialog(null)} />}

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removing?.driver.name} from {vehicle.regNo}?</DialogTitle>
            <DialogDescription>
              {addedToday
                ? "They were added today, so this undoes that — no history is kept."
                : removing?.since
                  ? "Their time on this vehicle is kept under Previous drivers."
                  : "No dates were recorded for them on this vehicle."}{" "}
              The driver and their DL number stay in the driver list.
              {removing?.isDefault && " They are the default driver, so the default is cleared too."}
            </DialogDescription>
          </DialogHeader>
          {removing?.since && !addedToday && (
            <Field label="Last day driving this vehicle" required>
              <Input type="date" value={lastDay} min={removing.since} max={today} onChange={(e) => setLastDay(e.target.value)} />
            </Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button onClick={remove} disabled={change.isPending || !lastDay}>
              {change.isPending && <Loader2 className="animate-spin" />} Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Add a driver to the vehicle (an existing one, or a new name), or edit a listed driver's DL number. */
function DriverDialog({ vehicle, drivers, editing, onClose }: { vehicle: Vehicle; drivers: Driver[]; editing: Driver | null; onClose: () => void }) {
  const change = useVehicleDriver()
  const updateDriver = useUpdateDriver()
  const createDriver = useCreateDriverByName()
  const today = todayISO()
  // Drivers with an open period here. The default driver without dates can be added, to record since when.
  const listed = new Set(currentDriverIds(vehicle))
  const [since, setSince] = useState(today)
  const [driverId, setDriverId] = useState(editing?.id ?? "")
  const driver = drivers.find((d) => d.id === driverId)
  const [licence, setLicence] = useState(editing?.licenseNo ?? "")
  const [touched, setTouched] = useState(false)
  const busy = change.isPending || updateDriver.isPending
  // Another driver already holding this DL number (the API refuses it too).
  const clash = cleanLicenceNo(licence) && drivers.find((d) => d.id !== driverId && cleanLicenceNo(d.licenseNo ?? "") === cleanLicenceNo(licence))

  const pick = (id: string) => {
    setDriverId(id)
    if (!touched) setLicence(drivers.find((d) => d.id === id)?.licenseNo ?? "")
  }

  const save = async () => {
    if (!driverId || clash) return
    try {
      if (cleanLicenceNo(licence) !== (driver?.licenseNo ?? "")) await updateDriver.mutateAsync({ id: driverId, version: driver?.updatedAt, patch: { licenseNo: licence } })
      if (!editing) await change.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, driverId, date: since })
      toast.success(editing ? "DL number saved" : `${driver?.name ?? "Driver"} added to ${vehicle.regNo}`)
      onClose()
    } catch {
      /* the hook shows the error; the dialog keeps the input */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `${editing.name} — DL number` : `Add driver to ${vehicle.regNo}`}</DialogTitle>
          <DialogDescription>The DL number is saved on the driver, so it shows on every vehicle they drive.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {!editing && (
            <Field label="Driver" required>
              <CreatableSelect
                value={driverId}
                onChange={pick}
                onCreate={(name) => createDriver(name)}
                createLabel={(q) => `Create driver "${q}"`}
                placeholder="Select or type a driver's name"
                options={drivers.filter((d) => d.status !== "ARCHIVED" && !listed.has(d.id)).map((d) => ({ value: d.id, label: driverLabel(d) }))}
              />
            </Field>
          )}
          {!editing && (
            <Field label="Driving this vehicle since" required hint="Today, or the day they really started — never in the future">
              <Input type="date" value={since} max={today} onChange={(e) => setSince(e.target.value)} />
            </Field>
          )}
          <Field label="DL number" hint="Leave blank if not known yet" error={clash ? `Already recorded for ${clash.name}` : undefined}>
            <Input
              value={licence}
              onChange={(e) => {
                setLicence(e.target.value)
                setTouched(true)
              }}
              placeholder="TN70 20110001234"
              className="uppercase"
              maxLength={30}
              autoFocus={!!editing}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!driverId || !!clash || busy || (!editing && !since)}>
              {busy && <Loader2 className="animate-spin" />} {editing ? "Save" : "Add driver"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
