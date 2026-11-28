"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, History, Loader2, Lock, LockOpen } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DataTable } from "@/components/shared/data-table"
import { monthLabel } from "@/domain/diesel"
import { EXPENSE_SECTIONS, isMonthLocked, monthSummary } from "@/domain/expenses"
import { MonthSelect } from "@/features/diesel/parts"
import { DATA_BACKEND } from "@/lib/api/client"
import { useLockExpenseMonth } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { canLockExpenseMonths } from "@/lib/permissions"
import { formatINR, formatNumber } from "@/lib/format"
import type { ExpenseSection } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { ExpenseData } from "./expense-data"

/** OPEN (green) or LOCKED (amber, padlock) — the same badge everywhere a month's state is shown. */
export function MonthStateBadge({ locked }: { locked: boolean }) {
  return (
    <Badge variant="outline" className={cn("gap-1 font-semibold tracking-wide", locked ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
      {locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
      {locked ? "LOCKED" : "OPEN"}
    </Badge>
  )
}

/**
 * One Expense section's accounting month (owner, 25 Nov 2026): its own selected month (`month` / `months` from the page's
 * section store), previous / next over that section's months, the month's state, its months
 * (Months) and Lock Month — never another section's records, months or locks.
 */
export function ExpenseMonthBar({ d, section, month, months, onMonth }: { d: ExpenseData; section: ExpenseSection; month: string; months: string[]; onMonth: (m: string) => void }) {
  const [role] = useRole()
  const lock = useLockExpenseMonth()
  const [confirming, setConfirming] = useState(false)
  const [history, setHistory] = useState(false)
  const title = EXPENSE_SECTIONS[section].title
  const locked = isMonthLocked(d.monthLocks, section, month)
  const sum = monthSummary(section, d.expenses, month)
  const i = months.indexOf(month) // newest first
  const label = monthLabel(month)

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon-sm" aria-label="Previous month" disabled={i < 0 || i >= months.length - 1} onClick={() => onMonth(months[i + 1])}>
          <ChevronLeft />
        </Button>
        <MonthSelect months={months} value={month} onChange={onMonth} />
        <Button variant="outline" size="icon-sm" aria-label="Next month" disabled={i <= 0} onClick={() => onMonth(months[i - 1])}>
          <ChevronRight />
        </Button>
        <MonthStateBadge locked={locked} />
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => setHistory(true)}>
          <History /> Months
        </Button>
        {!locked && canLockExpenseMonths(role) && (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Lock /> Lock Month
          </Button>
        )}
      </div>

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                Lock {title} · {label}?
              </DialogTitle>
              <DialogDescription>
                {formatNumber(sum.records)} {title} record{sum.records === 1 ? "" : "s"} dated in {label} become read-only: nothing can be added, edited or deleted in {title} for this month. Totals stay exactly as they are, the records stay viewable and searchable, and the other Expense sections are not affected.
              </DialogDescription>
            </DialogHeader>
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              Locking can&apos;t be undone.{DATA_BACKEND === "supabase" ? " Every device sees the lock." : " This browser only (Phase 1) — not shared with other devices."}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={lock.isPending}
                onClick={async () => {
                  try {
                    await lock.mutateAsync({ section, month })
                    toast.success(`${title} · ${label} locked`)
                    setConfirming(false)
                  } catch {
                    /* the hook shows why */
                  }
                }}
              >
                {lock.isPending ? <Loader2 className="animate-spin" /> : <Lock />} Lock {label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {history && <MonthsDialog d={d} section={section} months={months} current={month} onPick={(m) => { onMonth(m); setHistory(false) }} onClose={() => setHistory(false)} />}
    </div>
  )
}

/** The section's months (its populated months + the current month): state, records, expense, paid — pick one to open it. */
function MonthsDialog({ d, section, months, current, onPick, onClose }: { d: ExpenseData; section: ExpenseSection; months: string[]; current: string; onPick: (m: string) => void; onClose: () => void }) {
  const rows = useMemo(() => months.map((m) => ({ month: m, locked: isMonthLocked(d.monthLocks, section, m), ...monthSummary(section, d.expenses, m) })), [months, section, d.expenses, d.monthLocks])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{EXPENSE_SECTIONS[section].title} months</DialogTitle>
          <DialogDescription>Every month with {EXPENSE_SECTIONS[section].title} records, and the current month. Open one to see its records.</DialogDescription>
        </DialogHeader>
        <DataTable
          data={rows}
          getRowId={(r) => r.month}
          onRowClick={(r) => onPick(r.month)}
          dense
          pageSize={12}
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={cn("font-medium", r.month === current && "text-primary")}>{monthLabel(r.month)}</span> },
            { id: "s", header: "Status", cell: (r) => <MonthStateBadge locked={r.locked} /> },
            { id: "n", header: "Records", align: "right", cell: (r) => <span className="num">{formatNumber(r.records)}</span> },
            { id: "e", header: "Expense", align: "right", cell: (r) => <span className="num">{formatINR(r.expense)}</span> },
            { id: "p", header: "Paid", align: "right", cell: (r) => <span className="num">{formatINR(r.paid)}</span> },
            { id: "o", header: "", align: "right", cell: (r) => <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onPick(r.month) }}>Open</Button> },
          ]}
        />
      </DialogContent>
    </Dialog>
  )
}
