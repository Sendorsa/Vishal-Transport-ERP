"use client"

import { useState } from "react"
import { Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DataTable } from "@/components/shared/data-table"
import { Field } from "@/components/shared/misc"
import { useApplyExpenseImport, useApplyExpenseRollback, useExpenseImportPlan, useExpenseImports, useExpenseRollbackPlan } from "@/lib/api/hooks"
import type { ExpenseImportPlan, ExpenseRollbackReport } from "@/lib/api"
import { formatDate, formatINR } from "@/lib/format"

/**
 * Settings → Data → Import Expense data (Phase 2B, §7; Dev, shared database). Reads a browser backup file, runs the dry
 * run (nothing written), shows the report, and applies it only on an explicit second step. Applied batches can be rolled
 * back the same way (dry run → report → apply); a partial rollback is always reported as PARTIAL.
 */
export function ExpenseImportPanel() {
  const plan = useExpenseImportPlan()
  const apply = useApplyExpenseImport()
  const batches = useExpenseImports()
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null)
  const [label, setLabel] = useState("")
  const [report, setReport] = useState<ExpenseImportPlan | null>(null)

  const pick = async (f: File | undefined) => {
    setReport(null)
    if (!f) return setFile(null)
    try {
      setFile({ name: f.name, data: JSON.parse(await f.text()) })
    } catch {
      toast.error(`${f.name} is not a backup file`)
    }
  }
  const dryRun = async () => {
    if (!file) return
    setReport(await plan.mutateAsync({ file: file.data, label }))
  }
  const applyNow = async () => {
    if (!file || !report) return
    const r = await apply.mutateAsync({ file: file.data, label })
    toast.success(`Imported: batch ${r.batch.id}`)
    setReport(null)
    setFile(null)
  }
  const c = report?.counts

  return (
    <Card size="sm" className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Upload className="size-4" /> Import Expense data (browser backup)
        </CardTitle>
        <CardDescription>
          Dev only. Reads a backup downloaded from a browser (Settings → Data → Export JSON backup) and imports its Expense records, brokers and locks — with their own ids and dates. Drivers and vehicles in the file are never written. Run the dry run first; nothing is saved until you apply.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Backup file" required>
            <Input type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0])} />
          </Field>
          <Field label="Source" required hint="Which computer / browser the file came from">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Office Mac — Chrome" maxLength={80} />
          </Field>
        </div>
        <Button variant="outline" size="sm" disabled={!file || !label.trim() || plan.isPending} onClick={dryRun}>
          {plan.isPending && <Loader2 className="animate-spin" />} Dry run (writes nothing)
        </Button>
        {report && c && (
          <div className="space-y-3 rounded-md border p-3">
            {report.appliedAs && <p className="text-destructive">This file was already imported (batch {report.appliedAs}).</p>}
            {report.blocking.map((b) => (
              <p key={b} className="text-destructive">
                {b}
              </p>
            ))}
            <p>
              Entries — to import <b>{c.expenses.IMPORTED}</b> · already present {c.expenses.ALREADY_PRESENT} · conflicts {c.expenses.CONFLICT} · rejected {c.expenses.REJECTED}. Brokers — new {c.brokers.IMPORTED} · matched {c.brokers.SKIPPED + c.brokers.ALREADY_PRESENT} · conflicts {c.brokers.CONFLICT}. Locks — new {c.expense_month_locks.IMPORTED} · skipped {c.expense_month_locks.SKIPPED} · rejected {c.expense_month_locks.REJECTED}.
            </p>
            <DataTable
              data={report.perMonth}
              getRowId={(r) => `${r.section}-${r.month}`}
              dense
              columns={[
                { id: "s", header: "Section", cell: (r) => r.section },
                { id: "m", header: "Month", cell: (r) => r.month },
                { id: "f", header: "In file", align: "right", cell: (r) => r.file },
                { id: "i", header: "To import", align: "right", cell: (r) => r.toImport },
                { id: "k", header: "Skipped", align: "right", cell: (r) => r.skipped },
                { id: "r", header: "Rejected", align: "right", cell: (r) => r.rejected },
                { id: "a", header: "Σ Amount", align: "right", cell: (r) => <span className="num">{formatINR(r.amount)}</span> },
                { id: "p", header: "Σ Paid", align: "right", cell: (r) => <span className="num">{formatINR(r.paid)}</span> },
              ]}
            />
            {report.items.some((i) => i.outcome === "REJECTED" || i.outcome === "CONFLICT") && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {report.items
                  .filter((i) => i.outcome === "REJECTED" || i.outcome === "CONFLICT")
                  .map((i) => (
                    <li key={`${i.sourceCollection}-${i.sourceId}`}>
                      <Badge variant="outline" className="mr-1">{i.outcome}</Badge>
                      {i.sourceCollection} {i.sourceId}: {i.reason}
                    </li>
                  ))}
              </ul>
            )}
            {report.customerDifferences.length > 0 && <p className="text-xs text-muted-foreground">{report.customerDifferences.length} entries get the customer from the shared assignment history (it differs from the browser&apos;s).</p>}
            <Button size="sm" disabled={!!report.appliedAs || report.blocking.length > 0 || !c.expenses.IMPORTED && !c.brokers.IMPORTED && !c.expense_month_locks.IMPORTED || apply.isPending} onClick={applyNow}>
              {apply.isPending && <Loader2 className="animate-spin" />} Apply import
            </Button>
          </div>
        )}
        {(batches.data ?? []).length > 0 && (
          <div className="space-y-2 pt-2">
            <p className="text-xs font-medium">Applied imports</p>
            {(batches.data ?? []).map((b) => (
              <RollbackRow key={b.id} id={b.id} label={b.sourceLabel} at={b.createdAt} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RollbackRow({ id, label, at }: { id: string; label: string; at: string }) {
  const plan = useExpenseRollbackPlan()
  const apply = useApplyExpenseRollback()
  const [report, setReport] = useState<ExpenseRollbackReport | null>(null)
  const [reason, setReason] = useState("")
  const list = (xs: string[]) => (xs.length ? xs.length : 0)
  return (
    <div className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {id} · {formatDate(at.slice(0, 10))}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-7" disabled={plan.isPending} onClick={async () => setReport(await plan.mutateAsync(id))}>
          Rollback dry run
        </Button>
      </div>
      {report && (
        <div className="space-y-2">
          <p>
            <b>{report.status}</b>
          </p>
          <p>
            In the batch: {report.total.entries} entries, {report.total.brokers} brokers, {report.total.locks} locks (brokers and locks are kept). Eligible for deletion: {list(report.eligible)} · retained — locked section-months: {list(report.retainedLocked)} · changed after import: {list(report.retainedChanged)} · broker ledger: {list(report.retainedLedger)} · already gone: {list(report.alreadyGone)} · deleted: {list(report.deleted)} · remaining after: {report.remaining}.
          </p>
          {report.deleted.length === 0 && report.eligible.length > 0 && (
            <div className="flex items-end gap-2">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={1} placeholder="Reason for the rollback (required)" className="min-h-8" />
              <Button
                size="sm"
                variant="destructive"
                disabled={reason.trim().length < 3 || apply.isPending}
                onClick={async () => {
                  const r = await apply.mutateAsync({ batchId: id, reason })
                  setReport(r)
                  toast.success(`Rollback ${r.status.split(" — ")[0]}`)
                }}
              >
                Delete {report.eligible.length} eligible entries
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
