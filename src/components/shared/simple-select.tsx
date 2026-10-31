"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface Option {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

/** Controlled select for forms (pairs with react-hook-form's Controller). */
export function SimpleSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  id,
  invalid,
  disabled,
}: {
  value: string | null | undefined
  onChange: (v: string) => void
  options: Option[]
  placeholder?: string
  className?: string
  id?: string
  invalid?: boolean
  disabled?: boolean
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={cn("w-full bg-background", className)} aria-invalid={invalid || undefined}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
