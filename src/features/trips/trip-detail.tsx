"use client"

import { EditedBadge, HistoryButton } from "@/components/shared/audit"
import { DeleteDialog } from "@/components/shared/row-actions"
import { useState } from "react"
import { format, parseISO } from "date-fns"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Lock, Pencil, Route, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DetailList } from "@/components/shared/entity-drawer"
import { EmptyState, NoAccess, PageSkeleton, useLookups } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { PRICING_MODELS } from "@/domain/pricing"
import { useDeleteTrip, useInvoices, useMonthLock, useTrips } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatDateLong, formatINR, formatNumber } from "@/lib/format"
import { TripForm } from "./trip-form"
import { tripDisplayStatus } from "./trip-list"

export function TripDetail({ id }: { id: string }) {
  const router = useRouter()
  const can = useCan()
  const finance = can("finance", "view")
  const trips = useTrips()
  const invoices = useInvoices()
  const lookups = useLookups()
  const del = useDeleteTrip()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // Edit / Delete only while the trip's month is open for this role (the Owner always can).
  const monthLock = useMonthLock(trips.data?.find((x) => x.id === id)?.date.slice(0, 7) ?? "")

  if (!can("trips")) return <NoAccess what="trips" />
  if (trips.isLoading || !lookups.ready) return <PageSkeleton />
  const t = trips.data?.find((x) => x.id === id)
  if (!t) return <EmptyState icon={Route} title="Trip not found" action={<Button asChild variant="outline"><Link href="/trips">Back to trips</Link></Button>} />

  if (editing)
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title={`Edit ${t.tripNo}`} backHref={`/trips/${t.id}`} backLabel={t.tripNo} />
        <TripForm trip={t} onDone={() => setEditing(false)} />
      </div>
    )

  const customer = lookups.customer.get(t.customerId)
  const vehicle = lookups.vehicle.get(t.vehicleId)
  const driver = t.driverId ? lookups.driver.get(t.driverId) : null
  const invoice = t.invoiceId ? invoices.data?.find((i) => i.id === t.invoiceId) : null
  const locked = Boolean(t.invoiceId)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        backHref="/trips"
        backLabel="Trips"
        title={t.tripNo}
        meta={
          <>
            <EditedBadge id={t.id} />
            <HistoryButton id={t.id} />
            <CompanyBadge code={t.companyCode} />
            <StatusBadge status={tripDisplayStatus(t)} />
          </>
        }
        description={`${formatDateLong(t.date)} · ${customer?.name ?? ""}`}
        actions={
          locked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="size-3.5" /> Locked — billed on {invoice?.invoiceNo}
            </span>
          ) : !monthLock.canEdit ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="size-3.5" /> {format(parseISO(t.date), "MMMM yyyy")} is locked — only the Owner can change it
            </span>
          ) : (
            <>
              {can("trips", "delete") && (
                <Button variant="outline" onClick={() => setConfirm(true)}>
                  <Trash2 /> Delete
                </Button>
              )}
              {can("trips", "edit") && (
                <Button onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              )}
            </>
          )
        }
      />
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Assignment</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailList
              items={[
                ["Customer", customer ? <Link className="hover:underline" href={`/customers/${customer.id}`}>{customer.name}</Link> : "—"],
                ["Vehicle", vehicle ? <Link className="hover:underline" href={`/vehicles/${vehicle.id}`}>{vehicle.regNo}</Link> : "—"],
                ["Driver", driver ? `${driver.name} · ${driver.phone}` : "Owner-driven"],
                ["Route", t.route],
                ["Odometer", `${formatNumber(t.startKm)} → ${formatNumber(t.endKm)}`],
                ["Distance", `${formatNumber(t.distanceKm)} km`],
                ["Invoice", invoice ? <Link className="hover:underline" href={`/invoices/${invoice.id}`}>{invoice.invoiceNo}</Link> : "Not invoiced"],
                ["Notes", t.notes || "—"],
              ]}
            />
          </CardContent>
        </Card>
        {finance && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Revenue</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">{PRICING_MODELS[t.pricingModel].label}</p>
              {(
                [
                  ["Base", t.baseAmount],
                  ["Extra km", t.extraKmAmount],
                  ["Driver bata", t.bataAmount],
                  ["Toll & parking", t.tollParking],
                ] as [string, number][]
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="num">{formatINR(v)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 font-semibold">
                <span>Total (ex-GST)</span>
                <span className="num">{formatINR(t.revenue)}</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      {confirm && (
        <DeleteDialog
          title="Delete this trip?"
          submitLabel="Delete Trip"
          record={`${t.tripNo} · ${formatDateLong(t.date)} · ${customer?.name ?? ""} · ${formatINR(t.revenue)}`}
          impact="Its revenue leaves the customer, vehicle and profit totals, and it can no longer be billed."
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: t.id, reason })
            toast.success("Trip deleted")
            router.push("/trips")
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
