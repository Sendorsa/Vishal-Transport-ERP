"use client"

import { useMemo } from "react"
import { Lock, type LucideIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { PERIOD_OPTIONS, type PeriodPreset } from "@/domain/periods"
import { useCustomers, useDrivers, useFuelStations, useSettings, useVehicles } from "@/lib/api/hooks"
import { formatAxisINR, formatINR } from "@/lib/format"
import { useCan } from "@/lib/app-state"
import type { Action, Resource } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-12 text-center", className)}>
      {Icon && <Icon className="mb-3 size-8 text-muted-foreground/60" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access"
      description={`Your current role can't open ${what}. Switch role from the menu at the top right to explore.`}
    />
  )
}

/** A page only for roles with this permission — e.g. a /new route opened by URL. The API refuses the write either way. */
export function RequirePermission({ resource, action, what, children }: { resource: Resource; action: Action; what: string; children: React.ReactNode }) {
  const can = useCan()
  return can(resource, action) ? children : <NoAccess what={what} />
}

export function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  )
}

export function Money({ value, className, signed }: { value: number; className?: string; signed?: boolean }) {
  return (
    <span className={cn("num", signed && value < 0 && "text-destructive", signed && value > 0 && "text-success", className)}>
      {formatINR(value)}
    </span>
  )
}

export function Field({
  label,
  error,
  hint,
  children,
  className,
  htmlFor,
  required,
}: {
  label: string
  error?: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  htmlFor?: string
  required?: boolean
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b py-5 first:pt-0 last:border-b-0 md:grid-cols-[220px_1fr] md:gap-8">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

export function PeriodSelect({ value, onChange }: { value: PeriodPreset; onChange: (v: PeriodPreset) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PeriodPreset)}>
      <SelectTrigger size="sm" className="h-8 min-w-36 bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {PERIOD_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** id → entity maps for rendering names in tables. Not company-scoped. */
export function useLookups() {
  const customers = useCustomers()
  const vehicles = useVehicles()
  const drivers = useDrivers()
  const settings = useSettings()
  const stations = useFuelStations()
  return useMemo(
    () => ({
      customer: new Map((customers.data ?? []).map((c) => [c.id, c])),
      vehicle: new Map((vehicles.data ?? []).map((v) => [v.id, v])),
      driver: new Map((drivers.data ?? []).map((d) => [d.id, d])),
      vendor: new Map((stations.data ?? []).map((v) => [v.id, v])),
      vehicleType: new Map((settings.data?.vehicleTypes ?? []).map((t) => [t.code, t])),
      category: new Map((settings.data?.expenseCategories ?? []).map((c) => [c.code, c])),
      ready: Boolean(customers.data && vehicles.data && drivers.data && settings.data && stations.data),
    }),
    [customers.data, vehicles.data, drivers.data, settings.data, stations.data]
  )
}

/** Recharts axis tick formatter: ₹12.3 L */
/** Chart y-axis scale labels only — figures (tooltips, cards, tables) are always exact. */
export const inrTick = (v: number) => formatAxisINR(v)
