"use client"

import { useState } from "react"
import { addDays, format, parseISO } from "date-fns"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCustomers, useTransferVehicle, useVehicleAssignments } from "@/lib/api/hooks"
import { formatDate, todayISO } from "@/lib/format"
import type { Vehicle } from "@/lib/types"

/** Moves a vehicle to another customer from an effective date. Earlier months keep the old customer. */
export function TransferVehicleDialog({ vehicle, onOpenChange }: { vehicle: Vehicle; onOpenChange: (o: boolean) => void }) {
  const customers = useCustomers()
  const assignments = useVehicleAssignments()
  const transfer = useTransferVehicle()
  const today = todayISO()
  const [to, setTo] = useState("")
  const [date, setDate] = useState(today)
  const [error, setError] = useState<string | null>(null)

  const names = new Map((customers.data ?? []).map((c) => [c.id, c.shortName || c.name]))
  const current = (assignments.data ?? []).filter((a) => a.vehicleId === vehicle.id && a.endDate === null).at(-1)
  const fromId = vehicle.assignedCustomerId
  // The new assignment must start after the current one did — never rewrite an earlier period.
  const minDate = current ? format(addDays(parseISO(current.startDate), 1), "yyyy-MM-dd") : undefined

  const submit = async () => {
    setError(null)
    if (!to) return setError("Choose the new customer")
    if (!date || date > today || (minDate && date < minDate)) return setError(minDate ? `Pick a date from ${formatDate(minDate)} to today` : "Pick a date up to today")
    await transfer.mutateAsync({ id: vehicle.id, customerId: to, effectiveDate: date })
    toast.success(`${vehicle.regNo} transferred to ${names.get(to)} from ${formatDate(date)}`)
    onOpenChange(false)
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title="Transfer Vehicle"
      description={`${vehicle.regNo} · entries from the effective date move to the new customer; earlier months stay with the old one.`}
      submitLabel="Transfer vehicle"
      pending={transfer.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current customer">
          <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
            {fromId ? names.get(fromId) : "None (spare)"}
            {current && <span className="ml-auto text-xs text-muted-foreground">since {formatDate(current.startDate)}</span>}
          </div>
        </Field>
        <Field label="New customer" required error={error && !to ? error : undefined}>
          <SimpleSelect
            value={to}
            onChange={setTo}
            placeholder="Select customer"
            options={(customers.data ?? [])
              .filter((c) => c.status === "ACTIVE" && c.id !== fromId)
              .sort((a, b) => (a.shortName || a.name).localeCompare(b.shortName || b.name))
              .map((c) => ({ value: c.id, label: c.shortName || c.name }))}
          />
        </Field>
        <Field label="Effective date" required error={error && to ? error : undefined} hint="First day the vehicle works for the new customer">
          <Input type="date" value={date} min={minDate} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </FormModal>
  )
}
