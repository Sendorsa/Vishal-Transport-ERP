"use client"

import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { addYears } from "date-fns"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FormActionBar, FormSection } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCreateDriverByName, useCreateVehicleType, useCustomers, useDrivers, useSaveVehicle, useSettings } from "@/lib/api/hooks"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { useCompanyScope } from "@/lib/app-state"
import { COMPANIES, FUEL_TYPES, VEHICLE_REG_REGEX } from "@/lib/constants"
import { toISODate, todayDate, todayISO } from "@/lib/format"
import type { Vehicle } from "@/lib/types"

const NONE = "__none__"
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Required")
const money = z.number({ invalid_type_error: "Required" }).min(0)

const schema = z
  .object({
    regNo: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
      .refine((s) => VEHICLE_REG_REGEX.test(s), "Format like TN70AL9834"),
    companyCode: z.enum(["VT", "VTHPL"]),
    typeCode: z.string().min(1, "Required"),
    make: z.string().trim().min(1, "Required"),
    model: z.string().trim().min(1, "Required"),
    year: z.number({ invalid_type_error: "Required" }).int().min(1990).max(2100),
    seats: z.number().int().min(0).nullable(),
    fuelType: z.enum(["DIESEL", "PETROL", "EV"]),
    mileageKmpl: z.number({ invalid_type_error: "Required" }).positive("Must be > 0"),
    ownership: z.enum(["OWNED", "ATTACHED"]),
    ownerName: z.string().trim(),
    status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE", "ARCHIVED"]),
    odometerKm: z.number({ invalid_type_error: "Required" }).min(0),
    assignedCustomerId: z.string(),
    defaultDriverId: z.string(),
    insurance: z.object({ provider: z.string().trim(), policyNo: z.string().trim(), validTill: date, premium: money }),
    roadTax: z.object({ validTill: date, amount: money, period: z.enum(["QUARTERLY", "ANNUAL"]) }),
    fitnessValidTill: date,
    permitValidTill: date,
    emiAmount: money,
  })
  .refine((v) => v.ownership === "OWNED" || v.ownerName.length > 0, { path: ["ownerName"], message: "Owner name required for attached vehicles" })

type FormValues = z.input<typeof schema>

function defaults(v: Vehicle | undefined, company: "VT" | "VTHPL"): FormValues {
  const nextYear = toISODate(addYears(todayDate(), 1))
  return {
    regNo: v?.regNo ?? "",
    companyCode: v?.companyCode ?? company,
    typeCode: v?.typeCode ?? (company === "VT" ? "TRUCK_19" : "BUS_55"),
    make: v?.make ?? "",
    model: v?.model ?? "",
    year: v?.year ?? todayDate().getFullYear(),
    seats: v?.seats ?? null,
    fuelType: v?.fuelType ?? "DIESEL",
    mileageKmpl: v?.mileageKmpl ?? 4.5,
    ownership: v?.ownership ?? "OWNED",
    ownerName: v?.ownerName ?? "",
    status: v?.status ?? "ACTIVE",
    odometerKm: v?.odometerKm ?? 0,
    assignedCustomerId: v?.assignedCustomerId ?? NONE,
    defaultDriverId: v?.defaultDriverId ?? NONE,
    insurance: v?.insurance ?? { provider: "", policyNo: "", validTill: nextYear, premium: 0 },
    roadTax: v?.roadTax ?? { validTill: nextYear, amount: 0, period: "QUARTERLY" },
    fitnessValidTill: v?.fitnessValidTill ?? nextYear,
    permitValidTill: v?.permitValidTill ?? nextYear,
    emiAmount: v?.emiAmount ?? 0,
  }
}

export function VehicleForm({ vehicle, onDone }: { vehicle?: Vehicle; onDone?: () => void }) {
  const router = useRouter()
  const [scope] = useCompanyScope()
  const settings = useSettings()
  const customers = useCustomers()
  const drivers = useDrivers()
  const save = useSaveVehicle()
  const createType = useCreateVehicleType()
  const createDriver = useCreateDriverByName()
  const form = useForm<FormValues, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: defaults(vehicle, scope === "VT" ? "VT" : "VTHPL"),
  })
  const { register, control, handleSubmit, setValue, formState } = form
  const errors = formState.errors
  const company = useWatch({ control, name: "companyCode" })
  const ownership = useWatch({ control, name: "ownership" })
  const num = { valueAsNumber: true } as const

  const onSubmit = handleSubmit(async (values) => {
    const data = {
      ...values,
      ownerName: values.ownership === "ATTACHED" ? values.ownerName : null,
      assignedCustomerId: values.assignedCustomerId === NONE ? null : values.assignedCustomerId,
      defaultDriverId: values.defaultDriverId === NONE ? null : values.defaultDriverId,
      seats: values.seats && !Number.isNaN(values.seats) ? values.seats : null,
    }
    const saved = await save.mutateAsync({ id: vehicle?.id, data })
    toast.success(vehicle ? "Vehicle updated" : `${saved.regNo} added to fleet`)
    if (onDone) onDone()
    else router.push(`/vehicles/${saved.id}`)
  })

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardContent>
          <FormSection title="Vehicle" description="Registration, type and the company that owns or operates it.">
            <Field label="Registration no." required error={errors.regNo?.message}>
              <Input {...register("regNo")} placeholder="TN70AL9834" className="uppercase" />
            </Field>
            <Field label="Company" required>
              <Controller control={control} name="companyCode" render={({ field }) => <SimpleSelect value={field.value} onChange={field.onChange} options={COMPANIES} />} />
            </Field>
            <Field label="Vehicle type" required error={errors.typeCode?.message}>
              <Controller
                control={control}
                name="typeCode"
                render={({ field }) => (
                  <CreatableSelect
                    value={field.value}
                    onCreate={(name) => createType(name, Number(form.getValues("mileageKmpl")) || undefined)}
                    placeholder="Select vehicle type"
                    onChange={(v) => {
                      field.onChange(v)
                      const t = settings.data?.vehicleTypes.find((x) => x.code === v)
                      if (t) {
                        setValue("seats", t.defaultSeats)
                        setValue("mileageKmpl", t.defaultMileage)
                      }
                    }}
                    options={(settings.data?.vehicleTypes ?? []).map((t) => ({ value: t.code, label: t.name }))}
                  />
                )}
              />
            </Field>
            <Field label="Status">
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <SimpleSelect
                    value={field.value}
                    onChange={field.onChange}
                    options={[
                      { value: "ACTIVE", label: "Active" },
                      { value: "MAINTENANCE", label: "In workshop" },
                      { value: "INACTIVE", label: "Inactive" },
                      { value: "ARCHIVED", label: "Archived" },
                    ]}
                  />
                )}
              />
            </Field>
            <Field label="Make" required error={errors.make?.message}>
              <Input {...register("make")} placeholder="Ashok Leyland" />
            </Field>
            <Field label="Model" required error={errors.model?.message}>
              <Input {...register("model")} placeholder="Falcon 55" />
            </Field>
            <Field label="Year" error={errors.year?.message}>
              <Input type="number" {...register("year", num)} />
            </Field>
            <Field label="Fuel type" required hint="Fuel entries for this vehicle use this">
              <Controller control={control} name="fuelType" render={({ field }) => <SimpleSelect value={field.value} onChange={field.onChange} options={FUEL_TYPES} />} />
            </Field>
            <Field label="Seats">
              <Input type="number" {...register("seats", { setValueAs: (v) => (v === "" || v === null ? null : Number(v)) })} />
            </Field>
            <Field label="Expected mileage (kmpl)" error={errors.mileageKmpl?.message} hint="The mileage this vehicle is expected to give">
              <Input type="number" step="0.1" {...register("mileageKmpl", num)} />
            </Field>
            <Field label="Odometer (km)" error={errors.odometerKm?.message}>
              <Input type="number" {...register("odometerKm", num)} />
            </Field>
          </FormSection>

          <FormSection title="Deployment" description="Default customer and driver pre-fill new trips.">
            <Field label="Ownership">
              <Controller
                control={control}
                name="ownership"
                render={({ field }) => (
                  <SimpleSelect value={field.value} onChange={field.onChange} options={[{ value: "OWNED", label: "Owned" }, { value: "ATTACHED", label: "Attached (third-party)" }]} />
                )}
              />
            </Field>
            {ownership === "ATTACHED" ? (
              <Field label="Owner name" required error={errors.ownerName?.message}>
                <Input {...register("ownerName")} />
              </Field>
            ) : (
              <Field label="Monthly EMI (₹)" error={errors.emiAmount?.message}>
                <Input type="number" {...register("emiAmount", num)} />
              </Field>
            )}
            <Field label="Assigned customer">
              <Controller
                control={control}
                name="assignedCustomerId"
                render={({ field }) => (
                  <SimpleSelect
                    value={field.value}
                    onChange={field.onChange}
                    options={[{ value: NONE, label: "Spare / unassigned" }, ...(customers.data ?? []).filter((c) => c.companyCode === company).map((c) => ({ value: c.id, label: c.name }))]}
                  />
                )}
              />
            </Field>
            <Field label="Default driver">
              <Controller
                control={control}
                name="defaultDriverId"
                render={({ field }) => (
                  <CreatableSelect
                    value={field.value}
                    onChange={field.onChange}
                    onCreate={(name) => createDriver(name, company)}
                    createLabel={(q) => `Create driver "${q}"`}
                    placeholder="Select driver"
                    options={[{ value: NONE, label: "None" }, ...(drivers.data ?? []).filter((d) => d.companyCode === company).map((d) => ({ value: d.id, label: d.name }))]}
                  />
                )}
              />
            </Field>
          </FormSection>

          <FormSection title="Compliance" description="Expiry dates drive the dashboard alerts.">
            <Field label="Insurer">
              <Input {...register("insurance.provider")} />
            </Field>
            <Field label="Policy no.">
              <Input {...register("insurance.policyNo")} />
            </Field>
            <Field label="Insurance valid till" required error={errors.insurance?.validTill?.message}>
              <Input type="date" {...register("insurance.validTill")} />
            </Field>
            <Field label="Annual premium (₹)">
              <Input type="number" {...register("insurance.premium", num)} />
            </Field>
            <Field label="Road tax valid till" required error={errors.roadTax?.validTill?.message}>
              <Input type="date" {...register("roadTax.validTill")} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Road tax (₹)">
                <Input type="number" {...register("roadTax.amount", num)} />
              </Field>
              <Field label="Period">
                <Controller
                  control={control}
                  name="roadTax.period"
                  render={({ field }) => (
                    <SimpleSelect value={field.value} onChange={field.onChange} options={[{ value: "QUARTERLY", label: "Quarterly" }, { value: "ANNUAL", label: "Annual" }]} />
                  )}
                />
              </Field>
            </div>
            <Field label="Fitness valid till" required error={errors.fitnessValidTill?.message}>
              <Input type="date" {...register("fitnessValidTill")} max="2100-12-31" />
            </Field>
            <Field label="Permit valid till" required error={errors.permitValidTill?.message}>
              <Input type="date" {...register("permitValidTill")} min={todayISO().slice(0, 4) + "-01-01"} />
            </Field>
          </FormSection>
        </CardContent>
      </Card>
      <FormActionBar className="mt-4 md:sticky md:bottom-4">
        <Button type="button" variant="outline" onClick={() => (onDone ? onDone() : router.back())}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {vehicle ? "Save changes" : "Add vehicle"}
        </Button>
      </FormActionBar>
    </form>
  )
}
