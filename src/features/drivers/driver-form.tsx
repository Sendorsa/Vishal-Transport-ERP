"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useSaveDriver, useUpdateDriver } from "@/lib/api/hooks"
import { todayISO } from "@/lib/format"
import type { Driver, EntityStatus } from "@/lib/types"

const STATUS: { value: EntityStatus; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "ARCHIVED", label: "Archived (left — history kept)" },
]

/**
 * Add / edit a driver (Operations → Drivers, owner 27 Nov 2026). The company isn't asked: it follows from the vehicles
 * the driver is assigned to, shown here read-only (`deployment`).
 */
export function DriverDialog({ driver, deployment, onClose }: { driver?: Driver; deployment?: string; onClose: (saved?: Driver) => void }) {
  const save = useSaveDriver()
  const update = useUpdateDriver()
  const [f, setF] = useState({
    name: driver?.name ?? "",
    fatherName: driver?.fatherName ?? "",
    dateOfBirth: driver?.dateOfBirth ?? "",
    address: driver?.address ?? "",
    licenseNo: driver?.licenseNo ?? "",
    licenseValidTill: driver?.licenseValidTill ?? "",
    phone: driver?.phone ?? "",
    status: driver?.status ?? ("ACTIVE" as EntityStatus),
  })
  const [tried, setTried] = useState(false)
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))
  const nameError = !f.name.trim() ? "Enter the driver's name" : undefined
  const busy = save.isPending || update.isPending

  const submit = async () => {
    setTried(true)
    if (nameError) return
    try {
      const saved = driver
        ? await update.mutateAsync({ id: driver.id, version: driver.updatedAt, patch: f })
        : await save.mutateAsync({ ...f, companyCode: null })
      toast.success(driver ? `${saved.name} updated` : `${saved.name} added`)
      onClose(saved)
    } catch {
      /* the hook shows why */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{driver ? `Edit ${driver.name}` : "Add driver"}</DialogTitle>
          <DialogDescription>The one record of this driver: vehicles, trips and fines refer to it, so a change here shows everywhere.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Driver Name" required error={tried ? nameError : undefined}>
            <Input value={f.name} onChange={(e) => set("name")(e.target.value)} maxLength={120} autoFocus aria-invalid={(tried && !!nameError) || undefined} />
          </Field>
          <Field label="Father's Name">
            <Input value={f.fatherName} onChange={(e) => set("fatherName")(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Date of Birth">
            <Input type="date" value={f.dateOfBirth} max={todayISO()} onChange={(e) => set("dateOfBirth")(e.target.value)} />
          </Field>
          <Field label="Phone Number">
            <Input type="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} maxLength={20} placeholder="98765 43210" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea value={f.address} onChange={(e) => set("address")(e.target.value)} rows={2} maxLength={500} />
          </Field>
          <Field label="Driving Licence Number (DL Number)" hint="One DL number, one driver — case and spaces ignored.">
            <Input value={f.licenseNo} onChange={(e) => set("licenseNo")(e.target.value)} maxLength={30} className="uppercase" />
          </Field>
          <Field label="Driving Licence Expiry Date">
            <Input type="date" value={f.licenseValidTill} onChange={(e) => set("licenseValidTill")(e.target.value)} />
          </Field>
          <Field label="Company deployment" hint="From the vehicle the driver is assigned to — assign vehicles on the driver's page.">
            <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{deployment ?? "Unassigned"}</div>
          </Field>
          {driver && (
            <Field label="Status">
              <SimpleSelect value={f.status} onChange={(v) => set("status")(v)} options={STATUS} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onClose()}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
