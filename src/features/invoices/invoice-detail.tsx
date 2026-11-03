"use client"

import { EditedBadge, HistoryButton, ReasonField } from "@/components/shared/audit"
import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { Ban, FileText, Printer, Send, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { FormModal } from "@/components/shared/form-modal"
import { EmptyState, Money, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { invoiceViews } from "@/domain/analytics"
import { useDataset, useInvoiceAction } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { amountInWords, formatDate, formatINR, todayISO } from "@/lib/format"
import { PaymentModal } from "@/features/payments/payment-modal"

export function InvoiceDetail({ id }: { id: string }) {
  const can = useCan()
  const { data: ds, isLoading } = useDataset()
  const action = useInvoiceAction()
  const [receipt, setReceipt] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelReason, setCancelReason] = useState("")

  const d = useMemo(() => {
    if (!ds) return null
    const inv = invoiceViews(ds, todayISO()).find((v) => v.id === id)
    if (!inv) return { inv: null }
    return {
      inv,
      customer: ds.customers.find((c) => c.id === inv.customerId)!,
      company: ds.settings.companies.find((c) => c.code === inv.companyCode)!,
      receipts: inEntryOrder(ds.payments.filter((p) => p.direction === "IN" && p.allocations.some((a) => a.invoiceId === id))),
      tripCount: inv.lines.reduce((s, l) => s + l.tripIds.length, 0),
    }
  }, [ds, id])

  if (!can("invoices")) return <NoAccess what="invoices" />
  if (isLoading || !d) return <PageSkeleton />
  if (!d.inv) return <EmptyState icon={FileText} title="Invoice not found" description="It may belong to the other company — switch to Group view." action={<Button asChild variant="outline"><Link href="/invoices">Back to invoices</Link></Button>} />

  const { inv, customer, company } = d
  const pctPaid = inv.total ? Math.min(100, (inv.settled / inv.total) * 100) : 0
  const half = inv.taxRate / 2

  return (
    <div className="space-y-4">
      <PageHeader
        backHref="/invoices"
        backLabel="Invoices"
        title={inv.invoiceNo}
        meta={
          <>
            <EditedBadge id={inv.id} />
            <HistoryButton id={inv.id} />
            <CompanyBadge code={inv.companyCode} />
            <StatusBadge status={inv.paymentStatus} />
          </>
        }
        description={`${customer!.name} · ${formatDate(inv.periodFrom)} – ${formatDate(inv.periodTo)}`}
        actions={
          <>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {inv.status === "DRAFT" && can("invoices", "edit") && (
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={async () => {
                  await action.mutateAsync({ id: inv.id, version: inv.updatedAt, action: "issue" })
                  toast.success("Invoice issued")
                }}
              >
                <Send /> Issue
              </Button>
            )}
            {inv.status !== "CANCELLED" && inv.settled === 0 && can("invoices", "edit") && (
              <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                <Ban /> Cancel
              </Button>
            )}
            {inv.outstanding > 0 && can("payments", "create") && (
              <Button onClick={() => setReceipt(true)}>
                <Wallet /> Record receipt
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Invoice document */}
        <Card className="print-area overflow-x-auto">
          <CardContent className="min-w-[640px] space-y-6 p-6 md:p-8">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="text-lg font-semibold">{company!.legalName}</div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {company!.address}, {company!.city}, {company!.state}
                  <br />
                  GSTIN {company!.gstin} · PAN {company!.pan}
                  <br />
                  {company!.phone} · {company!.email}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Tax invoice</div>
                <div className="text-lg font-semibold">{inv.invoiceNo}</div>
                <div className="num text-xs text-muted-foreground">
                  Date {formatDate(inv.date)} · Due {formatDate(inv.dueDate)}
                </div>
                {inv.status === "DRAFT" && <div className="mt-1 text-xs font-semibold text-warning">DRAFT — not issued</div>}
                {inv.status === "CANCELLED" && <div className="mt-1 text-xs font-semibold text-destructive">CANCELLED</div>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 rounded-lg border bg-muted/30 p-4 text-sm">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Bill to</div>
                <div className="font-medium">{customer!.legalName}</div>
                <div className="text-xs text-muted-foreground">
                  {customer!.city}, {customer!.state}
                  <br />
                  GSTIN {customer!.gstin || "Unregistered"}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Details</div>
                <div className="text-xs leading-relaxed">
                  Place of supply: {customer!.state} ({customer!.stateCode})
                  <br />
                  Service period: {formatDate(inv.periodFrom)} to {formatDate(inv.periodTo)}
                  <br />
                  {d.tripCount} trips / duties · SAC {inv.lines[0]?.sac}
                </div>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 text-left font-medium">#</th>
                  <th className="py-2 text-left font-medium">Description</th>
                  <th className="py-2 text-right font-medium">Qty</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {inv.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td className="py-2 text-muted-foreground">{i + 1}</td>
                    <td className="py-2">{l.description}</td>
                    <td className="num py-2 text-right">
                      {l.quantity} <span className="text-xs text-muted-foreground">{l.unit}</span>
                    </td>
                    <td className="num py-2 text-right">{formatINR(l.rate)}</td>
                    <td className="num py-2 text-right">{formatINR(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-col items-end gap-1 text-sm">
              <Row label="Taxable value" value={inv.subtotal} />
              {inv.taxType === "CGST_SGST" ? (
                <>
                  <Row label={`CGST @ ${half}%`} value={inv.cgst} />
                  <Row label={`SGST @ ${half}%`} value={inv.sgst} />
                </>
              ) : (
                <Row label={`IGST @ ${inv.taxRate}%`} value={inv.igst} />
              )}
              <div className="mt-1 flex w-72 justify-between border-t pt-2 text-base font-semibold">
                <span>Total</span>
                <span className="num">{formatINR(inv.total)}</span>
              </div>
              <div className="mt-1 max-w-md text-right text-xs text-muted-foreground italic">{amountInWords(inv.total)}</div>
            </div>

            <div className="grid grid-cols-2 gap-6 border-t pt-4 text-xs text-muted-foreground">
              <div>
                <div className="font-medium text-foreground">Bank details</div>
                {company!.bankName} · A/c {company!.bankAccount} · IFSC {company!.ifsc}
                {inv.notes && <div className="mt-2">{inv.notes}</div>}
              </div>
              <div className="text-right">
                For {company!.legalName}
                <div className="mt-8">Authorised signatory</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment tracking */}
        <div className="space-y-4">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Payment status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Progress value={pctPaid} />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Invoice total</span>
                <Money value={inv.total} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Settled (incl. TDS)</span>
                <Money value={inv.settled} className="text-success" />
              </div>
              <div className="flex justify-between border-t pt-2 font-semibold">
                <span>Outstanding</span>
                <Money value={inv.outstanding} className={inv.paymentStatus === "OVERDUE" ? "text-destructive" : ""} />
              </div>
              {inv.paymentStatus === "OVERDUE" && <p className="text-xs text-destructive">{inv.daysOverdue} days past due date ({formatDate(inv.dueDate)}).</p>}
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Receipts ({d.receipts!.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {d.receipts!.length === 0 ? (
                <p className="px-4 py-4 text-center text-sm text-muted-foreground">No receipts yet.</p>
              ) : (
                <ul className="divide-y">
                  {d.receipts!.map((p) => {
                    const a = p.allocations.find((x) => x.invoiceId === id)!
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                        <div>
                          <div className="font-medium">{p.paymentNo}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatDate(p.date)} · {p.mode} {p.tdsAmount ? `· TDS ${formatINR(p.tdsAmount)}` : ""}
                          </div>
                        </div>
                        <Money value={a.amount} />
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
          <Button variant="outline" className="w-full" asChild>
            <Link href={`/customers/${customer!.id}`}>View customer</Link>
          </Button>
        </div>
      </div>

      <PaymentModal open={receipt} onOpenChange={setReceipt} direction="IN" customerId={inv.customerId} invoiceId={inv.id} lockDirection />
      <FormModal
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Cancel ${inv.invoiceNo}?`}
        description="The invoice is kept for audit with status Cancelled, and its trips are released so they can be billed again."
        submitLabel="Cancel invoice"
        destructive
        pending={action.isPending}
        onSubmit={async () => {
          await action.mutateAsync({ id: inv.id, version: inv.updatedAt, action: "cancel", reason: cancelReason })
          toast.success("Invoice cancelled")
          setConfirmCancel(false)
        }}
      >
        <ReasonField value={cancelReason} onChange={setCancelReason} />
      </FormModal>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex w-72 justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatINR(value)}</span>
    </div>
  )
}
