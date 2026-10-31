"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Building2, Check, Database, Download, Plus, RotateCcw, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable } from "@/components/shared/data-table"
import { FormModal } from "@/components/shared/form-modal"
import { Field, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatusBadge } from "@/components/shared/status-badge"
import { fetchBackup, useAdminAction, useDrivers, useRestoreBackup, useSetDriverStatus, useSettings, useUpdateSettings } from "@/lib/api/hooks"
import { useCan, useRole, useSession } from "@/lib/app-state"
import { STATES } from "@/lib/constants"
import { formatDate } from "@/lib/format"
import { can as canRole, ROLES, type Resource } from "@/lib/permissions"
import { storageUsage } from "@/lib/storage/local-store"
import type { CompanyProfile, EntityStatus, ExpenseCategory, Settings, VehicleType } from "@/lib/types"
import { cn } from "@/lib/utils"

export function SettingsView() {
  const can = useCan()
  const settings = useSettings()
  const update = useUpdateSettings()
  const editable = can("settings", "edit")

  if (!can("settings")) return <NoAccess what="settings" />
  if (settings.isLoading || !settings.data) return <PageSkeleton />
  const s = settings.data

  const patch = async (p: Partial<Settings>, msg = "Settings saved") => {
    await update.mutateAsync(p)
    toast.success(msg)
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Company profiles, master lists and demo controls."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/users">User accounts</Link>
          </Button>
        }
      />
      <Tabs defaultValue="company">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="company">Company profile</TabsTrigger>
          <TabsTrigger value="categories">Expense categories</TabsTrigger>
          <TabsTrigger value="drivers">Drivers</TabsTrigger>
          <TabsTrigger value="types">Vehicle types</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="company" className="mt-4 space-y-4">
          <GroupStructure companies={s.companies} />
          <div className="grid gap-4 xl:grid-cols-2">
            {s.companies.map((c) => (
              <CompanyCard
                key={JSON.stringify(c)}
                company={c}
                editable={editable}
                pending={update.isPending}
                onSave={(next) => patch({ companies: s.companies.map((x) => (x.code === next.code ? next : x)) }, `${next.name} saved`)}
              />
            ))}
          </div>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Tax defaults</CardTitle>
            </CardHeader>
            <CardContent>
              <TaxDefaults settings={s} editable={editable} onSave={(p) => patch(p)} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="categories" className="mt-4">
          <CategoryManager items={s.expenseCategories} editable={editable} onChange={(expenseCategories) => patch({ expenseCategories })} />
        </TabsContent>

        <TabsContent value="drivers" className="mt-4">
          <DriverManager editable={editable} />
        </TabsContent>

        <TabsContent value="types" className="mt-4">
          <VehicleTypeManager items={s.vehicleTypes} editable={editable} onChange={(vehicleTypes) => patch({ vehicleTypes })} />
        </TabsContent>

        <TabsContent value="roles" className="mt-4">
          <RolesPanel />
        </TabsContent>

        <TabsContent value="data" className="mt-4">
          <DataPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------------------------------------------ Company */

function GroupStructure({ companies }: { companies: CompanyProfile[] }) {
  const parent = companies.find((c) => c.isPrimary)
  const children = companies.filter((c) => c.parentCode === parent?.code)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Group structure</CardTitle>
        <CardDescription>One tenant · VT is the primary company and manages VTHPL and the Vishal Gasoline outlet.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 text-sm md:flex-row md:items-center">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 font-medium">Vishal Group</div>
          <span className="hidden text-muted-foreground md:inline">→</span>
          {parent && (
            <div className="rounded-lg border px-3 py-2">
              <div className="font-medium">{parent.name} (primary)</div>
              <div className="text-xs text-muted-foreground">Goods transport · Property · Vishal Gasoline (Jio-bp)</div>
            </div>
          )}
          <span className="hidden text-muted-foreground md:inline">→ manages →</span>
          {children.map((c) => (
            <div key={c.code} className="rounded-lg border px-3 py-2">
              <div className="font-medium">{c.legalName}</div>
              <div className="text-xs text-muted-foreground">Staff & school buses · Taxi · Manpower</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function CompanyCard({ company, editable, pending, onSave }: { company: CompanyProfile; editable: boolean; pending: boolean; onSave: (c: CompanyProfile) => void }) {
  const [c, setC] = useState(company)
  const dirty = JSON.stringify(c) !== JSON.stringify(company)
  const set = <K extends keyof CompanyProfile>(k: K) => (v: CompanyProfile[K]) => setC((x) => ({ ...x, [k]: v }))
  const text = (k: keyof CompanyProfile, label: string, cls?: string) => (
    <Field label={label} className={cls}>
      <Input value={String(c[k] ?? "")} disabled={!editable} onChange={(e) => set(k)(e.target.value as never)} />
    </Field>
  )
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="size-4" /> {company.name}
          <StatusBadge status={company.code} />
          {company.isPrimary && <StatusBadge status="PRIMARY" label="Primary" tone="green" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {text("legalName", "Legal name", "sm:col-span-2")}
        {text("gstin", "GSTIN")}
        {text("pan", "PAN")}
        {text("address", "Address", "sm:col-span-2")}
        {text("city", "City")}
        <Field label="State">
          <SimpleSelect
            value={c.state}
            disabled={!editable}
            onChange={(v) => setC((x) => ({ ...x, state: v, stateCode: STATES.find((st) => st.name === v)?.code ?? x.stateCode }))}
            options={STATES.map((st) => ({ value: st.name, label: `${st.name} (${st.code})` }))}
          />
        </Field>
        {text("phone", "Phone")}
        {text("email", "Email")}
        {text("bankName", "Bank")}
        {text("bankAccount", "Account no.")}
        {text("ifsc", "IFSC")}
        {text("invoicePrefix", "Invoice prefix")}
        {editable && (
          <div className="flex items-end justify-end gap-2 sm:col-span-2">
            <Button variant="outline" disabled={!dirty} onClick={() => setC(company)}>
              Discard
            </Button>
            <Button disabled={!dirty || pending} onClick={() => onSave(c)}>
              Save {company.code}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TaxDefaults({ settings, editable, onSave }: { settings: Settings; editable: boolean; onSave: (p: Partial<Settings>) => void }) {
  const [v, setV] = useState({ defaultTaxRate: settings.defaultTaxRate, tdsRate: settings.tdsRate, sacCode: settings.sacCode })
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label="Default GST rate (%)">
        <Input type="number" value={v.defaultTaxRate} disabled={!editable} onChange={(e) => setV({ ...v, defaultTaxRate: Number(e.target.value) })} />
      </Field>
      <Field label="Customer TDS rate (%)" hint="194C transport">
        <Input type="number" step="0.1" value={v.tdsRate} disabled={!editable} onChange={(e) => setV({ ...v, tdsRate: Number(e.target.value) })} />
      </Field>
      <Field label="SAC code">
        <Input value={v.sacCode} disabled={!editable} onChange={(e) => setV({ ...v, sacCode: e.target.value })} />
      </Field>
      {editable && (
        <div className="flex items-end">
          <Button variant="outline" onClick={() => onSave(v)}>
            Save tax defaults
          </Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Master lists */

function ActiveToggle({ active, disabled, onChange }: { active: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <Switch checked={active} disabled={disabled} onCheckedChange={onChange} onClick={(e) => e.stopPropagation()} />
}

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "ARCHIVED", label: "Archived" },
]

/** Active / Inactive / Archived. Archived records stay in every report but can't be picked for new entries. */
function StatusSelect({ value, disabled, onChange }: { value: EntityStatus; disabled?: boolean; onChange: (s: EntityStatus) => void }) {
  if (disabled) return <StatusBadge status={value} />
  return <SimpleSelect value={value} onChange={(v) => onChange(v as EntityStatus)} options={STATUS_OPTIONS} className="ml-auto h-8 w-32" />
}

function DriverManager({ editable }: { editable: boolean }) {
  const drivers = useDrivers()
  const setStatus = useSetDriverStatus()
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Drivers are added from the vehicle form. Archive a driver who has left — past trips and vehicles still show their name.</p>
      <DataTable
        data={[...(drivers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))}
        getRowId={(d) => d.id}
        pageSize={50}
        columns={[
          { id: "name", header: "Driver", cell: (d) => <span className={d.status === "ARCHIVED" ? "font-medium text-muted-foreground" : "font-medium"}>{d.name}</span> },
          { id: "phone", header: "Phone", cell: (d) => <span className="text-muted-foreground">{d.phone || "—"}</span> },
          {
            id: "status",
            header: "Status",
            align: "right",
            cell: (d) => (
              <StatusSelect
                value={d.status}
                disabled={!editable}
                onChange={async (status) => {
                  await setStatus.mutateAsync({ id: d.id, status })
                  toast.success(`${d.name} ${status === "ARCHIVED" ? "archived — history kept" : status === "ACTIVE" ? "restored" : "set inactive"}`)
                }}
              />
            ),
          },
        ]}
      />
    </div>
  )
}

function CategoryManager({ items, editable, onChange }: { items: ExpenseCategory[]; editable: boolean; onChange: (x: ExpenseCategory[]) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ name: "", kind: "EXPENSE", vehicleLinked: "no" })
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Heads used on outgoing payments. Settlement heads clear a liability and stay out of the P&L.</p>
        {editable && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> Add category
          </Button>
        )}
      </div>
      <DataTable
        data={items}
        getRowId={(c) => c.code}
        pageSize={50}
        columns={[
          { id: "name", header: "Name", cell: (c) => <span className="font-medium">{c.name}</span> },
          { id: "code", header: "Code", hideOnMobile: true, cell: (c) => <code className="text-xs text-muted-foreground">{c.code}</code> },
          { id: "kind", header: "Type", cell: (c) => <StatusBadge status={c.kind} label={c.kind === "EXPENSE" ? "P&L expense" : "Settlement"} tone={c.kind === "EXPENSE" ? "blue" : "gray"} /> },
          { id: "veh", header: "Vehicle-linked", hideOnMobile: true, cell: (c) => (c.vehicleLinked ? <Check className="size-4 text-success" /> : <X className="size-4 text-muted-foreground" />) },
          { id: "active", header: "Active", align: "right", cell: (c) => <ActiveToggle active={c.active} disabled={!editable} onChange={(a) => onChange(items.map((x) => (x.code === c.code ? { ...x, active: a } : x)))} /> },
        ]}
      />
      <FormModal
        open={open}
        onOpenChange={setOpen}
        title="New expense category"
        onSubmit={() => {
          const code = draft.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")
          if (!code) return toast.error("Enter a name")
          if (items.some((x) => x.code === code)) return toast.error("A category with this name exists")
          onChange([...items, { code, name: draft.name.trim(), kind: draft.kind as ExpenseCategory["kind"], vehicleLinked: draft.vehicleLinked === "yes", active: true }])
          setDraft({ name: "", kind: "EXPENSE", vehicleLinked: "no" })
          setOpen(false)
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="AdBlue" />
          </Field>
          <Field label="Type">
            <SimpleSelect value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v })} options={[{ value: "EXPENSE", label: "P&L expense" }, { value: "SETTLEMENT", label: "Settlement" }]} />
          </Field>
          <Field label="Linked to a vehicle?">
            <SimpleSelect value={draft.vehicleLinked} onChange={(v) => setDraft({ ...draft, vehicleLinked: v })} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
          </Field>
        </div>
      </FormModal>
    </div>
  )
}

function VehicleTypeManager({ items, editable, onChange }: { items: VehicleType[]; editable: boolean; onChange: (x: VehicleType[]) => void }) {
  const [open, setOpen] = useState(false)
  const [d, setD] = useState({ name: "", category: "BUS", seats: "", mileage: "" })
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Vehicle classes with default seating and expected mileage.</p>
        {editable && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> Add type
          </Button>
        )}
      </div>
      <DataTable
        data={items}
        getRowId={(t) => t.code}
        columns={[
          { id: "name", header: "Type", cell: (t) => <span className="font-medium">{t.name}</span> },
          { id: "code", header: "Code", hideOnMobile: true, cell: (t) => <code className="text-xs text-muted-foreground">{t.code}</code> },
          { id: "cat", header: "Category", cell: (t) => t.category },
          { id: "seats", header: "Seats", align: "right", cell: (t) => t.defaultSeats ?? "—" },
          { id: "kmpl", header: "Expected kmpl", align: "right", cell: (t) => t.defaultMileage },
        ]}
      />
      <FormModal
        open={open}
        onOpenChange={setOpen}
        title="New vehicle type"
        onSubmit={() => {
          const code = d.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")
          if (!code || !(Number(d.mileage) > 0)) return toast.error("Enter name and mileage")
          if (items.some((x) => x.code === code)) return toast.error("Type exists")
          onChange([...items, { code, name: d.name.trim(), category: d.category as VehicleType["category"], defaultSeats: d.seats ? Number(d.seats) : null, defaultMileage: Number(d.mileage) }])
          setD({ name: "", category: "BUS", seats: "", mileage: "" })
          setOpen(false)
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="45-seater sleeper" />
          </Field>
          <Field label="Category">
            <SimpleSelect value={d.category} onChange={(v) => setD({ ...d, category: v })} options={["BUS", "VAN", "CAR", "TRUCK", "PICKUP"].map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Seats">
            <Input type="number" value={d.seats} onChange={(e) => setD({ ...d, seats: e.target.value })} />
          </Field>
          <Field label="Expected kmpl" required>
            <Input type="number" step="0.1" value={d.mileage} onChange={(e) => setD({ ...d, mileage: e.target.value })} />
          </Field>
        </div>
      </FormModal>
    </div>
  )
}

/* ------------------------------------------------------------------ Roles */

const MATRIX: { resource: Resource; label: string; actions: ("view" | "create" | "edit" | "delete")[] }[] = [
  { resource: "finance", label: "Money KPIs (receivables, payables, profit)", actions: ["view"] },
  { resource: "customers", label: "Customers", actions: ["view", "create", "edit"] },
  { resource: "vehicles", label: "Vehicles", actions: ["view", "create", "edit"] },
  { resource: "trips", label: "Trips", actions: ["view", "create", "edit", "delete"] },
  { resource: "diesel", label: "Diesel", actions: ["view", "create"] },
  { resource: "invoices", label: "Invoices", actions: ["view", "create", "edit"] },
  { resource: "payments", label: "Payments", actions: ["view", "create", "delete"] },
  { resource: "reports", label: "Reports", actions: ["view"] },
  { resource: "settings", label: "Settings", actions: ["view", "edit"] },
]

function RolesPanel() {
  const [role, setRole] = useRole()
  const session = useSession() // a signed-in account's role comes from the database and can't be switched here
  return (
    <div className="space-y-4">
      {session && <p className="text-xs text-muted-foreground">Your role comes from your account. Only Dev can change roles, in Settings → User accounts.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map((r) => (
          <button
            key={r.value}
            type="button"
            disabled={!!session}
            onClick={() => {
              setRole(r.value)
              toast.success(`Now viewing as ${r.label}`)
            }}
            className={cn("rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/50", role === r.value && "ring-2 ring-primary")}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{r.label}</span>
              {role === r.value && <StatusBadge status="ACTIVE" label="Current" />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
          </button>
        ))}
      </div>
      <Card className="gap-0 py-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Permission</th>
                {ROLES.map((r) => (
                  <th key={r.value} className="px-4 py-2 text-center font-medium">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {MATRIX.flatMap((m) =>
                m.actions.map((a) => (
                  <tr key={`${m.resource}:${a}`}>
                    <td className="px-4 py-1.5">
                      {m.label} <span className="text-muted-foreground">· {a}</span>
                    </td>
                    {ROLES.map((r) => (
                      <td key={r.value} className="px-4 py-1.5 text-center">
                        {canRole(r.value, m.resource, a) ? <Check className="mx-auto size-4 text-success" /> : <span className="text-muted-foreground/40">—</span>}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted-foreground">Mock role switching — no authentication in the prototype. The same `resource:action` strings will be enforced by the API and database policies.</p>
    </div>
  )
}

/* ------------------------------------------------------------------ Data */

/** Downloads a full backup of the current data (all collections and settings). */
async function downloadBackup(prefix = "vishal-erp-backup") {
  const data = await fetchBackup()
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`
  a.click()
}

function DataPanel() {
  const admin = useAdminAction()
  const restore = useRestoreBackup()
  const [role] = useRole()
  const mayRestore = role === "OWNER" || role === "DEV"
  const [usage, setUsage] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<"reset" | "clear" | null>(null)
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setUsage(storageUsage()), [admin.isSuccess, restore.isSuccess])

  const pick = async (f: File | undefined) => {
    if (!f) return
    try {
      setFile({ name: f.name, data: JSON.parse(await f.text()) })
    } catch {
      toast.error(`${f.name} is not a backup file`)
    }
  }
  const info = file ? (file.data as { label?: string; exportedAt?: string; collections?: Record<string, unknown[]> }) : null

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Database className="size-4" /> Browser storage
          </CardTitle>
          <CardDescription>All prototype data lives in this browser&apos;s localStorage (keys prefixed vt:).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="num text-2xl font-semibold">{usage === null ? "—" : `${(usage / 1024 / 1024).toFixed(2)} MB`}</div>
          <p className="text-xs text-muted-foreground">Browsers allow roughly 5–10 MB per site.</p>
          <Button variant="outline" size="sm" onClick={() => downloadBackup()}>
            <Download /> Export JSON backup
          </Button>
        </CardContent>
      </Card>
      {mayRestore && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Upload className="size-4" /> Restore from file
            </CardTitle>
            <CardDescription>Replaces all data with a backup or prepared import file. A backup of the current data downloads first.</CardDescription>
          </CardHeader>
          <CardContent>
            <Input type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0])} />
          </CardContent>
        </Card>
      )}
      {/* Reset and clear replace every record: Owner and Dev only, here and in the API (assertWorkspaceAdmin). */}
      {mayRestore && (
        <>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <RotateCcw className="size-4" /> Reset demo data
              </CardTitle>
              <CardDescription>Regenerates ~6 months of realistic data ending today. Your changes will be lost.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => setConfirm("reset")}>
                Reset to demo data
              </Button>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Trash2 className="size-4" /> Start empty
              </CardTitle>
              <CardDescription>Clears all customers, vehicles and transactions, keeping master lists.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setConfirm("clear")}>
                Clear all data
              </Button>
            </CardContent>
          </Card>
        </>
      )}
      <FormModal
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "reset" ? "Reset to demo data?" : "Clear all data?"}
        description="This replaces everything stored in this browser for the prototype."
        submitLabel={confirm === "reset" ? "Download backup and reset" : "Download backup and clear everything"}
        destructive={confirm === "clear"}
        pending={admin.isPending}
        onSubmit={async () => {
          // A backup of the current data always downloads first, as for Restore — the audit log can't bring records back.
          await downloadBackup(confirm === "reset" ? "vishal-erp-before-reset" : "vishal-erp-before-clear")
          await admin.mutateAsync(confirm!)
          toast.success(confirm === "reset" ? "Demo data regenerated" : "Workspace cleared")
          setConfirm(null)
        }}
      >
        <p className="text-sm text-muted-foreground">A JSON backup of the current data downloads first. Keep it: it is the only way to bring these records back.</p>
      </FormModal>
      <FormModal
        open={file !== null}
        onOpenChange={(o) => !o && setFile(null)}
        title="Replace all data from this file?"
        description="Everything stored in this browser for the app is replaced. The audit log is kept and records the restore."
        submitLabel="Download backup and restore"
        destructive
        pending={restore.isPending}
        onSubmit={async () => {
          await downloadBackup("vishal-erp-before-restore")
          await restore.mutateAsync({ data: file!.data, fileName: file!.name })
          toast.success(`Restored from ${file!.name}`)
          setFile(null)
        }}
      >
        {info && (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{file!.name}</p>
            {info.label && <p>{info.label}</p>}
            {info.exportedAt && <p className="text-muted-foreground">Created {formatDate(info.exportedAt.slice(0, 10))}</p>}
            {info.collections && (
              <p className="text-muted-foreground">
                {Object.entries(info.collections)
                  .filter(([, v]) => Array.isArray(v) && v.length)
                  .map(([k, v]) => `${v.length.toLocaleString("en-IN")} ${k.replace(/_/g, " ")}`)
                  .join(" · ")}
              </p>
            )}
          </div>
        )}
      </FormModal>
    </div>
  )
}
