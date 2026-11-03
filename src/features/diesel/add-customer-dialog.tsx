"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ImagePlus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { customerSlug } from "@/domain/diesel"
import { useCustomers, useSaveCustomer, useUpdateCustomer } from "@/lib/api/hooks"
import type { Customer, NewEntity } from "@/lib/types"
import { CompanyLogo, readLogoFile } from "./parts"

const toCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9-]+/g, "").slice(0, 12)

/** Short unique code from the customer's short name, e.g. "Jamna" → JAMNA, clash → JAMNA2. */
function makeCode(short: string, existing: Customer[]) {
  const base = toCode(short).slice(0, 10) || "CUST"
  const taken = new Set(existing.map((c) => c.code.toUpperCase()))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

/**
 * Add a transport customer from the diesel module — or, with `customer`, edit one.
 * Only what diesel tracking needs; billing details live under Customers.
 * Mount with `key={customer.id}` when editing so the form starts from that customer.
 */
export function AddCustomerDialog({ open, onOpenChange, customer }: { open: boolean; onOpenChange: (o: boolean) => void; customer?: Customer }) {
  const router = useRouter()
  const customers = useCustomers()
  const create = useSaveCustomer()
  const update = useUpdateCustomer()
  const fileRef = useRef<HTMLInputElement>(null)
  const blank = {
    name: customer?.name ?? "",
    shortName: customer?.shortName ?? "",
    code: customer?.code ?? "",
    city: customer?.city ?? "Hosur",
    contactName: customer?.contactName ?? "",
    phone: customer?.phone ?? "",
    notes: customer?.notes ?? "",
  }
  const [f, setF] = useState(blank)
  const [logo, setLogo] = useState<string | null>(customer?.logoDataUrl ?? null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }))
  const shortName = f.shortName.trim() || f.name.trim().split(/[—(-]/)[0].trim().slice(0, 16)
  const others = (customers.data ?? []).filter((c) => c.id !== customer?.id)

  const close = () => {
    setF(blank)
    setLogo(customer?.logoDataUrl ?? null)
    setErrors({})
    onOpenChange(false)
  }

  const submit = async () => {
    const errs: Record<string, string> = {}
    const name = f.name.trim()
    const code = toCode(f.code) || makeCode(shortName, others)
    if (name.length < 2) errs.name = "Enter the customer name"
    else if (others.some((c) => c.name.toLowerCase() === name.toLowerCase())) errs.name = "A customer with this name already exists"
    if (others.some((c) => c.code.toUpperCase() === code)) errs.code = `Code ${code} is already used`
    setErrors(errs)
    if (Object.keys(errs).length) return

    const details = { name, shortName, code, logoDataUrl: logo, city: f.city.trim(), contactName: f.contactName.trim(), phone: f.phone.trim(), notes: f.notes.trim() }
    if (customer) {
      await update.mutateAsync({ id: customer.id, version: customer.updatedAt, patch: details })
      toast.success(`${shortName} updated`)
      close()
      return
    }
    const data: NewEntity<Customer> = {
      ...details,
      legalName: name,
      // Placeholder billing defaults — the diesel module never uses the billing entity.
      companyCode: "VTHPL",
      businessUnit: "STAFF_BUS",
      gstin: "",
      state: "Tamil Nadu",
      stateCode: "33",
      email: "",
      creditDays: 30,
      pricing: { model: "PER_KM_DAILY_MIN", rate: 0, includedKm: 0, extraKmRate: 0, driverBata: 0, routes: [] },
      status: "ACTIVE",
    }
    const created = await create.mutateAsync({ data })
    toast.success(`${created.shortName} added`)
    close()
    router.push(`/diesel/${customerSlug(created)}`)
  }

  return (
    <FormModal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={customer ? `Edit ${customer.shortName}` : "Add customer"}
      description={customer ? "Changes apply everywhere this customer appears." : "A transport client whose vehicles' diesel you want to track."}
      submitLabel={customer ? "Save changes" : "Add customer"}
      pending={create.isPending || update.isPending}
      onSubmit={submit}
    >
      <div className="flex items-center gap-4">
        <CompanyLogo group={{ shortName: shortName || "?", slug: (toCode(f.code) || shortName).toLowerCase() || "new", logo }} size="lg" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (!file) return
              try {
                setLogo(await readLogoFile(file))
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not read image")
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <ImagePlus /> {logo ? "Change logo" : "Upload logo"}
          </Button>
          {logo && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setLogo(null)}>
              <X /> Remove
            </Button>
          )}
          <p className="w-full text-xs text-muted-foreground">Optional. PNG/JPG, resized to 128px.</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer name" required error={errors.name} className="sm:col-span-2">
          <Input value={f.name} onChange={set("name")} placeholder="UNO Minda — Seating Division" autoFocus />
        </Field>
        <Field label="Short name" hint="Shown on cards, e.g. Seating">
          <Input value={f.shortName} onChange={set("shortName")} placeholder={shortName || "Seating"} maxLength={16} />
        </Field>
        <Field label="Customer code" error={errors.code} hint={customer ? "Also changes the page address" : "Leave blank to generate"}>
          <Input value={f.code} onChange={set("code")} placeholder={makeCode(shortName || "CUST", others)} className="uppercase" maxLength={12} />
        </Field>
        <Field label="Contact person">
          <Input value={f.contactName} onChange={set("contactName")} />
        </Field>
        <Field label="Phone number">
          <Input value={f.phone} onChange={set("phone")} placeholder="+91" />
        </Field>
        <Field label="City / plant" className="sm:col-span-2">
          <Input value={f.city} onChange={set("city")} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={set("notes")} rows={2} placeholder="Shift timings, billing contact, anything useful" />
        </Field>
      </div>
      {!customer && <p className="text-xs text-muted-foreground">Billing details (GSTIN, pricing, billing entity) can be completed later under Customers.</p>}
    </FormModal>
  )
}
