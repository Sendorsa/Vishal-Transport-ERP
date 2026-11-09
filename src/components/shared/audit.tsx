"use client"

import { useState } from "react"
import Link from "next/link"
import { History, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Field } from "@/components/shared/misc"
import { StatusBadge } from "@/components/shared/status-badge"
import { ACTION_LABEL, actorLabel, fieldLabel, formatAuditTime, formatAuditValue, type RefLookup } from "@/domain/audit"
import { useCustomers, useDrivers, useEditedIds, useFuelStations, useRecordHistory, useVehicles } from "@/lib/api/hooks"
import { formatDate } from "@/lib/format"
import type { AuditAction, AuditEvent } from "@/lib/types"

/** Optional "Reason for change" on edits and deletes; stored on the audit event. */
export function ReasonField({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Field label="Reason for change" hint="Optional — saved in the record's edit history" className={className}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. Incorrect litres entered" maxLength={200} />
    </Field>
  )
}

/** Mandatory "Reason for deletion" (deletionReasonError: trimmed, never empty or whitespace-only). */
export function DeletionReasonField({
  value,
  onChange,
  onBlur,
  error,
  purpose = "deletion",
}: {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  error?: string | null
  /** The same mandatory reason serves deleting, restoring, correcting (an assignment's start date) and back-dating a transfer. */
  purpose?: "deletion" | "restoration" | "correction" | "back-dating"
}) {
  const label = { deletion: "Reason for deletion", restoration: "Reason for restoring", correction: "Reason for correction", "back-dating": "Reason for back-dating" }[purpose]
  const placeholder = {
    deletion: "Enter the reason for deleting this record…",
    restoration: "e.g. Deleted by mistake — restoring the original entry",
    correction: "e.g. Correction of incorrectly entered assignment start date",
    "back-dating": "e.g. Vehicle started working for the new customer on this date; transfer entered late",
  }[purpose]
  const what = purpose === "back-dating" ? "transfer" : purpose
  return (
    <Field label={label} required error={error ?? undefined} hint={`Required — kept in the audit log with this ${what}`}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder} maxLength={200} aria-required="true" aria-invalid={!!error} autoFocus={purpose === "deletion" || purpose === "restoration"} />
    </Field>
  )
}

/** Resolves vehicle / customer / station / driver ids to names for audit values. */
export function useRefLookup(): RefLookup {
  const vehicles = useVehicles()
  const customers = useCustomers()
  const stations = useFuelStations()
  const drivers = useDrivers()
  return (kind, id) => {
    if (kind === "vehicle") return vehicles.data?.find((v) => v.id === id)?.regNo
    if (kind === "customer") return customers.data?.find((c) => c.id === id)?.shortName
    if (kind === "station") return stations.data?.find((s) => s.id === id)?.name
    return drivers.data?.find((d) => d.id === id)?.name
  }
}

const ACTION_TONE: Partial<Record<AuditAction, "green" | "amber" | "red" | "blue" | "gray" | "violet">> = {
  CREATED: "green",
  PAYMENT_RECORDED: "green",
  UPDATED: "amber",
  DELETED: "red",
  ARCHIVED: "red",
  RESTORED: "blue",
  TRANSFERRED: "violet",
}

/** `fromDeletion`: a RESTORED event that brought back a deleted record (vs. an archive being restored). */
export function ActionBadge({ action, fromDeletion }: { action: AuditAction; fromDeletion?: boolean }) {
  return <StatusBadge status={action} label={fromDeletion ? "Restored from deletion" : ACTION_LABEL[action]} tone={ACTION_TONE[action] ?? "gray"} />
}

/** A record snapshot as Field | Value — the business fields only. */
export function SnapshotTable({ snapshot }: { snapshot: Record<string, unknown> }) {
  const ref = useRefLookup()
  const fields = Object.keys(snapshot).filter((f) => !["id", "createdAt", "updatedAt", "companyCode", "statusHistory"].includes(f))
  return <ValuesTable rows={fields.map((f) => ({ field: f, before: snapshot[f], after: undefined, changed: false }))} ref_={ref} showAfter={false} />
}

/**
 * "Edited" marker for a record that has been changed since it was created. Opens its full history.
 * Click events stop here so a clickable table row doesn't also navigate.
 */
export function EditedBadge({ id }: { id: string }) {
  const edited = useEditedIds()
  const [open, setOpen] = useState(false)
  if (!edited.data?.has(id)) return null
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="This record was edited — view its history"
        className="inline-flex h-4.5 items-center gap-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
      >
        <Pencil className="size-2.5" /> Edited
      </button>
      {open && <RecordHistoryDialog recordId={id} onOpenChange={setOpen} />}
    </span>
  )
}

/** Button that opens a record's history (for detail pages, edited or not). */
export function HistoryButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History /> History
      </Button>
      {open && <RecordHistoryDialog recordId={id} onOpenChange={setOpen} />}
    </>
  )
}

/** Every event of one record, newest first, each with its changed fields. */
export function RecordHistoryDialog({ recordId, onOpenChange }: { recordId: string; onOpenChange: (o: boolean) => void }) {
  const history = useRecordHistory(recordId, true)
  const events = [...(history.data ?? [])].reverse()
  const latest = events[0]
  const edits = events.filter((e) => e.action === "UPDATED").length
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit History{latest ? ` — ${latest.recordType}` : ""}</DialogTitle>
          <DialogDescription>
            {latest ? (
              <>
                {latest.label} · {edits} edit{edits === 1 ? "" : "s"} · {events.length} event{events.length === 1 ? "" : "s"} recorded
              </>
            ) : (
              "Changes to this record"
            )}
          </DialogDescription>
        </DialogHeader>
        {history.isLoading ? (
          <Skeleton className="h-40" />
        ) : !events.length ? (
          <p className="text-sm text-muted-foreground">No recorded changes. Changes are recorded from the day the audit trail was switched on.</p>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 text-xs sm:grid-cols-3">
              <Meta label="Record type" value={latest.recordType} />
              <Meta label="Record ID" value={<span className="font-mono">{latest.recordId}</span>} />
              <Meta label="Transaction date" value={latest.recordDate ? formatDate(latest.recordDate) : "—"} />
            </dl>
            {events.map((e, i) => (
              <div key={e.id} className="rounded-lg border p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">Version {events.length - i}</div>
                <AuditEventDetail event={e} />
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  )
}

/** Who / when / why, the changed fields (Previous → New) and, on request, the complete snapshots. */
export function AuditEventDetail({ event: e, recordHref }: { event: AuditEvent; recordHref?: string | null }) {
  const ref = useRefLookup()
  // A deletion has no "after": show the record's last values (amounts, litres…) straight away.
  const [full, setFull] = useState(e.action === "DELETED")
  const fields = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])]
  const changed = new Set(e.changes.map((c) => c.field))
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ActionBadge action={e.action} fromDeletion={!!e.restoresEventId} />
        <span>
          by <span className="font-medium">{actorLabel(e.actor)}</span>
        </span>
        <span className="text-muted-foreground">{formatAuditTime(e.at)}</span>
        {recordHref && (
          <Link href={recordHref} className="text-xs font-medium text-primary hover:underline">
            Open record →
          </Link>
        )}
      </div>
      {e.reason && (
        <p className="text-xs">
          <span className="text-muted-foreground">{e.action === "DELETED" ? "Reason for deletion: " : e.restoresEventId ? "Reason for restoring: " : "Reason: "}</span>
          {e.reason}
        </p>
      )}
      {e.note && <p className="text-xs text-muted-foreground">{e.note}</p>}
      {e.changes.length > 0 && !full && (
        <ValuesTable rows={e.changes.map((c) => ({ field: c.field, before: c.before, after: c.after, changed: true }))} ref_={ref} />
      )}
      {full && fields.length > 0 && <ValuesTable rows={fields.map((f) => ({ field: f, before: e.before?.[f], after: e.after?.[f], changed: changed.has(f) }))} ref_={ref} showBefore={!!e.before} showAfter={!!e.after} />}
      {e.changes.length === 0 && !full && e.action !== "UPDATED" && (e.before || e.after) && (
        <p className="text-xs text-muted-foreground">{e.after && !e.before ? "New record — see the full snapshot for its values." : "Removed record — see the full snapshot for its last values."}</p>
      )}
      {fields.length > 0 && (e.changes.length > 0 || !full) && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setFull((x) => !x)}>
          {full ? "Show changed fields only" : "View complete before / after snapshot"}
        </Button>
      )}
    </div>
  )
}

function ValuesTable({ rows, ref_, showBefore = true, showAfter = true }: { rows: { field: string; before: unknown; after: unknown; changed: boolean }[]; ref_: RefLookup; showBefore?: boolean; showAfter?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="h-8 text-xs">Field</TableHead>
            {showBefore && <TableHead className="h-8 text-xs">Previous Value</TableHead>}
            {showAfter && <TableHead className="h-8 text-xs">New Value</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.field} className={r.changed ? "bg-amber-500/5" : ""}>
              <TableCell className="py-1.5 text-xs font-medium">{fieldLabel(r.field)}</TableCell>
              {showBefore && <TableCell className="num py-1.5 text-xs whitespace-normal break-all">{formatAuditValue(r.field, r.before, ref_)}</TableCell>}
              {showAfter && <TableCell className={`num py-1.5 text-xs whitespace-normal break-all ${r.changed ? "font-semibold" : ""}`}>{formatAuditValue(r.field, r.after, ref_)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
