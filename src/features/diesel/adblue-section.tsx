"use client"

import { EditedBadge } from "@/components/shared/audit"
import { useMemo, useState } from "react"
import { Droplets } from "lucide-react"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { DataTable } from "@/components/shared/data-table"
import { EmptyState } from "@/components/shared/misc"
import { canEditMonth } from "@/domain/month-lock"
import type { AdBlueRun } from "@/domain/adblue"
import { useAdBlueEntries, useDeleteAdBlue, useMonthLocks } from "@/lib/api/hooks"
import { monthLabel } from "@/domain/diesel"
import { useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, todayISO } from "@/lib/format"
import type { Customer, Vehicle } from "@/lib/types"
import { AddAdBlueDialog } from "./add-adblue-dialog"

/**
 * Vehicle page → AdBlue tab. Only AdBlue entries are read here; diesel figures are untouched.
 * Editing is explicit (✏️ / 🗑 per row) and only in months the current role may change.
 */
export function AdBlueSection({ vehicle, customer, month, canEdit, canDelete }: { vehicle: Vehicle; customer: Customer | null; month: string; canEdit: boolean; canDelete: boolean }) {
  const entries = useAdBlueEntries()
  const locks = useMonthLocks()
  const [role] = useRole()
  const [editing, setEditing] = useState<AdBlueRun | null>(null)
  const [deleting, setDeleting] = useState<AdBlueRun | null>(null)
  const del = useDeleteAdBlue()
  const customerId = customer?.id ?? null

  const d = useMemo(() => {
    const mine = (entries.data ?? []).filter((e) => e.vehicleId === vehicle.id && e.customerId === customerId)
    return { all: [...mine].sort((a, b) => b.date.localeCompare(a.date) || b.closingKm - a.closingKm) }
  }, [entries.data, vehicle.id, customerId])
  const open = (e: AdBlueRun) => canEditMonth(role, e.date.slice(0, 7), todayISO(), locks.data ?? [])

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-sm font-semibold">AdBlue history · {vehicle.regNo} · all months</h3>
        {d.all.length === 0 ? (
          <EmptyState icon={Droplets} title="No AdBlue entries yet" description="AdBlue top-ups are tracked here, separately from diesel." />
        ) : (
          <DataTable
            data={d.all}
            getRowId={(e) => e.id}
            pageSize={25}
            columns={[
              { id: "date", header: "Date", cell: (e) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={e.date.startsWith(month) ? "num font-medium" : "num text-muted-foreground"}>{formatDate(e.date)}</span>
                    <EditedBadge id={e.id} />
                  </span>
                ) },
              { id: "open", header: "Previous Odometer", align: "right", hideOnMobile: true, cell: (e) => (e.prevKm === null ? "—" : formatNumber(e.prevKm)) },
              { id: "close", header: "Odometer", align: "right", hideOnMobile: true, cell: (e) => formatNumber(e.closingKm) },
              { id: "km", header: "KM Run", align: "right", cell: (e) => (e.kmRun === null ? "—" : formatNumber(e.kmRun)) },
              { id: "qty", header: "AdBlue (L)", align: "right", cell: (e) => formatNumber(e.quantityLitres, 2) },
              { id: "src", header: "Source", hideOnMobile: true, cell: (e) => (e.source === "DIRECT" ? <span className="text-xs">Direct · {e.vendorName}</span> : <span className="text-xs text-muted-foreground">Bulk stock</span>) },
              { id: "amt", header: "Cost", align: "right", cell: (e) => formatINR(e.amount) },
              { id: "kmpl", header: "KM / L AdBlue", align: "right", cell: (e) => (e.kmRun && e.quantityLitres ? (e.kmRun / e.quantityLitres).toFixed(1) : "—") },
              { id: "cpk", header: "Cost / KM", align: "right", cell: (e) => (e.kmRun ? formatINR((e.amount / e.kmRun)) : "—") },
              {
                id: "act",
                header: "",
                align: "right",
                cell: (e) => (
                  <RowActions
                    lockedReason={(canEdit || canDelete) && !open(e) ? monthLockedReason(monthLabel(e.date.slice(0, 7))) : null}
                    onEdit={canEdit ? () => setEditing(e) : undefined}
                    onDelete={canDelete ? () => setDeleting(e) : undefined}
                  />
                ),
              },
            ]}
          />
        )}
      </section>
      {deleting && (
        <DeleteDialog
          title="Delete this AdBlue entry?"
          record={`${vehicle.regNo} · ${formatDate(deleting.date)} · ${formatNumber(deleting.quantityLitres, 2)} L · ${formatINR(deleting.amount)}${deleting.source === "DIRECT" ? ` · direct from ${deleting.vendorName}` : " at average cost"}`}
          impact={
            deleting.source === "DIRECT"
              ? "The vehicle, customer and monthly AdBlue totals are recalculated. Bulk AdBlue stock is not affected. A later entry's KM Run then covers the gap."
              : "The litres go back into AdBlue inventory, and the vehicle, customer and monthly AdBlue totals, stock ledger and carry-forward are recalculated. A later entry's KM Run then covers the gap."
          }
          pending={del.isPending}
          onConfirm={(reason) => del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })}
          onClose={() => setDeleting(null)}
        />
      )}
      {editing && (
        <AddAdBlueDialog key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} vehicle={vehicle} customer={customer} month={editing.date.slice(0, 7)} entry={editing} />
      )}
    </div>
  )
}
