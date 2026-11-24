"use client"

import Link from "next/link"
import { CheckCheck, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { actorLabel, formatAuditTime, vehicleDeletionsToReview } from "@/domain/audit"
import { vehicleOutstanding } from "@/domain/tyre"
import { useAuditLog, useMarkReviewed } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatINR } from "@/lib/format"
import { hasOwnerAuthority } from "@/lib/permissions"
import { useTyreData } from "@/features/tyre/tyre-data"

/**
 * Beside the vehicle's registration (owner, 22 Nov 2026): the Audit Log's red count, for this vehicle's deletions still
 * to review. Same review records as the Audit Log (`api.audit.markReviewed`): opening changes nothing; "Mark as reviewed"
 * clears it; a later deletion shows it again; events stay in the Audit Log. Owner-level authority only, as the badge.
 */
export function VehicleDeletionsIndicator({ vehicleId }: { vehicleId: string }) {
  const can = useCan()
  const [role] = useRole()
  const allowed = hasOwnerAuthority(role) && can("audit")
  const log = useAuditLog(allowed)
  const markReviewed = useMarkReviewed()
  const items = allowed ? vehicleDeletionsToReview(log.data ?? [], vehicleId) : []
  if (!items.length) return null
  const n = items.length
  const what = `${n} deletion${n === 1 ? "" : "s"} to review`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-red-600 px-1 text-xs font-medium text-white tabular-nums" aria-label={what} title={what}>
          {n}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="font-medium">{what}</p>
        <ul className="max-h-72 divide-y overflow-y-auto">
          {items.map((e) => (
            <li key={e.id} className="py-2">
              <div className="font-medium">{e.label}</div>
              <div className="text-xs text-muted-foreground">
                {e.module} · deleted by {actorLabel(e.actor)} · {formatAuditTime(e.at)}
              </div>
              {e.reason && <div className="text-xs">Reason: {e.reason}</div>}
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <Link href="/audit" className="text-xs hover:underline">
            Open Audit Log
          </Link>
          <Button
            size="sm"
            disabled={markReviewed.isPending}
            onClick={async () => {
              const done = await markReviewed.mutateAsync(items.map((e) => e.id))
              toast.success(`${done} deletion${done === 1 ? "" : "s"} marked as reviewed`)
            }}
          >
            <CheckCheck /> Mark as reviewed
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Vehicle page → Dues (owner, 22 Nov 2026): what is still owed to tyre vendors on this vehicle's invoices
 * (`vehicleOutstanding`, the Tyres tab's figure). The red mark stays until every invoice is paid; viewing changes nothing.
 */
export function VehicleDuesButton({ vehicleId, onOpen }: { vehicleId: string; onOpen: () => void }) {
  const d = useTyreData()
  const due = d.ready ? vehicleOutstanding(d.views, d.payments, vehicleId) : 0
  return (
    <Button variant="outline" onClick={onOpen} className="relative" title={due > 0 ? `Outstanding to tyre vendors ${formatINR(due)}` : "No outstanding dues"}>
      <Wallet /> Dues
      {due > 0 && (
        <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-red-600 ring-2 ring-background" aria-label={`Outstanding ${formatINR(due)}`} />
      )}
    </Button>
  )
}
