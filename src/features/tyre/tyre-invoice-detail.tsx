"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CircleDot, Pencil, Printer, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EditedBadge, HistoryButton } from "@/components/shared/audit"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { canEditMonth } from "@/domain/month-lock"
import { allocationTds, invoiceSettlement, kmRun, OFFICE_LABEL, referenceLabel, settledOf } from "@/domain/tyre"
import { useDeleteTyreInvoice } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, todayISO } from "@/lib/format"
import { DeleteTyreInvoiceDialog } from "./tyre-register"
import { TyreInvoiceDialog } from "./tyre-invoice-form"
import { useTyreData } from "./tyre-data"
import { PayStatusBadge } from "./tyre-vendors"

/** One tyre invoice: header, every repair line with its tax, and the totals — print-friendly (.print-area). */
export function TyreInvoiceDetail({ id, fromSheet, fromVendor }: { id: string; fromSheet?: boolean; fromVendor?: boolean }) {
  const can = useCan()
  const [role] = useRole()
  const router = useRouter()
  const d = useTyreData()
  const del = useDeleteTyreInvoice()
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false) // Edit Invoice: the same modal as Add Invoice, over this page

  if (!can("tyres")) return <NoAccess what="Tyre" />
  if (!d.ready) return <PageSkeleton />
  const v = d.views.find((x) => x.id === id)
  if (!v) return <EmptyState icon={CircleDot} title="Invoice not found" description="It may have been deleted — deletions can be restored from the Audit Log." action={<Button asChild variant="outline"><Link href="/tyre">Back to Tyre</Link></Button>} />

  const open = canEditMonth(role, v.date.slice(0, 7), todayISO(), d.locks)
  const igst = v.items.some((i) => i.taxType === "IGST")
  const cgstSgst = v.items.some((i) => i.taxType === "CGST_SGST")
  const t = v.totals
  const pay = d.payOf(v)
  const split = invoiceSettlement(d.payments, v.id) // settled = cash + TDS (each payment's TDS shared over its allocations)
  // Every payment that settles part of this invoice newest first — incl. one made with the bill.
  const paidBy = d.payments
    .flatMap((p) => p.allocations.filter((a) => a.invoiceId === v.id).map((a) => ({ p, amount: a.amount })))
    .sort((a, b) => b.p.date.localeCompare(a.p.date) || b.p.createdAt.localeCompare(a.p.createdAt))
  const head: [string, React.ReactNode][] = [
    ["Invoice date", formatDate(v.date)],
    ["Bill number", v.billNo || "—"],
    ["Supplier", v.supplier],
    ["Company", v.office ? <span key="o">{OFFICE_LABEL}<span className="block text-xs font-normal text-muted-foreground">No customer — counted in total tyre spend only</span></span> : v.company],
    ["Vehicle number", <span key="r" className="num">{v.regNo}</span>],
    ["Vehicle type", v.vehicleType || "—"],
  ]
  const extra: [string, string][] = (
    [
      ["Mode of purchase", v.purchaseMode],
      ["Mode of payment", v.paymentMode],
      ["Payment details", v.paymentDetails],
      ["Remarks", v.remarks],
    ] as [string, string][]
  ).filter(([, x]) => x)

  return (
    <div className="space-y-4">
      <PageHeader
        backHref={fromSheet ? "/tyre/monthly-sheet" : fromVendor ? `/tyre/vendors/${v.supplierId}` : "/tyre"}
        backLabel={fromSheet ? "Monthly Sheet" : fromVendor ? v.supplier : "Tyre"}
        title={v.billNo ? `Bill ${v.billNo}` : "Tyre invoice"}
        description={`${v.supplier} · ${v.regNo} · ${formatDate(v.date)}`}
        meta={
          <>
            <EditedBadge id={v.id} />
            <HistoryButton id={v.id} />
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can("tyres", "edit") && open && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can("tyres", "delete") && open && (
              <Button variant="outline" className="hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            )}
          </>
        }
      />

      <Card className="print-area overflow-x-auto">
        <CardContent className="min-w-[760px] space-y-6 p-6 md:p-8">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Tyre / repair invoice</div>
              <div className="text-lg font-semibold">{v.supplier}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Grand total</div>
              <div className="num text-2xl font-semibold">{formatINR(t.grandTotal)}</div>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-x-6 gap-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
            {head.map(([k, x]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium">{x}</dd>
              </div>
            ))}
          </dl>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">#</th>
                <th className="py-2 pr-2 font-medium">Repair</th>
                <th className="py-2 pr-2 font-medium">Tyre</th>
                <th className="py-2 pr-2 text-right font-medium">KM</th>
                <th className="py-2 pr-2 text-right font-medium">Qty</th>
                <th className="py-2 pr-2 text-right font-medium">Rate</th>
                <th className="py-2 pr-2 text-right font-medium">Base</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {v.items.map((i, n) => {
                const run = kmRun(i)
                const tyre = [d.name(i.brandId), d.name(i.sizeId)].filter(Boolean).join(" · ")
                return (
                  <tr key={i.id} className="border-b align-top last:border-b-0">
                    <td className="py-2 pr-2 text-muted-foreground">{n + 1}</td>
                    <td className="py-2 pr-2">
                      <div className="font-medium">{d.name(i.repairTypeId)}</div>
                      {i.remarks && <div className="text-xs text-muted-foreground">{i.remarks}</div>}
                    </td>
                    <td className="py-2 pr-2 text-xs">
                      {tyre || (!i.tyreNumber && !i.removingNumber) ? <div>{tyre || "—"}</div> : null}
                      {i.tyreNumber && <div className="text-muted-foreground">No. {i.tyreNumber}</div>}
                      {i.removingNumber && <div className="text-muted-foreground">Removed: {i.removingNumber}</div>}
                    </td>
                    <td className="num py-2 pr-2 text-right text-xs">
                      {i.openingKm !== null || i.closingKm !== null ? (
                        <>
                          <div>
                            {i.openingKm === null ? "—" : formatNumber(i.openingKm)} → {i.closingKm === null ? "—" : formatNumber(i.closingKm)}
                          </div>
                          {run !== null && <div className="text-muted-foreground">{formatNumber(run)} km run</div>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num py-2 pr-2 text-right">{formatNumber(i.quantity, i.quantity % 1 ? 3 : 0)}</td>
                    <td className="num py-2 pr-2 text-right">{formatINR(i.rate)}</td>
                    <td className="num py-2 pr-2 text-right">{formatINR(i.baseValue)}</td>
                    <td className="num py-2 pr-2 text-right text-xs">
                      {i.gstRate === 0 ? (
                        "—"
                      ) : i.taxType === "IGST" ? (
                        <div>IGST {formatNumber(i.gstRate, 2)}% · {formatINR(i.igst)}</div>
                      ) : (
                        <>
                          <div>CGST {formatNumber(i.gstRate / 2, 2)}% · {formatINR(i.cgst)}</div>
                          <div>SGST {formatNumber(i.gstRate / 2, 2)}% · {formatINR(i.sgst)}</div>
                        </>
                      )}
                    </td>
                    <td className="num py-2 text-right font-medium">{formatINR(i.totalValue)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="flex flex-col-reverse gap-6 sm:flex-row sm:items-start sm:justify-between">
            <dl className="grid flex-1 gap-2 text-sm">
              {extra.map(([k, x]) => (
                <div key={k}>
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd>{x}</dd>
                </div>
              ))}
            </dl>
            <div className="w-full space-y-1.5 rounded-lg border p-4 text-sm sm:w-72">
              <Row label={`Base value · ${t.lines} line${t.lines === 1 ? "" : "s"}`} value={t.baseValue} />
              {(cgstSgst || !igst) && <Row label="CGST" value={t.cgst} />}
              {(cgstSgst || !igst) && <Row label="SGST" value={t.sgst} />}
              {igst && <Row label="IGST" value={t.igst} />}
              <div className="flex items-baseline justify-between border-t pt-2">
                <span className="font-semibold">Grand total</span>
                <span className="num text-lg font-semibold">{formatINR(t.grandTotal)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Payment</h2>
            <div className="flex items-center gap-2">
              <PayStatusBadge status={pay.status} />
              <Button variant="outline" size="sm" asChild>
                <Link href={`/tyre/vendors/${v.supplierId}`}>Vendor payments &amp; ledger</Link>
              </Button>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 xl:grid-cols-6">
            {(
              [
                ["Invoice Total", pay.total, ""],
                ["Total Settled", pay.paid, ""],
                ["Actual Amount Paid", split.cash, ""],
                ["TDS Deducted", split.tds, ""],
                ["Outstanding", pay.outstanding, pay.outstanding > 0 ? "text-rose-700 dark:text-rose-400" : ""],
              ] as const
            ).map(([k, x, cls]) => (
              <div key={k} className="rounded-lg border p-3">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className={`num text-base font-semibold ${cls}`}>{formatINR(x)}</dd>
              </div>
            ))}
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Payment Status</dt>
              <dd className="pt-1">
                <PayStatusBadge status={pay.status} />
              </dd>
            </div>
          </dl>
          {paidBy.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment recorded against this invoice{v.paymentMode && v.paymentMode !== "Credit" ? ` (the bill says ${v.paymentMode}, but no payment was recorded)` : ""}. Record one from the vendor&apos;s page.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">Payment date</th>
                    <th className="py-2 pr-2 font-medium">Mode · Reference</th>
                    <th className="py-2 pr-2 text-right font-medium">Payment settled</th>
                    <th className="py-2 pr-2 text-right font-medium">Applied to this bill</th>
                    <th className="py-2 pr-2 text-right font-medium">of which TDS</th>
                    <th className="py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {paidBy.map(({ p, amount }, n) => (
                    <tr key={`${p.id}:${n}`} className="border-b align-top last:border-b-0">
                      <td className="num py-2 pr-2">{formatDate(p.date)}</td>
                      <td className="py-2 pr-2">
                        {p.mode} <span className="num text-xs break-all text-muted-foreground" title={referenceLabel(p.mode)}>· {p.utr}</span>
                      </td>
                      <td className="num py-2 pr-2 text-right">
                        {formatINR(settledOf(p))}
                        {(p.tdsAmount ?? 0) > 0 && <div className="text-xs text-muted-foreground">{formatINR(p.amount)} paid + {formatINR(p.tdsAmount!)} TDS ({p.tdsRate}%)</div>}
                      </td>
                      <td className="num py-2 pr-2 text-right font-medium">{formatINR(amount)}</td>
                      <td className="num py-2 pr-2 text-right text-xs">{(p.tdsAmount ?? 0) > 0 ? formatINR(allocationTds(p, amount)) : "—"}</td>
                      <td className="py-2 text-xs">{p.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing && <TyreInvoiceDialog invoice={v} onClose={() => setEditing(false)} />}
      {deleting && (
        <DeleteTyreInvoiceDialog
          invoice={v}
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: v.id, version: v.updatedAt, reason })
            router.push("/tyre")
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatINR(value)}</span>
    </div>
  )
}
