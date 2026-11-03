"use client"

import { useMemo, useState } from "react"
import { CheckCheck, ScrollText, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ActionBadge, AuditEventDetail, DeletionReasonField, SnapshotTable, useRefLookup } from "@/components/shared/audit"
import { FormModal } from "@/components/shared/form-modal"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatusBadge } from "@/components/shared/status-badge"
import { ACTION_LABEL, actorLabel, deletionReasonError, deletionStatus, formatAuditTime, matchesAudit, summarizeChanges, type AuditFilter } from "@/domain/audit"
import type { AuditLogRow } from "@/lib/api"
import { useAuditLog, useMarkReviewed, useRestoreCheck, useRestoreDeleted } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR } from "@/lib/format"
import { LEGACY_ROLES, ROLES, hasOwnerAuthority, roleLabel } from "@/lib/permissions"
import type { AuditAction } from "@/lib/types"

/** Where a record lives in the app (only offered while it still exists). */
function recordHref(e: AuditLogRow): string | null {
  if (!e.recordExists) return null
  const snap = (e.after ?? e.before ?? {}) as Record<string, unknown>
  switch (e.recordType) {
    case "Customer":
      return `/customers/${e.recordId}`
    case "Vehicle":
    case "Vehicle assignment":
      return `/vehicles/${e.recordId}`
    case "Trip":
      return `/trips/${e.recordId}`
    case "Invoice":
      return `/invoices/${e.recordId}`
    case "Fuel station":
      return `/fuel-stations/${e.recordId}`
    case "Fuel station payment":
      return `/fuel-stations/${snap.vendorId}`
    case "Diesel entry":
    case "Diesel entry (from tanker)":
    case "AdBlue entry":
      return `/vehicles/${snap.vehicleId}`
    case "Tanker":
    case "Tanker load":
    case "Tanker dispense (external vehicle)":
    case "Tanker transfer":
    case "Tanker stock adjustment":
      return "/tanker"
    case "AdBlue purchase":
      return "/adblue"
    case "Receipt":
    case "Payment voucher":
      return "/payments"
    case "Driver":
      return "/settings"
    default:
      return null
  }
}

/** A deletion the Owner hasn't reviewed yet. */
const toReview = (e: AuditLogRow) => e.action === "DELETED" && !e.review && !e.restoredBy

/** Needs review / Reviewed / Restored — restoration and review stay separate (domain/audit.ts → deletionStatus). */
function DeletionStatusBadge({ e }: { e: AuditLogRow }) {
  const status = deletionStatus(!!e.review, !!e.restoredBy)
  if (status === "RESTORED") return <StatusBadge status="RESTORED" label={e.review ? "Restored · reviewed" : "Restored"} tone="blue" />
  if (status === "REVIEWED") return <StatusBadge status="REVIEWED" label="Reviewed" tone="green" />
  return <StatusBadge status="TO_REVIEW" label="Needs review" tone="red" />
}

/** One line on what happened, for the table. The dialog has the full before / after. */
function summary(e: AuditLogRow, ref: ReturnType<typeof useRefLookup>) {
  if (e.changes.length) return summarizeChanges(e.changes, ref, 2)
  const amount = (e.after ?? e.before)?.amount
  if (e.action === "PAYMENT_RECORDED") return `${typeof amount === "number" ? formatINR(amount) : ""} ${e.recordType.toLowerCase()} recorded`.trim()
  if (e.action === "CREATED") return "New record added"
  if (e.action === "DELETED") return e.reason ? `Reason: ${e.reason}` : "Record deleted — last values kept here"
  if (e.restoresEventId) return `Brought back from deletion · Reason: ${e.reason ?? "—"}`
  return e.label
}

/**
 * Audit Log — every recorded change across the ERP, newest first. Owner and Dev (`audit` permission):
 * the page checks it, and the API (`api.audit.list`) refuses every other role. Reviewing and restoring
 * deletions stay Owner-only, here and in the API.
 */
export function AuditLog() {
  const can = useCan()
  const allowed = can("audit")
  const [role] = useRole()
  const isOwner = hasOwnerAuthority(role) // review, badge and restore: the Owner and Dev
  const log = useAuditLog(allowed)
  const ref = useRefLookup()
  const [f, setF] = useState<AuditFilter>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [needsReview, setNeedsReview] = useState(false)
  const markReviewed = useMarkReviewed()
  const [restoring, setRestoring] = useState<AuditLogRow | null>(null)
  const set = (k: keyof AuditFilter) => (v: string) => setF((x) => ({ ...x, [k]: v === ALL ? undefined : v || undefined }))

  const rows = useMemo(() => (log.data ?? []).filter((e) => matchesAudit(e, f) && (!needsReview || toReview(e))), [log.data, f, needsReview])
  // Looked up by id so the dialog shows the review as soon as it's saved.
  const open = (log.data ?? []).find((e) => e.id === openId) ?? null
  const options = useMemo(() => {
    const data = log.data ?? []
    return {
      users: [...new Set(data.map((e) => actorLabel(e.actor)))].sort(),
      modules: [...new Set(data.map((e) => e.module))].sort(),
    }
  }, [log.data])

  if (!allowed) return <NoAccess what="the audit log" />
  if (log.isLoading) return <PageSkeleton />
  if (log.error) return <EmptyState icon={ScrollText} title="Audit log unavailable" description={log.error instanceof Error ? log.error.message : undefined} />

  const filtered = Object.values(f).some(Boolean) || needsReview
  const pending = (log.data ?? []).filter(toReview).length
  const shownToReview = rows.filter(toReview).map((e) => e.id)
  const review = async (ids: string[]) => {
    const n = await markReviewed.mutateAsync(ids)
    toast.success(`${n} deletion${n === 1 ? "" : "s"} marked as reviewed`)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Log"
        description="Who created, edited, deleted, archived or paid what, and when — newest first. Users are identified by their role until sign-in is added. Times are IST."
      />

      {isOwner && pending > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <Trash2 className="size-4 text-red-600" />
            <span>
              <span className="font-semibold">{pending}</span> deletion{pending === 1 ? "" : "s"} to review — open each one to see what was deleted and why.
            </span>
          </span>
          {!needsReview && (
            <Button size="sm" variant="outline" onClick={() => setNeedsReview(true)}>
              Show deletions to review
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={needsReview ? "secondary" : "outline"} className="h-8" onClick={() => setNeedsReview((x) => !x)}>
          Needs review{pending ? ` (${pending})` : ""}
        </Button>
        <SearchBar value={f.q ?? ""} onChange={set("q")} placeholder="Search record, field, reason…" />
        <Input type="date" value={f.from ?? ""} onChange={(e) => set("from")(e.target.value)} className="h-8 w-36 bg-background" aria-label="From date" title="From date" />
        <Input type="date" value={f.to ?? ""} onChange={(e) => set("to")(e.target.value)} className="h-8 w-36 bg-background" aria-label="To date" title="To date" />
        <FilterSelect value={f.user ?? ALL} onChange={set("user")} placeholder="Users" options={options.users.map((u) => ({ value: u, label: u }))} />
        <FilterSelect value={f.role ?? ALL} onChange={set("role")} placeholder="Roles" options={[...[...ROLES, ...LEGACY_ROLES].map((r) => ({ value: r.value, label: r.label })), { value: "SYSTEM", label: "System" }]} />
        <FilterSelect value={f.module ?? ALL} onChange={set("module")} placeholder="Modules" options={options.modules.map((m) => ({ value: m, label: m }))} />
        <FilterSelect value={f.action ?? ALL} onChange={set("action")} placeholder="Actions" options={(Object.keys(ACTION_LABEL) as AuditAction[]).map((a) => ({ value: a, label: ACTION_LABEL[a] }))} />
        <Input value={f.recordId ?? ""} onChange={(e) => set("recordId")(e.target.value)} placeholder="Record ID" className="h-8 w-36 bg-background" />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setF({})
              setNeedsReview(false)
            }}
          >
            Clear filters
          </Button>
        )}
        {isOwner && shownToReview.length > 0 && (
          <Button size="sm" className="ml-auto h-8" disabled={markReviewed.isPending} onClick={() => review(shownToReview)}>
            <CheckCheck /> Mark {shownToReview.length} shown deletion{shownToReview.length === 1 ? "" : "s"} as reviewed
          </Button>
        )}
      </div>

      <DataTable
        data={rows}
        getRowId={(e) => e.id}
        dense
        pageSize={50}
        onRowClick={(e) => setOpenId(e.id)}
        emptyMessage={filtered ? "No events match these filters." : "No activity recorded yet. Events appear here as people add, edit or delete records."}
        columns={[
          { id: "at", header: "Date and time", cell: (e) => <span className="num text-xs">{formatAuditTime(e.at)}</span> },
          {
            id: "user",
            header: "User / Role",
            cell: (e) => (
              <div>
                <div className="font-medium">{e.actor.kind === "SYSTEM" ? "System" : (e.actor.name ?? "Unverified session")}</div>
                <div className="text-xs text-muted-foreground">{e.actor.kind === "SYSTEM" ? "App" : e.actor.role ? roleLabel(e.actor.role) : "—"}</div>
              </div>
            ),
          },
          { id: "action", header: "Action", cell: (e) => <ActionBadge action={e.action} fromDeletion={!!e.restoresEventId} /> },
          {
            id: "module",
            header: "Module / Record type",
            hideOnMobile: true,
            cell: (e) => (
              <div>
                <div>{e.module}</div>
                <div className="text-xs text-muted-foreground">{e.recordType}</div>
              </div>
            ),
          },
          {
            id: "record",
            header: "Record",
            cell: (e) => (
              <div className="min-w-0">
                <div className="max-w-56 truncate font-medium">{e.label}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{e.recordId}</div>
              </div>
            ),
          },
          { id: "changes", header: "Summary of changes", cell: (e) => <span className="line-clamp-2 max-w-72 text-xs whitespace-normal">{summary(e, ref)}</span> },
          {
            id: "status",
            header: "Status",
            cell: (e) =>
              e.action === "DELETED" ? (
                <DeletionStatusBadge e={e} />
              ) : e.recordExists === false ? (
                <StatusBadge status="GONE" label="Since deleted" tone="gray" />
              ) : (
                <StatusBadge status="OK" label="Completed" tone="green" />
              ),
          },
        ]}
      />

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpenId(null)}>
          <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>
                {ACTION_LABEL[open.action]} — {open.recordType}
              </DialogTitle>
              <DialogDescription>{open.label}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 text-xs sm:grid-cols-4">
              <Meta label="Module" value={open.module} />
              <Meta label="Record ID" value={<span className="font-mono">{open.recordId}</span>} />
              <Meta label="Transaction date" value={open.recordDate ? formatDate(open.recordDate) : "—"} />
              <Meta label="Record" value={open.recordExists === false ? "Deleted" : open.recordExists ? "Exists" : "—"} />
            </dl>
            <AuditEventDetail event={open} recordHref={recordHref(open)} />
            {open.action === "DELETED" && (
              <div className="space-y-2 border-t pt-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Status:</span>
                  <DeletionStatusBadge e={open} />
                </div>
                {open.restoredBy && (
                  <p className="text-xs text-muted-foreground">
                    Restored by {actorLabel(open.restoredBy.actor)} · {formatAuditTime(open.restoredBy.at)} — reason: {open.restoredBy.reason}
                  </p>
                )}
                {open.review && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed by {actorLabel(open.review.actor)} · {formatAuditTime(open.review.at)}
                  </p>
                )}
                {isOwner && !open.restoredBy && open.restorableType && <RestoreAvailability eventId={open.id} />}
                {isOwner && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {!open.restoredBy && open.restorableType && (
                      <Button size="sm" variant="outline" onClick={() => setRestoring(open)}>
                        <Undo2 /> Restore / Push Back
                      </Button>
                    )}
                    {!open.review && (
                      <Button size="sm" disabled={markReviewed.isPending} onClick={() => review([open.id])}>
                        <CheckCheck /> Mark as reviewed
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {restoring && <RestoreDialog key={restoring.id} event={restoring} onClose={() => setRestoring(null)} />}
    </div>
  )
}

/** Why a deletion can't be restored right now (dry run) — shown instead of letting the button fail later. */
function RestoreAvailability({ eventId }: { eventId: string }) {
  const check = useRestoreCheck(eventId)
  if (!check.data || check.data.ok) return null
  return <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">Can&apos;t be restored right now: {check.data.reason}</p>
}

/**
 * Restore / Push Back confirmation: what was deleted, when, by whom and why; what restoring changes;
 * any conflict to resolve; and a mandatory reason. Nothing is written until "Restore Record".
 */
function RestoreDialog({ event: e, onClose }: { event: AuditLogRow; onClose: () => void }) {
  const check = useRestoreCheck(e.id)
  const restore = useRestoreDeleted()
  const [reason, setReason] = useState("")
  const [touched, setTouched] = useState(false)
  const [notDuplicate, setNotDuplicate] = useState(false)
  const error = deletionReasonError(reason, "restoring")
  const c = check.data
  const blocked = !c || !c.ok || (!!c.duplicate && !notDuplicate)
  return (
    <FormModal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Restore this ${e.recordType.toLowerCase()}?`}
      description="The record comes back with its original ID and values. Its deletion stays in the audit log, and the restore is recorded as a separate event."
      submitLabel="Restore Record"
      pending={restore.isPending}
      submitDisabled={!!error || blocked}
      className="sm:max-w-2xl"
      onSubmit={async () => {
        setTouched(true)
        if (error || blocked || restore.isPending) return
        await restore.mutateAsync({ eventId: e.id, reason: reason.trim(), confirmNotDuplicate: notDuplicate })
        toast.success(`Restored — ${e.label} is back in ${e.module}`)
        onClose()
      }}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs sm:grid-cols-3">
        <Meta label="Record" value={e.label} />
        <Meta label="Record ID" value={<span className="font-mono">{e.recordId}</span>} />
        <Meta label="Module / type" value={`${e.module} · ${e.recordType}`} />
        <Meta label="Deleted" value={formatAuditTime(e.at)} />
        <Meta label="Deleted by" value={actorLabel(e.actor)} />
        <Meta label="Transaction date" value={e.recordDate ? formatDate(e.recordDate) : "—"} />
      </dl>
      <p className="text-sm">
        <span className="text-muted-foreground">Reason for deletion: </span>
        {e.reason ?? "—"}
      </p>
      {e.before && <SnapshotTable snapshot={e.before} />}
      {check.isLoading ? (
        <p className="text-xs text-muted-foreground">Checking whether it can be restored safely…</p>
      ) : c && !c.ok ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">Can&apos;t be restored: {c.reason}</p>
      ) : c?.ok ? (
        <>
          <p className="text-xs text-muted-foreground">{c.note}</p>
          {c.duplicate && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
              <p>
                <span className="font-medium">Possible duplicate:</span> {c.duplicate.label} looks like the same transaction — it may have been re-entered after the deletion. Restoring both would count it twice.
              </p>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={notDuplicate} onCheckedChange={(v) => setNotDuplicate(v === true)} />
                I&apos;ve checked: it&apos;s a different transaction — restore anyway
              </label>
            </div>
          )}
        </>
      ) : null}
      <DeletionReasonField purpose="restoration" value={reason} onChange={(v) => { setReason(v); setTouched(true) }} onBlur={() => setTouched(true)} error={touched ? error : null} />
    </FormModal>
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
