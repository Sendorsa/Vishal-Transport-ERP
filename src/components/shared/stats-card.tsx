import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export interface StatsCardProps {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  /** Percentage change vs previous period. */
  delta?: number | null
  /** When true, a fall is good (e.g. expenses). */
  invertDelta?: boolean
  tone?: "default" | "positive" | "negative" | "warning"
  href?: string
  isLoading?: boolean
  /** How the figure is calculated — shown as an ⓘ tooltip next to the label. */
  info?: string
}

export function StatsCard({ label, value, hint, icon: Icon, delta, invertDelta, tone = "default", href, isLoading, info }: StatsCardProps) {
  const good = delta == null ? null : invertDelta ? delta <= 0 : delta >= 0
  const body = (
    <Card size="sm" className={cn("h-full gap-1.5 px-4 transition-colors", href && "hover:bg-muted/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          <span className="line-clamp-2">{label}</span>
          {info && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`How "${label}" is calculated: ${info}`}
                  className="shrink-0 cursor-help rounded-sm opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2"
                  onClick={(e) => e.preventDefault()}
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{info}</TooltipContent>
            </Tooltip>
          )}
        </span>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      </div>
      {isLoading ? (
        <Skeleton className="h-7 w-28" />
      ) : (
        <div
          className={cn(
            // Exact money (₹4,79,937.62) is long — wrap rather than cut a figure off.
            "num text-lg leading-tight font-semibold tracking-tight [overflow-wrap:anywhere] md:text-xl",
            tone === "positive" && "text-success",
            tone === "negative" && "text-destructive",
            tone === "warning" && "text-warning"
          )}
        >
          {value}
        </div>
      )}
      <div className="flex min-h-4 items-start gap-1.5 text-xs text-muted-foreground">
        {delta != null && !isLoading && (
          <span className={cn("num inline-flex items-center font-medium", good ? "text-success" : "text-destructive")}>
            {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {hint && <span>{hint}</span>}
      </div>
    </Card>
  )
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  )
}
