"use client"

import { useState } from "react"
import { Lock, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FormModal } from "@/components/shared/form-modal"
import { DeletionReasonField } from "@/components/shared/audit"
import { deletionReasonError } from "@/domain/audit"

/**
 * The one row action pattern for transaction tables: ✏️ Edit, 🗑 Delete — or a 🔒 with the reason
 * when the row can't be changed. Pass only the actions the role may take (see CLAUDE.md →
 * "Record Actions: Edit, Delete and Archive"). Clicks never bubble to the row.
 */
export function RowActions({ onEdit, onDelete, lockedReason, editLabel = "Edit entry", deleteLabel = "Delete entry" }: { onEdit?: () => void; onDelete?: () => void; lockedReason?: string | null; editLabel?: string; deleteLabel?: string }) {
  if (lockedReason)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex size-7 cursor-help items-center justify-center text-muted-foreground pointer-coarse:size-11" tabIndex={0} aria-label={lockedReason} onClick={(e) => e.stopPropagation()}>
            <Lock className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{lockedReason}</TooltipContent>
      </Tooltip>
    )
  if (!onEdit && !onDelete) return null
  return (
    <span className="inline-flex gap-0.5 pointer-coarse:gap-2" onClick={(e) => e.stopPropagation()}>
      {onEdit && <ActionButton label={editLabel} onClick={onEdit} icon={<Pencil />} />}
      {onDelete && <ActionButton label={deleteLabel} onClick={onDelete} icon={<Trash2 />} danger />}
    </span>
  )
}

function ActionButton({ label, onClick, icon, danger }: { label: string; onClick: () => void; icon: React.ReactNode; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild tap={false}>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className={danger ? "hover:bg-destructive/10 hover:text-destructive" : undefined}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Confirmation before any delete: names the record, says which totals change, notes the audit log,
 * and requires a reason. "Delete Entry" stays disabled until the reason is valid and while it runs.
 */
export function DeleteDialog({
  title,
  record,
  impact,
  onConfirm,
  onClose,
  pending,
  submitLabel = "Delete Entry",
}: {
  title: string
  /** What is being deleted, e.g. "TN70AM1921 · 09-10-2026 · 110 L · ₹10,238.80". */
  record: React.ReactNode
  /** Which totals and reports are recalculated. */
  impact: string
  onConfirm: (reason: string) => Promise<unknown>
  onClose: () => void
  pending?: boolean
  submitLabel?: string
}) {
  const [reason, setReason] = useState("")
  const [touched, setTouched] = useState(false)
  const error = deletionReasonError(reason)
  return (
    <FormModal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={`${impact} The deletion will be recorded in the audit log.`}
      submitLabel={submitLabel}
      destructive
      pending={pending}
      submitDisabled={!!error}
      onSubmit={async () => {
        setTouched(true)
        if (pending || error) return
        await onConfirm(reason.trim())
        onClose()
      }}
    >
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm font-medium">{record}</div>
      <DeletionReasonField
        value={reason}
        onChange={(v) => {
          setReason(v)
          setTouched(true)
        }}
        onBlur={() => setTouched(true)}
        error={touched ? error : null}
      />
    </FormModal>
  )
}

/** "October 2026 is locked — only the Owner can change it." */
export const monthLockedReason = (monthLabel: string) => `${monthLabel} is locked — only the Owner can change it.`
