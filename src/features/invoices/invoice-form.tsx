"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { endOfMonth, startOfMonth, subMonths } from "date-fns"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Field, NoAccess } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { buildInvoice, type ManualLineInput } from "@/domain/invoicing"
import { useCreateInvoice, useCustomers, useSettings, useTrips, useVehicles } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatDate, formatINR, formatMonthKey, formatNumber, toISODate, todayDate, todayISO } from "@/lib/format"

export function InvoiceForm({ defaultCustomerId }: { defaultCustomerId?: string }) {
  const router = useRouter()
  const can = useCan()
  const [scope] = useCompanyScope()
  const customers = useCustomers()
  const trips = useTrips()
  const vehicles = useVehicles()
  const settings = useSettings()
  const create = useCreateInvoice()

  const prevMonth = subMonths(todayDate(), 1)
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "")
  // null = automatic: span the selected customer's unbilled trips (falls back to last month)
  const [periodOverride, setPeriodOverride] = useState<{ from: string; to: string } | null>(null)
  const [date, setDate] = useState(todayISO())
  const [taxRate, setTaxRate] = useState<number | null>(null)
  const [notes, setNotes] = useState("")
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [lines, setLines] = useState<ManualLineInput[]>([])

  const customer = customers.data?.find((c) => c.id === customerId)
  const rate = taxRate ?? settings.data?.defaultTaxRate ?? 18

  const autoPeriod = useMemo(() => {
    const dates = (trips.data ?? []).filter((t) => t.customerId === customerId && t.status === "COMPLETED" && !t.invoiceId).map((t) => t.date).sort()
    return dates.length
      ? { from: dates[0], to: dates[dates.length - 1] }
      : { from: toISODate(startOfMonth(prevMonth)), to: toISODate(endOfMonth(prevMonth)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips.data, customerId])
  const periodFrom = periodOverride?.from ?? autoPeriod.from
  const periodTo = periodOverride?.to ?? autoPeriod.to

  const unbilled = useMemo(
    () =>
      (trips.data ?? [])
        .filter((t) => t.customerId === customerId && t.status === "COMPLETED" && !t.invoiceId && t.date >= periodFrom && t.date <= periodTo)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [trips.data, customerId, periodFrom, periodTo]
  )
  // Unbilled counts per customer across all dates — helps pick who to bill.
  const unbilledByCustomer = useMemo(() => {
    const m = new Map<string, number>()
    ;(trips.data ?? []).forEach((t) => {
      if (t.status === "COMPLETED" && !t.invoiceId) m.set(t.customerId, (m.get(t.customerId) ?? 0) + t.revenue)
    })
    return m
  }, [trips.data])

  const selectedIds = useMemo(() => unbilled.filter((t) => !excluded.has(t.id)).map((t) => t.id), [unbilled, excluded])
  const preview = useMemo(() => {
    if (!customer || !settings.data) return null
    return buildInvoice(
      { customerId, date, periodFrom, periodTo, tripIds: selectedIds, extraLines: lines, taxRate: rate, notes, status: "DRAFT" },
      { customer, trips: unbilled, vehicles: vehicles.data ?? [], settings: settings.data }
    )
  }, [customer, customerId, settings.data, date, periodFrom, periodTo, selectedIds, lines, rate, notes, unbilled, vehicles.data])

  if (!can("invoices", "create")) return <NoAccess what="invoice creation" />

  const save = async (status: "DRAFT" | "ISSUED") => {
    if (!customer) return toast.error("Select a customer")
    if (!preview?.lines.length) return toast.error("Select at least one trip or add a line")
    const inv = await create.mutateAsync({
      customerId,
      date,
      periodFrom,
      periodTo,
      tripIds: selectedIds,
      extraLines: lines,
      taxRate: rate,
      notes: notes || `Transport services ${formatDate(periodFrom)} to ${formatDate(periodTo)}`,
      status,
    })
    toast.success(`${inv.invoiceNo} ${status === "ISSUED" ? "issued" : "saved as draft"}`)
    router.push(`/invoices/${inv.id}`)
  }

  const toggleAll = (on: boolean) => setExcluded(on ? new Set() : new Set(unbilled.map((t) => t.id)))

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Customer" required className="sm:col-span-2">
              <SimpleSelect
                value={customerId}
                onChange={(v) => {
                  setCustomerId(v)
                  setExcluded(new Set())
                  setPeriodOverride(null)
                }}
                placeholder="Select customer"
                options={(customers.data ?? [])
                  .filter((c) => scope === "GROUP" || c.companyCode === scope)
                  .map((c) => ({
                    value: c.id,
                    label: `${c.name} · ${c.companyCode}${unbilledByCustomer.get(c.id) ? ` — ${formatINR(unbilledByCustomer.get(c.id)!)} unbilled` : ""}`,
                  }))}
              />
            </Field>
            <Field label="Invoice date" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="GST rate (%)">
              <SimpleSelect value={String(rate)} onChange={(v) => setTaxRate(Number(v))} options={[0, 5, 12, 18].map((r) => ({ value: String(r), label: `${r}%` }))} />
            </Field>
            <Field label="Period from" required>
              <Input type="date" value={periodFrom} onChange={(e) => setPeriodOverride({ from: e.target.value, to: periodTo })} />
            </Field>
            <Field label="Period to" required>
              <Input type="date" value={periodTo} onChange={(e) => setPeriodOverride({ from: periodFrom, to: e.target.value })} />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={`Transport services for ${formatMonthKey(periodFrom.slice(0, 7))}`} />
            </Field>
          </CardContent>
        </Card>

        <Card className="gap-0 pb-0">
          <CardHeader className="border-b pb-3">
            <CardTitle className="text-sm font-semibold">
              Unbilled trips {customer && <span className="font-normal text-muted-foreground">· {selectedIds.length} of {unbilled.length} selected</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {!customer ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">Pick a customer to load completed, un-invoiced trips.</p>
            ) : unbilled.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">No unbilled trips in this period. Adjust the dates or add manual lines below.</p>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="w-10 px-4 py-2 text-left">
                        <Checkbox checked={excluded.size === 0 ? true : selectedIds.length === 0 ? false : "indeterminate"} onCheckedChange={(c) => toggleAll(c === true)} />
                      </th>
                      <th className="py-2 text-left font-medium">Date</th>
                      <th className="py-2 text-left font-medium">Vehicle</th>
                      <th className="hidden py-2 text-left font-medium md:table-cell">Route</th>
                      <th className="py-2 text-right font-medium">Km</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {unbilled.map((t) => (
                      <tr key={t.id} className="hover:bg-muted/40">
                        <td className="px-4 py-1.5">
                          <Checkbox
                            checked={!excluded.has(t.id)}
                            onCheckedChange={(c) =>
                              setExcluded((s) => {
                                const n = new Set(s)
                                if (c) n.delete(t.id)
                                else n.add(t.id)
                                return n
                              })
                            }
                          />
                        </td>
                        <td className="num py-1.5">{formatDate(t.date)}</td>
                        <td className="py-1.5">{vehicles.data?.find((v) => v.id === t.vehicleId)?.regNo}</td>
                        <td className="hidden max-w-60 truncate py-1.5 text-muted-foreground md:table-cell">{t.route}</td>
                        <td className="num py-1.5 text-right">{formatNumber(t.distanceKm)}</td>
                        <td className="num px-4 py-1.5 text-right">{formatINR(t.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Additional lines</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_72px_110px_auto] gap-2">
                <Input value={l.description} placeholder="e.g. Extra trip — 12 Sep, night shift" onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                <Input type="number" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
                <Input type="number" step="0.01" value={l.rate} placeholder="Rate" onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} />
                <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { description: "", quantity: 1, rate: 0 }])}>
              <Plus /> Add line
            </Button>
            <p className="text-xs text-muted-foreground">Use a negative rate for deductions (e.g. canteen recovery).</p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card size="sm" className="xl:sticky xl:top-16">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Invoice preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!preview || !preview.lines.length ? (
              <p className="text-muted-foreground">Lines appear here as you select trips.</p>
            ) : (
              <>
                <ul className="divide-y rounded-lg border">
                  {preview.lines.map((l) => (
                    <li key={l.id} className="flex justify-between gap-3 px-3 py-1.5">
                      <span className="min-w-0 truncate">{l.description}</span>
                      <span className="num shrink-0">{formatINR(l.amount)}</span>
                    </li>
                  ))}
                </ul>
                <div className="space-y-1">
                  <Line label="Taxable value" value={preview.subtotal} />
                  {preview.taxType === "CGST_SGST" ? (
                    <>
                      <Line label={`CGST @ ${rate / 2}%`} value={preview.cgst} />
                      <Line label={`SGST @ ${rate / 2}%`} value={preview.sgst} />
                    </>
                  ) : (
                    <Line label={`IGST @ ${rate}%`} value={preview.igst} />
                  )}
                  <div className="flex justify-between border-t pt-2 text-base font-semibold">
                    <span>Total</span>
                    <span className="num">{formatINR(preview.total)}</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {preview.taxType === "IGST" ? "Inter-state supply (customer outside company state) → IGST." : "Intra-state supply → CGST + SGST."} Due {formatDate(preview.dueDate)} ({customer?.creditDays} days).
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button variant="outline" disabled={create.isPending} onClick={() => save("DRAFT")}>
            Save draft
          </Button>
          <Button disabled={create.isPending} onClick={() => save("ISSUED")}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Issue invoice
          </Button>
        </div>
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatINR(value)}</span>
    </div>
  )
}
