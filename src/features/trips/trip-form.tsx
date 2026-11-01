"use client"

import { ReasonField } from "@/components/shared/audit"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FormActionBar } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { calculateTripRevenue, PRICING_MODELS } from "@/domain/pricing"
import { useCustomers, useDrivers, useSaveTrip, useVehicles } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatINR, todayISO } from "@/lib/format"
import type { Trip } from "@/lib/types"

const NONE = "__none__"

const schema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Required"),
    customerId: z.string().min(1, "Select a customer"),
    vehicleId: z.string().min(1, "Select a vehicle"),
    driverId: z.string(),
    route: z.string().trim().min(1, "Required"),
    startKm: z.number({ invalid_type_error: "Required" }).min(0),
    endKm: z.number({ invalid_type_error: "Required" }).min(0),
    tollParking: z.number({ invalid_type_error: "Enter 0 if none" }).min(0),
    status: z.enum(["PLANNED", "COMPLETED", "CANCELLED"]),
    notes: z.string(),
  })
  .refine((v) => v.status !== "COMPLETED" || v.endKm > v.startKm, { path: ["endKm"], message: "End km must be greater than start km" })
  .refine((v) => v.endKm - v.startKm <= 2500, { path: ["endKm"], message: "Distance looks too large (> 2,500 km)" })

type FormValues = z.input<typeof schema>

export function TripForm({ trip, defaultCustomerId, onDone }: { trip?: Trip; defaultCustomerId?: string; onDone?: () => void }) {
  const router = useRouter()
  const [scope] = useCompanyScope()
  const can = useCan()
  const customers = useCustomers()
  const vehicles = useVehicles()
  const drivers = useDrivers()
  const save = useSaveTrip()

  const form = useForm<FormValues, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: trip
      ? { ...trip, driverId: trip.driverId ?? NONE }
      : { date: todayISO(), customerId: defaultCustomerId ?? "", vehicleId: "", driverId: NONE, route: "", startKm: 0, endKm: 0, tollParking: 0, status: "COMPLETED", notes: "" },
  })
  const { register, control, handleSubmit, setValue, formState } = form
  const errors = formState.errors
  const w = useWatch({ control })
  const num = { valueAsNumber: true } as const

  const customerList = (customers.data ?? []).filter((c) => c.status === "ACTIVE" && (scope === "GROUP" || c.companyCode === scope))
  const customer = customers.data?.find((c) => c.id === w.customerId)
  // New trips only with vehicles currently assigned to this customer (or spare) — transferred vehicles belong to their new customer.
  const vehicleList = (vehicles.data ?? []).filter(
    (v) => (v.status === "ACTIVE" || v.status === "MAINTENANCE") && (!customer || (v.companyCode === customer.companyCode && (!v.assignedCustomerId || v.assignedCustomerId === customer.id || v.id === trip?.vehicleId)))
  )
  const driverList = (drivers.data ?? []).filter((d) => d.status === "ACTIVE" && (!customer || d.companyCode === customer.companyCode))

  const distance = Math.max(0, (Number(w.endKm) || 0) - (Number(w.startKm) || 0))
  const price = useMemo(
    () => (customer ? calculateTripRevenue(customer.pricing, { distanceKm: distance, route: w.route, tollParking: Number(w.tollParking) || 0 }) : null),
    [customer, distance, w.route, w.tollParking]
  )

  const pickCustomer = (id: string) => {
    setValue("customerId", id, { shouldValidate: true })
    const c = customers.data?.find((x) => x.id === id)
    const v = vehicles.data?.find((x) => x.assignedCustomerId === id && x.status === "ACTIVE")
    if (v && !trip) pickVehicle(v.id)
    if (c?.pricing.model === "PER_TRIP" && c.pricing.routes[0]) setValue("route", c.pricing.routes[0].route)
    else if (c && !trip) setValue("route", c.businessUnit === "TAXI" ? "" : `${c.code} shift route 1`)
  }
  const pickVehicle = (id: string) => {
    setValue("vehicleId", id, { shouldValidate: true })
    const v = vehicles.data?.find((x) => x.id === id)
    if (v && !trip) {
      setValue("startKm", v.odometerKm)
      setValue("endKm", v.odometerKm)
      setValue("driverId", v.defaultDriverId ?? NONE)
    }
  }
  const pickRoute = (route: string) => {
    setValue("route", route, { shouldValidate: true })
    const r = customer?.pricing.routes.find((x) => x.route === route)
    if (r) setValue("endKm", (Number(w.startKm) || 0) + r.distanceKm)
  }

  // Coming from a customer page (?customerId=…): pre-fill vehicle, driver, route once data loads.
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current || trip || !defaultCustomerId || !customers.data || !vehicles.data) return
    prefilled.current = true
    pickCustomer(defaultCustomerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers.data, vehicles.data])

  const [reason, setReason] = useState("")
  const onSubmit = handleSubmit(async (values) => {
    const saved = await save.mutateAsync({
      id: trip?.id,
      data: { ...values, driverId: values.driverId === NONE ? null : values.driverId },
      reason,
    })
    toast.success(trip ? "Trip updated" : `Trip ${saved.tripNo} created`)
    if (onDone) onDone()
    else router.push(`/trips/${saved.id}`)
  })

  const finance = can("finance", "view")

  return (
    <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" required error={errors.date?.message}>
            <Input type="date" {...register("date")} />
          </Field>
          <Field label="Status" required>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <SimpleSelect
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { value: "PLANNED", label: "Planned" },
                    { value: "COMPLETED", label: "Completed" },
                    { value: "CANCELLED", label: "Cancelled" },
                  ]}
                />
              )}
            />
          </Field>
          <Field label="Customer" required error={errors.customerId?.message} className="sm:col-span-2">
            <SimpleSelect
              value={w.customerId}
              onChange={pickCustomer}
              invalid={!!errors.customerId}
              placeholder="Select customer"
              options={customerList.map((c) => ({ value: c.id, label: `${c.name} · ${c.companyCode}` }))}
            />
          </Field>
          <Field label="Vehicle" required error={errors.vehicleId?.message}>
            <SimpleSelect
              value={w.vehicleId}
              onChange={pickVehicle}
              invalid={!!errors.vehicleId}
              placeholder="Select vehicle"
              options={vehicleList.map((v) => ({
                value: v.id,
                label: `${v.regNo}${v.assignedCustomerId === w.customerId ? " ★" : ""}${v.status === "MAINTENANCE" ? " (workshop)" : ""}`,
              }))}
            />
          </Field>
          <Field label="Driver">
            <Controller
              control={control}
              name="driverId"
              render={({ field }) => (
                <SimpleSelect value={field.value} onChange={field.onChange} options={[{ value: NONE, label: "Owner-driven / none" }, ...driverList.map((d) => ({ value: d.id, label: d.name }))]} />
              )}
            />
          </Field>
          <Field label="Route" required error={errors.route?.message} className="sm:col-span-2">
            {customer?.pricing.model === "PER_TRIP" && customer.pricing.routes.length ? (
              <SimpleSelect
                value={w.route}
                onChange={pickRoute}
                options={customer.pricing.routes.map((r) => ({ value: r.route, label: `${r.route} · ${r.distanceKm} km · ${formatINR(r.rate)}` }))}
              />
            ) : (
              <Input {...register("route")} placeholder="Plant → Bengaluru Airport" />
            )}
          </Field>
          <Field label="Start km" required error={errors.startKm?.message}>
            <Input type="number" {...register("startKm", num)} />
          </Field>
          <Field label="End km" required error={errors.endKm?.message} hint={`Distance: ${distance.toLocaleString("en-IN")} km`}>
            <Input type="number" {...register("endKm", num)} />
          </Field>
          <Field label="Toll & parking (₹)" error={errors.tollParking?.message} hint="Billed to customer at actuals">
            <Input type="number" {...register("tollParking", num)} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} {...register("notes")} />
          </Field>
          {trip && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card size="sm" className="lg:sticky lg:top-16">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Revenue calculation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!customer || !price ? (
              <p className="text-muted-foreground">Select a customer to see how this trip is priced.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{PRICING_MODELS[customer.pricing.model].label}</p>
                <Row label="Base" value={price.baseAmount} />
                <Row label={`Extra km (${price.extraKm} km)`} value={price.extraKmAmount} />
                {price.bataAmount > 0 && <Row label="Driver bata" value={price.bataAmount} />}
                <Row label="Toll & parking" value={price.tollParking} />
                <div className="flex justify-between border-t pt-2 font-semibold">
                  <span>Trip revenue</span>
                  <span className="num">{finance || !trip ? formatINR(price.revenue) : "—"}</span>
                </div>
                {w.status !== "COMPLETED" && <p className="text-xs text-warning">Revenue is recognised only when the trip is completed.</p>}
                <p className="text-xs text-muted-foreground">Ex-GST. Final amount is recalculated on save.</p>
              </>
            )}
          </CardContent>
        </Card>
        <FormActionBar>
          <Button type="button" variant="outline" onClick={() => (onDone ? onDone() : router.back())}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {trip ? "Save trip" : "Create trip"}
          </Button>
        </FormActionBar>
      </div>
    </form>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatINR(value)}</span>
    </div>
  )
}
