"use client"

import { useState } from "react"
import { Check, ChevronsUpDown, Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { expiryOf } from "@/domain/compliance"
import { normReg } from "@/domain/tanker"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ExpenseSection, Vehicle } from "@/lib/types"
import type { ExpenseData } from "./expense-data"

/** "tn 70 av-2412" and "TN70AV2412" are the same search: case, spaces and punctuation ignored. */
const searchKey = (s: string) => normReg(s)

/**
 * Vehicle lookup for the Expense forms: the vehicle master is the only source — no vehicle is ever created here.
 * Single (one vehicle, clearable) or `multiple` (Broker Charges: any number, each removable). Archived vehicles are
 * offered only when the record already names them.
 */
export function VehiclePicker({ d, value, onChange, multiple, keep = [], invalid }: { d: ExpenseData; value: string[]; onChange: (ids: string[]) => void; multiple?: boolean; keep?: string[]; invalid?: boolean }) {
  const [open, setOpen] = useState(false)
  const options = d.vehicles.filter((v) => v.status !== "ARCHIVED" || keep.includes(v.id)).sort((a, b) => a.regNo.localeCompare(b.regNo))
  const selected = value.map((id) => d.vehicle.get(id)).filter((v): v is Vehicle => !!v)
  const pick = (id: string) => {
    if (!multiple) {
      onChange([id])
      setOpen(false)
    } else onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid || undefined} className="min-w-0 flex-1 justify-between bg-background font-normal">
              {multiple ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Plus className="size-4" /> {selected.length ? "Add another vehicle…" : "Search registration to add…"}
                </span>
              ) : (
                <span className={cn("min-w-0 truncate", !selected[0] && "text-muted-foreground")}>{selected[0] ? <span className="num font-medium">{selected[0].regNo}</span> : "Search registration…"}</span>
              )}
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
            <Command filter={(item, search) => (item.split("\u0000")[0].includes(searchKey(search)) || item.split("\u0000")[1].includes(search.trim().toLowerCase()) ? 1 : 0)}>
              <CommandInput placeholder="Registration, e.g. TN70 AV 2412" />
              <CommandList>
                <CommandEmpty>No vehicle with that registration. Vehicles are added under Vehicles, not here.</CommandEmpty>
                <CommandGroup>
                  {options.map((v) => (
                    <CommandItem key={v.id} value={`${searchKey(v.regNo)}\u0000${`${v.regNo} ${d.typeOf(v.id)}`.toLowerCase()}\u0000${v.id}`} onSelect={() => pick(v.id)}>
                      <Check className={cn(value.includes(v.id) ? "opacity-100" : "opacity-0")} />
                      <span className="num font-medium">{v.regNo}</span>
                      <span className="truncate text-xs text-muted-foreground">{d.typeOf(v.id)}</span>
                      {v.status !== "ACTIVE" && <StatusBadge status={v.status} className="ml-auto" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {!multiple && selected[0] && (
          <Button type="button" variant="outline" size="icon" aria-label={`Clear ${selected[0].regNo}`} onClick={() => onChange([])}>
            <X />
          </Button>
        )}
      </div>
      {multiple && selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => (
            <Badge key={v.id} variant="secondary" className="gap-1 pr-1">
              <span className="num">{v.regNo}</span>
              <span className="font-normal text-muted-foreground">{d.typeOf(v.id)}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x !== v.id))} className="rounded-sm p-0.5 hover:bg-muted-foreground/20" aria-label={`Remove ${v.regNo}`}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

/** What the vehicle master already knows about the chosen vehicle — shown, never typed again. */
export function VehicleDetails({ d, vehicleId, date, section, today }: { d: ExpenseData; vehicleId: string; date: string; section: ExpenseSection; today: string }) {
  const v = d.vehicle.get(vehicleId)
  if (!v) return null
  const customerId = d.customerOn(v.id, date)
  const doc = (label: string, till: string | undefined, extra?: string) => {
    const e = expiryOf(till, today)
    return (
      <span>
        {label}: {till ? <span className="num text-foreground">{formatDate(till)}</span> : "not recorded"}
        {till && e.state !== "VALID" && <StatusBadge status={e.state} className="ml-1.5" />}
        {extra}
      </span>
    )
  }
  return (
    <div className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
        <span className="num font-semibold">{v.regNo}</span>
        <span className="text-muted-foreground">{d.typeOf(v.id) || "Type not recorded"}</span>
        <CompanyBadge code={v.companyCode} />
        {v.status !== "ACTIVE" && <StatusBadge status={v.status} />}
      </div>
      <span>Customer on {date ? formatDate(date) : "the date"}: <span className="text-foreground">{customerId ? d.customerName(customerId) : "no customer assignment"}</span></span>
      {section === "ROAD_TAX" && doc("Vehicle master road tax valid till", v.roadTax?.validTill)}
      {section === "INSURANCE" && doc("Vehicle master insurance valid till", v.insurance?.validTill, v.insurance?.provider ? ` · ${v.insurance.provider}${v.insurance.policyNo ? ` · policy ${v.insurance.policyNo}` : ""}` : undefined)}
      {section === "FITNESS" && doc("Vehicle master fitness valid till", v.fitnessValidTill)}
    </div>
  )
}
