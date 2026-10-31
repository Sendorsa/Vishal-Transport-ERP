"use client"

import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export function SearchBar({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 bg-background pr-8 pl-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
          <span className="sr-only">Clear search</span>
        </button>
      )}
    </div>
  )
}

export interface FilterOption {
  value: string
  label: string
}

export const ALL = "__all__"

export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  allLabel,
  className,
}: {
  value: string
  onChange: (v: string) => void
  options: FilterOption[]
  placeholder: string
  allLabel?: string
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={cn("h-8 min-w-36 bg-background", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel ?? `All ${placeholder.toLowerCase()}`}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Horizontal toolbar for search + filters; wraps on small screens. */
export function FilterBar({
  children,
  onReset,
  canReset,
  right,
  className,
}: {
  children: React.ReactNode
  onReset?: () => void
  canReset?: boolean
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {onReset && canReset && (
          <Button variant="ghost" size="sm" onClick={onReset} className="text-muted-foreground">
            <X /> Reset
          </Button>
        )}
      </div>
      {right && <div className="flex items-center gap-2 text-xs text-muted-foreground">{right}</div>}
    </div>
  )
}
