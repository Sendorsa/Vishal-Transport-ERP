"use client"

import { useMemo } from "react"
import Link from "next/link"
import { ShieldAlert, ShieldCheck } from "lucide-react"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/shared/status-badge"
import { DataTable } from "@/components/shared/data-table"
import { EmptyState } from "@/components/shared/misc"
import { activeDocumentAlerts, type ActiveDocumentAlert } from "@/domain/compliance"
import { formatAuditTime } from "@/domain/audit"
import { formatDate } from "@/lib/format"
import type { ResolvedDocumentAlert, Vehicle } from "@/lib/types"

const vehicleName = (v: Vehicle) => `${v.make ?? ""} ${v.model ?? ""}`.trim()
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function activeText(a: ActiveDocumentAlert) {
  if (a.daysLeft > 0) return { title: `${a.document} expiring soon`, when: `Expiry ${formatDate(a.expiryDate)}`, badge: `${plural(a.daysLeft, "day")} remaining`, tone: "amber" as const }
  if (a.daysLeft === 0) return { title: `${a.document} expires today`, when: `Expiry ${formatDate(a.expiryDate)}`, badge: "Expires today", tone: "red" as const }
  return { title: `${a.document} expired`, when: `Expired ${formatDate(a.expiryDate)}`, badge: `${plural(-a.daysLeft, "day")} overdue`, tone: "red" as const }
}

export const ALERT_RULE_NOTE = "Alerts begin 7 days before Insurance, 5 before Road tax and 30 before PUC and Fitness expire. Permits: not yet."

/** Resolved alerts (kept history), newest first. */
const resolvedAlerts = (vehicles: Vehicle[]) =>
  vehicles
    .flatMap((v) => (v.documentAlertHistory ?? []).map((r) => ({ ...r, vehicle: v })))
    .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt) || (a.id < b.id ? 1 : -1))

function ResolvedAlertList({ resolved, limit }: { resolved: ReturnType<typeof resolvedAlerts>; limit?: number }) {
  if (!resolved.length) return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No resolved alerts yet</p>
  return (
    <ul className="divide-y">
      {resolved.slice(0, limit).map((r: ResolvedDocumentAlert & { vehicle: Vehicle }) => (
        <li key={r.id}>
          <Link href={`/vehicles/${r.vehicle.id}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium">
                {r.document} · {r.regNo}
              </div>
              <div className="text-xs text-muted-foreground">
                Expiry {formatDate(r.expiryDate)} → {r.newExpiryDate ? formatDate(r.newExpiryDate) : "Not recorded"} · alert from {formatDate(r.alertDate)}
              </div>
              <div className="text-xs text-muted-foreground">Resolved {formatAuditTime(r.resolvedAt)}</div>
            </div>
            <StatusBadge status="VALID" label="Resolved" tone="green" className="shrink-0" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Vehicle document expiry alerts (owner, 22 Nov 2026): Active — calculated from today's expiry dates, they stay until the
 * date is updated (viewing changes nothing); Resolved — kept history of alerts whose date was updated. The Dashboard
 * shows this card (Vehicles → Dues has its own table, DocumentDuesView); `limit` caps the rows shown per tab.
 */
export function DocumentAlertsCard({ vehicles, today, limit }: { vehicles: Vehicle[]; today: string; limit?: number }) {
  const active = useMemo(() => activeDocumentAlerts(vehicles, today), [vehicles, today])
  const resolved = useMemo(() => resolvedAlerts(vehicles), [vehicles])
  const more = (n: number) => limit !== undefined && n > limit && <p className="px-4 pt-2 text-xs text-muted-foreground">+{n - limit} more · <Link href="/vehicles" className="hover:underline">Vehicles</Link></p>

  return (
    <Card size="sm" className="gap-2">
      <Tabs defaultValue="active">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert className="size-4 text-warning" /> Document expiry alerts
          </CardTitle>
          <CardAction>
            <TabsList>
              <TabsTrigger value="active">Active ({active.length})</TabsTrigger>
              <TabsTrigger value="resolved">Resolved ({resolved.length})</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <TabsContent value="active">
            {active.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No document needs attention</p>
            ) : (
              <ul className="divide-y">
                {active.slice(0, limit).map((a) => {
                  const t = activeText(a)
                  return (
                    <li key={a.key}>
                      <Link href={`/vehicles/${a.vehicle.id}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-muted/50">
                        <div className="min-w-0">
                          <div className="font-medium">{t.title}</div>
                          <div className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{a.vehicle.regNo}</span>
                            {vehicleName(a.vehicle) && ` · ${vehicleName(a.vehicle)}`} · {t.when}
                          </div>
                        </div>
                        <StatusBadge status={t.tone === "red" ? "EXPIRED" : "EXPIRING"} label={t.badge} tone={t.tone} className="shrink-0" />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
            {more(active.length)}
            <p className="px-4 pt-2 text-xs text-muted-foreground">{ALERT_RULE_NOTE}</p>
          </TabsContent>
          <TabsContent value="resolved">
            <ResolvedAlertList resolved={resolved} limit={limit} />
            {more(resolved.length)}
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  )
}

/**
 * Vehicles → Dues (owner, 22 Nov 2026) — the only place document expiry alerts are managed: every active alert
 * (`activeDocumentAlerts`: upcoming within its warning period, or overdue), one row per document, most urgent first;
 * then the resolved history. A row opens the vehicle, where Edit updates the date; the alert then resolves by itself.
 */
export function DocumentDuesView({ vehicles, today, customerName }: { vehicles: Vehicle[]; today: string; customerName: (v: Vehicle) => string }) {
  const alerts = useMemo(() => activeDocumentAlerts(vehicles, today), [vehicles, today])
  const resolved = useMemo(() => resolvedAlerts(vehicles), [vehicles])
  const days = (a: ActiveDocumentAlert) => (a.daysLeft > 0 ? `${plural(a.daysLeft, "day")} remaining` : a.daysLeft === 0 ? "Expires today" : `${plural(-a.daysLeft, "day")} overdue`)
  return (
    <div className="space-y-4">
      {alerts.length ? (
        <DataTable
          data={alerts}
          getRowId={(a) => a.key}
          rowHref={(a) => `/vehicles/${a.vehicle.id}`}
          pageSize={50}
          columns={[
            {
              id: "reg",
              header: "Vehicle",
              sortValue: (a) => a.vehicle.regNo,
              cell: (a) => (
                <div className="min-w-0">
                  <div className="font-medium">{a.vehicle.regNo}</div>
                  <div className="truncate text-xs text-muted-foreground">{vehicleName(a.vehicle)}</div>
                </div>
              ),
            },
            { id: "customer", header: "Deployed at", hideOnMobile: true, sortValue: (a) => customerName(a.vehicle), cell: (a) => customerName(a.vehicle) },
            { id: "doc", header: "Document", sortValue: (a) => a.document, cell: (a) => a.document },
            { id: "expiry", header: "Expiry date", sortValue: (a) => a.expiryDate, cell: (a) => formatDate(a.expiryDate) },
            { id: "days", header: "Days", align: "right", sortValue: (a) => a.daysLeft, cell: days },
            {
              id: "status",
              header: "Status",
              sortValue: (a) => a.daysLeft,
              cell: (a) => (a.daysLeft < 0 ? <StatusBadge status="EXPIRED" label="Overdue" tone="red" /> : <StatusBadge status="EXPIRING" label="Upcoming" tone={a.daysLeft === 0 ? "red" : "amber"} />),
            },
          ]}
        />
      ) : (
        <EmptyState icon={ShieldCheck} title="No vehicle document alerts." description="Insurance, road tax, PUC and fitness documents appear here when they are about to expire or have expired." />
      )}
      <p className="text-xs text-muted-foreground">{ALERT_RULE_NOTE}</p>
      {resolved.length > 0 && (
        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Resolved alerts ({resolved.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <ResolvedAlertList resolved={resolved} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
