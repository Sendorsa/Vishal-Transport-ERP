"use client"

import { useState } from "react"
import { addDays, format, parseISO, subDays } from "date-fns"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { DeletionReasonField } from "@/components/shared/audit"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCorrectAssignmentStart, useCustomers, useTransferVehicle, useVehicleAssignments } from "@/lib/api/hooks"
import { formatDate, todayISO } from "@/lib/format"
import { deletionReasonError } from "@/domain/audit"
import { handedOverBy } from "@/domain/assignments"
import type { Customer, Vehicle } from "@/lib/types"

const READ_ONLY = "flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm"

/**
 * Moves a vehicle to another customer from the day it really started working for them — today by default, or back-dated
 * when the transfer is entered late (a reason is then required). The current assignment ends the day before; earlier
 * entries stay with the old customer. The API refuses a date that would move an entry or trip already recorded, and
 * the dialog shows its explanation next to the date.
 */
export function TransferVehicleDialog({ vehicle, onOpenChange }: { vehicle: Vehicle; onOpenChange: (o: boolean) => void }) {
  const customers = useCustomers()
  const assignments = useVehicleAssignments()
  const transfer = useTransferVehicle({ toast: false })
  const today = todayISO()
  const [to, setTo] = useState("")
  const [date, setDate] = useState(today)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)

  const names = new Map((customers.data ?? []).map((c) => [c.id, c.shortName || c.name]))
  const mine = (assignments.data ?? []).filter((a) => a.vehicleId === vehicle.id)
  const current = mine.filter((a) => a.endDate === null).at(-1)
  const fromId = vehicle.assignedCustomerId
  // The new assignment must start after the current one did — never rewrite an earlier period.
  const minDate = current ? format(addDays(parseISO(current.startDate), 1), "yyyy-MM-dd") : undefined
  const dateOk = !!date && date <= today && (!minDate || date >= minDate)
  // Back-dating re-files the days from the effective date to today: the reason goes into the audit log.
  const backdated = mine.length > 0 && dateOk && date < today
  const name = (id: string | null) => (id ? (names.get(id) ?? "—") : "None (spare)")

  const submit = async () => {
    setError(null)
    if (!to) return setError("Choose the new customer")
    if (!dateOk) return setError(minDate ? `Pick a date from ${formatDate(minDate)} to today` : "Pick a date up to today")
    const r = backdated ? deletionReasonError(reason, "back-dating") : null
    setReasonError(r)
    if (r) return
    try {
      await transfer.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, customerId: to, effectiveDate: date, reason: backdated ? reason : undefined })
    } catch (e) {
      return setError(e instanceof Error ? e.message : "The vehicle couldn't be transferred")
    }
    toast.success(`${vehicle.regNo} transferred to ${names.get(to)} from ${formatDate(date)}`)
    onOpenChange(false)
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title="Transfer Vehicle"
      description={`${vehicle.regNo} · entries from the effective date move to the new customer; earlier ones stay with the old one. Entered late? Pick the day it really started.`}
      submitLabel="Transfer vehicle"
      pending={transfer.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current customer">
          <div className={READ_ONLY}>
            {name(fromId)}
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
        <Field label={current ? "Transfer effective date" : "Assigned since"} required error={error && to ? error : undefined} hint={current ? "First day the vehicle works for the new customer — may be in the past" : "The day it started working for this customer (may be back-dated at go-live)"}>
          <Input type="date" value={date} min={minDate} max={today} onChange={(e) => setDate(e.target.value)} aria-invalid={!!error} />
        </Field>
        {to && dateOk && (
          <div className="grid gap-1 rounded-md border bg-muted/40 px-3 py-2 text-sm sm:col-span-2">
            {current && (
              <div>
                <span className="text-muted-foreground">Current assignment:</span> {name(current.customerId)} · <span className="num">{formatDate(current.startDate)}</span> → ends{" "}
                <span className="num font-medium">{formatDate(format(subDays(parseISO(date), 1), "yyyy-MM-dd"))}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">New assignment:</span> {name(to)} · from <span className="num font-medium">{formatDate(date)}</span> · Active
            </div>
          </div>
        )}
        {backdated && (
          <div className="sm:col-span-2">
            <DeletionReasonField purpose="back-dating" value={reason} onChange={setReason} onBlur={() => setReasonError(deletionReasonError(reason, "back-dating"))} error={reasonError} />
          </div>
        )}
      </div>
    </FormModal>
  )
}

/**
 * Edit Assignment: corrects the start date of this vehicle's assignment to `customer` when it was entered wrongly
 * (e.g. 07-11-2026 for 01-11-2026, or a transfer saved on the day it was entered). The same assignment keeps its
 * customer, end date and status — this is not a new transfer. When a transfer began it, the previous customer's
 * assignment ends the day before the new date (shown before saving). The API refuses a date that would move an entry
 * or trip to another customer, overlap another assignment or touch a locked month, and explains why; the reason is
 * kept in the audit log.
 */
export function EditAssignmentDialog({ vehicle, customer, onOpenChange }: { vehicle: Vehicle; customer: Customer; onOpenChange: (o: boolean) => void }) {
  const assignments = useVehicleAssignments()
  const customers = useCustomers()
  const correct = useCorrectAssignmentStart()
  const today = todayISO()
  // This customer's latest assignment of the vehicle (the current one when the vehicle works for it now).
  const mine = (assignments.data ?? []).filter((a) => a.vehicleId === vehicle.id)
  const assignment = mine.filter((a) => a.customerId === customer.id).sort((a, b) => a.startDate.localeCompare(b.startDate)).at(-1)
  // The assignment its transfer closed: its end date moves with this start date.
  const previous = assignment && handedOverBy(mine, assignment)
  const names = new Map((customers.data ?? []).map((c) => [c.id, c.shortName || c.name]))
  const [date, setDate] = useState(assignment?.startDate ?? "")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const maxDate = assignment?.endDate && assignment.endDate < today ? assignment.endDate : today
  const changed = !!assignment && !!date && date !== assignment.startDate

  const submit = async () => {
    if (!assignment) return
    setError(null)
    const r = deletionReasonError(reason, "correcting")
    setReasonError(r)
    if (!date) return setError("Enter the new start date")
    if (date === assignment.startDate) return setError("Choose a date different from the current start date")
    if (date > today) return setError("The start date can't be in the future")
    if (assignment.endDate && date > assignment.endDate) return setError(`The start date can't be after the end date (${formatDate(assignment.endDate)})`)
    if (previous && date <= previous.startDate) return setError(`Pick a date after ${formatDate(previous.startDate)}, when the previous assignment started`)
    if (r) return
    try {
      await correct.mutateAsync({ id: assignment.id, versions: { [assignment.id]: assignment.updatedAt, ...(previous ? { [previous.id]: previous.updatedAt } : {}) }, startDate: date, reason })
    } catch (e) {
      return setError(e instanceof Error ? e.message : "The start date couldn't be corrected")
    }
    toast.success(`${vehicle.regNo} · ${customer.shortName || customer.name}: assignment now starts ${formatDate(date)}`)
    onOpenChange(false)
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title="Edit Assignment"
      description="Correct a start date that was entered wrongly — including a transfer date. The vehicle stays with the same customer; the previous assignment's end date moves with it. No entry, trip or invoice is changed."
      submitLabel="Save start date"
      pending={correct.isPending}
      submitDisabled={!changed}
      onSubmit={submit}
    >
      {!assignment ? (
        <p className="text-sm text-muted-foreground">{vehicle.regNo} has no assignment to {customer.shortName || customer.name} to edit.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vehicle">
            <div className={READ_ONLY}>{vehicle.regNo}</div>
          </Field>
          <Field label="Customer">
            <div className={READ_ONLY}>{customer.shortName || customer.name}</div>
          </Field>
          <Field label="Current start date">
            <div className={READ_ONLY}>{formatDate(assignment.startDate)}</div>
          </Field>
          <Field label="New start date" required error={error ?? undefined} hint="The first day the vehicle actually worked for this customer">
            <Input type="date" value={date} max={maxDate} onChange={(e) => setDate(e.target.value)} aria-invalid={!!error} />
          </Field>
          <Field label="End date">
            <div className={READ_ONLY}>{assignment.endDate ? formatDate(assignment.endDate) : "Open (current assignment)"}</div>
          </Field>
          <Field label="Status">
            <div className={READ_ONLY}>{assignment.status === "ACTIVE" ? "Active" : "Ended"}</div>
          </Field>
          {changed && (
            <div className="grid gap-1 rounded-md border bg-muted/40 px-3 py-2 text-sm sm:col-span-2">
              <div>
                Start date: <span className="num font-medium">{formatDate(assignment.startDate)}</span> → <span className="num font-medium">{formatDate(date)}</span>
              </div>
              {previous?.endDate && (
                <div>
                  <span className="text-muted-foreground">Previous assignment ({previous.customerId ? (names.get(previous.customerId) ?? "—") : "spare"}):</span> ends{" "}
                  <span className="num font-medium">{formatDate(previous.endDate)}</span> → <span className="num font-medium">{formatDate(format(subDays(parseISO(date), 1), "yyyy-MM-dd"))}</span>
                </div>
              )}
            </div>
          )}
          <div className="sm:col-span-2">
            <DeletionReasonField purpose="correction" value={reason} onChange={setReason} onBlur={() => setReasonError(deletionReasonError(reason, "correcting"))} error={reasonError} />
          </div>
        </div>
      )}
    </FormModal>
  )
}
