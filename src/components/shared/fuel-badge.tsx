import { Badge } from "@/components/ui/badge"
import { fuelTheme } from "@/lib/fuel-theme"
import type { FuelType } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A vehicle's or a fill's fuel type, in its own colour (lib/fuel-theme.ts). `count` adds a number ("Petrol 11"). */
export function FuelBadge({ fuel, count, className }: { fuel: FuelType; count?: number; className?: string }) {
  const t = fuelTheme(fuel)
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", t.badge, className)}>
      <span className={cn("size-1.5 rounded-full", t.dot)} aria-hidden />
      {t.label}
      {count !== undefined && <span className="num">{count}</span>}
    </Badge>
  )
}
