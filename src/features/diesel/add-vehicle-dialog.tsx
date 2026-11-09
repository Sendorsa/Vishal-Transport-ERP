"use client"

import { useState } from "react"
import { addYears } from "date-fns"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCreateDriverByName, useCreateVehicleType, useCustomers, useDrivers, useSaveVehicle, useSettings, useTransferVehicle, useVehicleAssignments, useVehicles } from "@/lib/api/hooks"
import { FUEL_TYPES, VEHICLE_REG_REGEX } from "@/lib/constants"
import { formatDate, toISODate, todayDate, todayISO } from "@/lib/format"
import type { Customer, NewEntity, Vehicle } from "@/lib/types"

const NONE = "__none__"

/**
 * Puts a vehicle under a customer — pick an existing fleet vehicle or register a new one —
 * or, with `vehicle`, edits that vehicle using the same form. Mount with `key={vehicle.id}` when editing.
 */
export function AddVehicleDialog({ open, onOpenChange, customer, vehicle }: { open: boolean; onOpenChange: (o: boolean) => void; customer: Customer; vehicle?: Vehicle }) {
  const vehicles = useVehicles()
  const customers = useCustomers()
  const drivers = useDrivers()
  const settings = useSettings()
  const save = useSaveVehicle()
  const transfer = useTransferVehicle()
  const assignments = useVehicleAssignments()
  /** "Assigned since" (owner, 3 Nov 2026): when the vehicle started working for the customer — back-dated at go-live. */
  const [since, setSince] = useState(todayISO())
  const createType = useCreateVehicleType()
  const createDriver = useCreateDriverByName()
  const [mode, setMode] = useState<"existing" | "new">(vehicle ? "new" : "existing")
  const [vehicleId, setVehicleId] = useState("")
  const blank = {
    regNo: vehicle?.regNo ?? "",
    typeCode: vehicle?.typeCode ?? "BUS_41",
    mileage: vehicle ? String(vehicle.mileageKmpl) : "",
    driverId: vehicle?.defaultDriverId ?? NONE,
    customerId: vehicle ? (vehicle.assignedCustomerId ?? NONE) : customer.id,
    notes: vehicle?.notes ?? "",
    fuelType: vehicle?.fuelType ?? "DIESEL",
  }
  const [n, setN] = useState(blank)
  const [error, setError] = useState<string | null>(null)

  const all = vehicles.data ?? []
  const customerName = new Map((customers.data ?? []).map((c) => [c.id, c.shortName || c.name]))
  const type = settings.data?.vehicleTypes.find((t) => t.code === n.typeCode)

  const close = () => {
    setVehicleId("")
    setN(blank)
    setError(null)
    onOpenChange(false)
  }

  const submit = async () => {
    setError(null)
    if (mode === "existing") {
      const v = all.find((x) => x.id === vehicleId)
      if (!v) return setError("Choose a vehicle")
      const firstAssignment = !(assignments.data ?? []).some((a) => a.vehicleId === v.id)
      if (since !== todayISO() && firstAssignment) {
        // A spare vehicle's first assignment may start in the past ("Assigned since"); a dated transfer records it.
        if (v.status === "INACTIVE") await save.mutateAsync({ id: v.id, version: v.updatedAt, data: { status: "ACTIVE" } })
        await transfer.mutateAsync({ id: v.id, customerId: customer.id, effectiveDate: since })
        toast.success(`${v.regNo} with ${customer.shortName} since ${formatDate(since)}`)
        return close()
      }
      // Assigning an inactive vehicle brings it back into service (archived ones must be restored first).
      await save.mutateAsync({
        id: v.id, version: v.updatedAt,
        data: {
          assignedCustomerId: customer.id,
          ...(v.status === "INACTIVE" ? { status: "ACTIVE" as const } : {}),
        },
      })
      toast.success(`${v.regNo} now deployed at ${customer.shortName}`)
      return close()
    }
    const regNo = n.regNo.toUpperCase().replace(/[\s-]/g, "")
    if (!VEHICLE_REG_REGEX.test(regNo)) return setError("Registration like TN70AL9834")
    if (all.some((v) => v.regNo === regNo && v.id !== vehicle?.id)) return setError(`${regNo} already exists${vehicle ? "" : " — pick it under “Existing vehicle”"}`)
    const assignedCustomerId = n.customerId === NONE ? null : n.customerId
    const details = {
      regNo,
      typeCode: n.typeCode,
      mileageKmpl: Number(n.mileage) || type?.defaultMileage || 5,
      defaultDriverId: n.driverId === NONE ? null : n.driverId,
      assignedCustomerId,
      notes: n.notes.trim(),
      fuelType: n.fuelType as Vehicle["fuelType"],
    }

    if (vehicle) {
      await save.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, data: details })
      toast.success(`${regNo} updated`)
      return close()
    }
    const nextYear = toISODate(addYears(todayDate(), 1))
    const owner = (customers.data ?? []).find((c) => c.id === assignedCustomerId) ?? customer
    const data: NewEntity<Vehicle> = {
      ...details,
      companyCode: owner.companyCode,
      make: "",
      model: type?.name ?? n.typeCode,
      year: todayDate().getFullYear(),
      seats: type?.defaultSeats ?? null,
      ownership: "OWNED",
      ownerName: null,
      status: "ACTIVE",
      odometerKm: 0,
      // Placeholders until documents are entered under Vehicles.
      insurance: {
        provider: "",
        policyNo: "",
        validTill: nextYear,
        premium: 0,
      },
      roadTax: { validTill: nextYear, amount: 0, period: "ANNUAL" },
      fitnessValidTill: nextYear,
      permitValidTill: nextYear,
      emiAmount: 0,
    }
    await save.mutateAsync({ data: assignedCustomerId ? { ...data, assignedSince: since } : data })
    toast.success(`${regNo} added${assignedCustomerId ? ` to ${customerName.get(assignedCustomerId) ?? customer.shortName}` : ""}`)
    close()
  }

  return (
    <FormModal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={vehicle ? `Edit ${vehicle.regNo}` : `Add vehicle to ${customer.shortName}`}
      description={vehicle ? "Changes apply everywhere this vehicle appears." : "Vehicles deployed with this customer appear in its monthly diesel view."}
      submitLabel={vehicle ? "Save changes" : mode === "existing" ? "Assign vehicle" : "Add vehicle"}
      pending={save.isPending || transfer.isPending}
      onSubmit={submit}
    >
      {!vehicle && (
        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="existing">Existing vehicle</TabsTrigger>
            <TabsTrigger value="new">New vehicle</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {mode === "existing" ? (
        <Field label="Vehicle" required error={error ?? undefined} hint={`${all.length} vehicles in the system · moving a vehicle changes where its future fills are costed`}>
          {/* Every vehicle in storage — select only; new vehicles go through “New vehicle”. */}
          <CreatableSelect
            value={vehicleId}
            onChange={setVehicleId}
            placeholder="Search registration no."
            options={all
              .filter((v) => v.status !== "ARCHIVED") // archived vehicles are history only — restore first
              .sort((a, b) => a.regNo.localeCompare(b.regNo))
              .map((v) => ({
                value: v.id,
                disabled: v.assignedCustomerId === customer.id,
                label: `${v.regNo} — ${
                  v.assignedCustomerId === customer.id
                    ? `already with ${customer.shortName}`
                    : v.assignedCustomerId
                      ? `at ${customerName.get(v.assignedCustomerId) ?? "another customer"}`
                      : v.status === "INACTIVE"
                        ? "inactive"
                        : "spare"
                }`,
              }))}
          />
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Registration no." required error={error ?? undefined}>
            <Input value={n.regNo} onChange={(e) => setN({ ...n, regNo: e.target.value })} placeholder="TN70AL9834" className="uppercase" autoFocus />
          </Field>
          <Field label="Vehicle type" required>
            <CreatableSelect
              value={n.typeCode}
              onChange={(v) => setN((cur) => ({ ...cur, typeCode: v }))}
              options={(settings.data?.vehicleTypes ?? []).map((t) => ({
                value: t.code,
                label: t.name,
              }))}
              onCreate={(name) => createType(name, Number(n.mileage) || undefined)}
              placeholder="Select vehicle type"
            />
          </Field>
          <Field label="Driver">
            <CreatableSelect
              value={n.driverId}
              onChange={(v) => setN((cur) => ({ ...cur, driverId: v }))}
              options={[{ value: NONE, label: "None / later" }, ...(drivers.data ?? []).filter((d) => d.status === "ACTIVE").map((d) => ({ value: d.id, label: d.name }))]}
              onCreate={(name) => createDriver(name, customer.companyCode)}
              createLabel={(q) => `Create driver "${q}"`}
              placeholder="Select driver"
            />
          </Field>
          <Field label="Customer" hint={vehicle ? "Changing it transfers the vehicle from today. To choose the day it started, use ⋮ → Transfer Vehicle." : undefined}>
            <SimpleSelect
              value={n.customerId}
              onChange={(v) => setN((cur) => ({ ...cur, customerId: v }))}
              options={[{ value: NONE, label: "Spare / unassigned" }, ...(customers.data ?? []).filter((c) => c.status === "ACTIVE").map((c) => ({ value: c.id, label: c.shortName || c.name }))]}
            />
          </Field>
          <Field label="Fuel type" required hint="Fuel entries for this vehicle use this">
            <SimpleSelect value={n.fuelType} onChange={(v) => setN((cur) => ({ ...cur, fuelType: v as Vehicle["fuelType"] }))} options={FUEL_TYPES} />
          </Field>
          <Field label={n.fuelType === "EV" ? "Rated mileage (km/kWh)" : "Rated mileage (km/L)"} hint="The mileage this vehicle is expected to give">
            <Input type="number" step="0.1" value={n.mileage} placeholder={String(type?.defaultMileage ?? "")} onChange={(e) => setN({ ...n, mileage: e.target.value })} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={n.notes} onChange={(e) => setN({ ...n, notes: e.target.value })} placeholder="Route, shift, anything useful" />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">Insurance, road tax and other documents are under Vehicles → vehicle record.</p>
        </div>
      )}
      {!vehicle && (mode === "new" ? n.customerId !== NONE : !!vehicleId && !(assignments.data ?? []).some((a) => a.vehicleId === vehicleId)) && (
        <Field label="Assigned since" required hint="The day it started working for this customer — entries from then on are costed to it. Back-date it for go-live.">
          <Input type="date" value={since} max={todayISO()} onChange={(e) => setSince(e.target.value || todayISO())} />
        </Field>
      )}
    </FormModal>
  )
}
