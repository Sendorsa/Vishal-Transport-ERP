import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
  meta,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  backHref?: string
  backLabel?: string
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
            {backLabel ?? "Back"}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
          {meta}
        </div>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
