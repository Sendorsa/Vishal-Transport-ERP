"use client"

import { useRouter } from "next/navigation"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FormActionBar, FormSection } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { calculateTripRevenue, PRICING_MODELS } from "@/domain/pricing"
import { useSaveCustomer } from "@/lib/api/hooks"
import { useCompanyScope } from "@/lib/app-state"
import { BUSINESS_UNITS, COMPANIES, GSTIN_REGEX, STATES } from "@/lib/constants"
import { formatINR } from "@/lib/format"
import type { Customer, PricingModel } from "@/lib/types"

const schema = z.object({
  code: z.string().trim().min(2, "Min 2 characters").max(12).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2, "Required"),
  shortName: z.string().trim().max(16, "Max 16 characters"),
  legalName: z.string().trim().min(2, "Required"),
  companyCode: z.enum(["VT", "VTHPL"]),
  businessUnit: z.enum(["STAFF_BUS", "SCHOOL_BUS", "TAXI", "GOODS", "MANPOWER", "PROPERTY", "FUEL_RETAIL", "INTERNAL"]),
  gstin: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "" || GSTIN_REGEX.test(s), "Invalid GSTIN"),
  state: z.string().min(1, "Required"),
  city: z.string().trim().min(1, "Required"),
  contactName: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim().refine((s) => s === "" || z.string().email().safeParse(s).success, "Invalid email"),
  creditDays: z.number({ invalid_type_error: "Required" }).int().min(0).max(180),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]),
  pricing: z.object({
    model: z.enum(["FIXED_DAILY_KM_CAP", "PER_KM_DAILY_MIN", "ROUTE_DAY_RATE", "PER_TRIP", "TAXI_PACKAGE"]),
    rate: z.number({ invalid_type_error: "Required" }).min(0),
    includedKm: z.number({ invalid_type_error: "Required" }).min(0),
    extraKmRate: z.number({ invalid_type_error: "Required" }).min(0),
    driverBata: z.number({ invalid_type_error: "Required" }).min(0),
    routes: z.array(
      z.object({
        route: z.string().trim().min(1, "Required"),
        distanceKm: z.number({ invalid_type_error: "Required" }).min(0),
        rate: z.number({ invalid_type_error: "Required" }).min(0),
      })
    ),
  }),
})

type FormValues = z.input<typeof schema>

function toFormValues(c?: Customer, defaultCompany: "VT" | "VTHPL" = "VTHPL"): FormValues {
  return {
    code: c?.code ?? "",
    name: c?.name ?? "",
    shortName: c?.shortName ?? "",
    legalName: c?.legalName ?? "",
    companyCode: c?.companyCode ?? defaultCompany,
    businessUnit: c?.businessUnit ?? (defaultCompany === "VT" ? "GOODS" : "STAFF_BUS"),
    gstin: c?.gstin ?? "",
    state: c?.state ?? "Tamil Nadu",
    city: c?.city ?? "Hosur",
    contactName: c?.contactName ?? "",
    phone: c?.phone ?? "",
    email: c?.email ?? "",
    creditDays: c?.creditDays ?? 30,
    status: c?.status ?? "ACTIVE",
    pricing: c?.pricing ?? { model: "PER_KM_DAILY_MIN", rate: 45, includedKm: 120, extraKmRate: 30, driverBata: 0, routes: [] },
  }
}

export function CustomerForm({ customer, onDone }: { customer?: Customer; onDone?: (c: Customer) => void }) {
  const router = useRouter()
  const [scope] = useCompanyScope()
  const save = useSaveCustomer()
  const form = useForm<FormValues, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(customer, scope === "VT" ? "VT" : "VTHPL"),
  })
  const { register, control, handleSubmit, formState } = form
  const errors = formState.errors
  const routes = useFieldArray({ control, name: "pricing.routes" })
  const pricing = useWatch({ control, name: "pricing" })
  const companyCode = useWatch({ control, name: "companyCode" })
  const model = pricing.model as PricingModel
  const meta = PRICING_MODELS[model]

  const sampleKm = model === "PER_TRIP" ? 0 : Math.round((Number(pricing.includedKm) || 100) * 1.1)
  const sample = calculateTripRevenue(
    {
      model,
      rate: Number(pricing.rate) || 0,
      includedKm: Number(pricing.includedKm) || 0,
      extraKmRate: Number(pricing.extraKmRate) || 0,
      driverBata: Number(pricing.driverBata) || 0,
      routes: (pricing.routes ?? []).map((r) => ({ route: r.route, distanceKm: Number(r.distanceKm) || 0, rate: Number(r.rate) || 0 })),
    },
    { distanceKm: sampleKm, route: pricing.routes?.[0]?.route }
  )

  const onSubmit = handleSubmit(async (values) => {
    const stateCode = STATES.find((s) => s.name === values.state)?.code ?? ""
    const shortName = values.shortName || values.name.split(/[—(-]/)[0].trim().slice(0, 16)
    const saved = await save.mutateAsync({ id: customer?.id, version: customer?.updatedAt, data: { ...values, shortName, stateCode } })
    toast.success(customer ? "Customer updated" : `Customer ${saved.code} created`)
    if (onDone) onDone(saved)
    else router.push(`/customers/${saved.id}`)
  })

  const num = { valueAsNumber: true } as const

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardContent>
          <FormSection title="Identity" description="Which group company bills this customer, and how they're known.">
            <Field label="Customer code" required error={errors.code?.message} hint="Short code used on reports, e.g. TEPL">
              <Input {...register("code")} placeholder="TEPL" className="uppercase" />
            </Field>
            <Field label="Display name" required error={errors.name?.message}>
              <Input {...register("name")} placeholder="Tata Electronics (TEPL)" />
            </Field>
            <Field label="Short name" error={errors.shortName?.message} hint="Shown on diesel cards and charts, e.g. Seating">
              <Input {...register("shortName")} placeholder="TEPL" />
            </Field>
            <Field label="Legal name" required error={errors.legalName?.message}>
              <Input {...register("legalName")} placeholder="Tata Electronics Pvt Ltd" />
            </Field>
            <Field label="Billing company" required>
              <Controller
                control={control}
                name="companyCode"
                render={({ field }) => <SimpleSelect value={field.value} onChange={field.onChange} options={COMPANIES} />}
              />
            </Field>
            <Field label="Business unit" required>
              <Controller
                control={control}
                name="businessUnit"
                render={({ field }) => (
                  <SimpleSelect
                    value={field.value}
                    onChange={field.onChange}
                    options={BUSINESS_UNITS.filter((b) => b.company === companyCode).map((b) => ({ value: b.value, label: b.label }))}
                  />
                )}
              />
            </Field>
          </FormSection>

          <FormSection title="Tax & contact" description="Place of supply decides CGST+SGST vs IGST on invoices.">
            <Field label="GSTIN" error={errors.gstin?.message} hint="Leave blank for unregistered (B2C)">
              <Input {...register("gstin")} placeholder="33AAHCT8342G1ZA" className="uppercase" />
            </Field>
            <Field label="State (place of supply)" required>
              <Controller
                control={control}
                name="state"
                render={({ field }) => (
                  <SimpleSelect value={field.value} onChange={field.onChange} options={STATES.map((s) => ({ value: s.name, label: `${s.name} (${s.code})` }))} />
                )}
              />
            </Field>
            <Field label="City" required error={errors.city?.message}>
              <Input {...register("city")} />
            </Field>
            <Field label="Credit days" required error={errors.creditDays?.message}>
              <Input type="number" {...register("creditDays", num)} />
            </Field>
            <Field label="Contact person">
              <Input {...register("contactName")} />
            </Field>
            <Field label="Phone">
              <Input {...register("phone")} placeholder="+91" />
            </Field>
            <Field label="Email" error={errors.email?.message}>
              <Input type="email" {...register("email")} />
            </Field>
            <Field label="Status">
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <SimpleSelect value={field.value} onChange={field.onChange} options={[{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }, { value: "ARCHIVED", label: "Archived" }]} />
                )}
              />
            </Field>
          </FormSection>

          <FormSection title="Pricing terms" description={meta.hint}>
            <Field label="Pricing model" required className="sm:col-span-2">
              <Controller
                control={control}
                name="pricing.model"
                render={({ field }) => (
                  <SimpleSelect
                    value={field.value}
                    onChange={field.onChange}
                    options={Object.entries(PRICING_MODELS).map(([value, m]) => ({ value, label: m.label }))}
                  />
                )}
              />
            </Field>
            <Field label={meta.rateLabel} required error={errors.pricing?.rate?.message}>
              <Input type="number" step="0.01" {...register("pricing.rate", num)} />
            </Field>
            {meta.includedKmLabel && (
              <Field label={meta.includedKmLabel} error={errors.pricing?.includedKm?.message}>
                <Input type="number" {...register("pricing.includedKm", num)} />
              </Field>
            )}
            {model !== "PER_TRIP" && (
              <Field label="Extra km rate (₹)" error={errors.pricing?.extraKmRate?.message}>
                <Input type="number" step="0.01" {...register("pricing.extraKmRate", num)} />
              </Field>
            )}
            {model === "TAXI_PACKAGE" && (
              <Field label="Driver bata (₹ / trip)">
                <Input type="number" {...register("pricing.driverBata", num)} />
              </Field>
            )}
            {model === "PER_TRIP" && (
              <div className="grid gap-2 sm:col-span-2">
                <div className="text-xs font-medium">Route rate card</div>
                {routes.fields.map((f, i) => (
                  <div key={f.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 sm:grid-cols-[1fr_88px_104px_auto]">
                    <Input {...register(`pricing.routes.${i}.route`)} placeholder="Origin → destination" aria-invalid={!!errors.pricing?.routes?.[i]?.route} className="max-sm:col-span-3" />
                    <Input type="number" {...register(`pricing.routes.${i}.distanceKm`, num)} placeholder="km" />
                    <Input type="number" step="0.01" {...register(`pricing.routes.${i}.rate`, num)} placeholder="₹ / trip" />
                    <Button type="button" variant="ghost" size="icon" onClick={() => routes.remove(i)} aria-label="Remove route">
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => routes.append({ route: "", distanceKm: 0, rate: 0 })}>
                  <Plus /> Add route
                </Button>
              </div>
            )}
            <div className="rounded-lg border bg-muted/40 p-3 text-xs sm:col-span-2">
              <span className="text-muted-foreground">Preview: </span>
              {model === "PER_TRIP" ? (
                <>one trip on <b>{pricing.routes?.[0]?.route || "default rate"}</b></>
              ) : (
                <>a {sampleKm} km duty</>
              )}{" "}
              bills <b className="num">{formatINR(sample.revenue)}</b>
              {sample.extraKmAmount > 0 && (
                <span className="text-muted-foreground"> (incl. {sample.extraKm} extra km = {formatINR(sample.extraKmAmount)})</span>
              )}
            </div>
          </FormSection>
        </CardContent>
      </Card>
      <FormActionBar className="mt-4 md:sticky md:bottom-4">
        <Button type="button" variant="outline" onClick={() => (onDone && customer ? onDone(customer) : router.back())}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {customer ? "Save changes" : "Create customer"}
        </Button>
      </FormActionBar>
    </form>
  )
}
