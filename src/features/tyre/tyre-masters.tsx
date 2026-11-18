"use client"

import { useMemo, useState } from "react"
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/shared/status-badge"
import { masterKey, TYRE_MASTER_LABEL } from "@/domain/tyre"
import { useArchiveTyreMaster, useSaveTyreMaster, useTyreInvoices, useTyreMasters } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import type { TyreMaster, TyreMasterKind } from "@/lib/types"

const KINDS: TyreMasterKind[] = ["SUPPLIER", "REPAIR_TYPE", "BRAND", "SIZE"]

/**
 * The four Tyre lists — suppliers, repair types, tyre brands, tyre sizes: add, rename, archive, restore. Values are
 * never deleted (invoices keep pointing at them); an archived value leaves the pickers but stays on its invoices.
 */
export function TyreMastersDialog({ onClose }: { onClose: () => void }) {
  const can = useCan()
  const masters = useTyreMasters()
  const invoices = useTyreInvoices()
  const save = useSaveTyreMaster()
  const archive = useArchiveTyreMaster()
  const [kind, setKind] = useState<TyreMasterKind>("SUPPLIER")
  const [adding, setAdding] = useState("")
  const [renaming, setRenaming] = useState<{ m: TyreMaster; name: string } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const mayCreate = can("tyres", "create")
  const mayEdit = can("tyres", "edit")

  // How many invoices use each value (shown so nobody archives a value by mistake).
  const uses = useMemo(() => {
    const n = new Map<string, number>()
    for (const x of invoices.data ?? []) for (const id of new Set([x.supplierId, ...x.items.flatMap((i) => [i.repairTypeId, i.brandId, i.sizeId])])) if (id) n.set(id, (n.get(id) ?? 0) + 1)
    return n
  }, [invoices.data])
  const list = (masters.data ?? []).filter((m) => m.kind === kind && (showArchived || m.status === "ACTIVE")).sort((a, b) => a.name.localeCompare(b.name))
  const label = TYRE_MASTER_LABEL[kind]
  const duplicate = adding.trim() && (masters.data ?? []).find((m) => m.kind === kind && masterKey(m.name) === masterKey(adding))

  const add = async () => {
    if (!adding.trim() || duplicate) return
    await save.mutateAsync({ data: { kind, name: adding } })
    toast.success(`${label.one} added`)
    setAdding("")
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tyre lists</DialogTitle>
          <DialogDescription>Suppliers, repair types, tyre brands and sizes used on invoices. Names are unique (spaces and capitals ignored); values are archived, never deleted.</DialogDescription>
        </DialogHeader>
        <Tabs value={kind} onValueChange={(v) => setKind(v as TyreMasterKind)}>
          <TabsList className="w-full flex-wrap">
            {KINDS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {TYRE_MASTER_LABEL[k].many}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {mayCreate && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={`New ${label.one.toLowerCase()}…`} aria-label={`New ${label.one.toLowerCase()}`} />
            <Button type="submit" disabled={!adding.trim() || !!duplicate || save.isPending}>
              <Plus /> Add
            </Button>
          </form>
        )}
        {duplicate && <p className="-mt-2 text-xs text-destructive">{duplicate.name} already exists{duplicate.status === "ARCHIVED" ? " (archived) — restore it instead" : ""}.</p>}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} /> Show archived
        </label>
        <ul className="divide-y rounded-lg border">
          {list.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No {label.many.toLowerCase()} yet{mayCreate ? " — add one above, or from the invoice form" : ""}.</li>}
          {list.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              {renaming?.m.id === m.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    await save.mutateAsync({ id: m.id, version: m.updatedAt, data: { kind, name: renaming.name } })
                    toast.success("Renamed")
                    setRenaming(null)
                  }}
                >
                  <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ m, name: e.target.value })} className="h-8" aria-label="New name" />
                  <Button type="submit" size="sm" disabled={!renaming.name.trim() || save.isPending}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                  {m.status === "ARCHIVED" && <StatusBadge status="ARCHIVED" />}
                  <span className="text-xs whitespace-nowrap text-muted-foreground">{uses.get(m.id) ? `${uses.get(m.id)} invoice${uses.get(m.id) === 1 ? "" : "s"}` : "unused"}</span>
                  {mayEdit && (
                    <>
                      <Button variant="ghost" size="icon-sm" aria-label={`Rename ${m.name}`} onClick={() => setRenaming({ m, name: m.name })}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={m.status === "ARCHIVED" ? `Restore ${m.name}` : `Archive ${m.name}`}
                        onClick={async () => {
                          await archive.mutateAsync({ id: m.id, version: m.updatedAt, restore: m.status === "ARCHIVED" })
                          toast.success(`${m.name} ${m.status === "ARCHIVED" ? "restored" : "archived"}`)
                        }}
                      >
                        {m.status === "ARCHIVED" ? <RotateCcw /> : <Archive />}
                      </Button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
