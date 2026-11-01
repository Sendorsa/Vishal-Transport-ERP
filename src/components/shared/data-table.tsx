"use client"

import { useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface Column<T> {
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number | null
  align?: "left" | "right" | "center"
  className?: string
  /** On phones (below md): not in the card's main lines — shown under "More details" instead. */
  hideOnMobile?: boolean
  footer?: React.ReactNode
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[] | undefined
  getRowId: (row: T) => string
  isLoading?: boolean
  rowHref?: (row: T) => string
  onRowClick?: (row: T) => void
  pageSize?: number
  initialSort?: { id: string; desc?: boolean }
  emptyMessage?: React.ReactNode
  className?: string
  showFooter?: boolean
  dense?: boolean
  /**
   * Phones: which columns (ids) a row card shows on its main lines; the first column is the card title and an "act"
   * column (row actions) sits top-right. Default: the first 4 other columns not marked hideOnMobile. Every other
   * column stays available under "More details" — nothing is dropped.
   */
  mobileColumns?: string[]
}

const MOBILE_MAIN = 4

export function DataTable<T>({
  columns,
  data,
  getRowId,
  isLoading,
  rowHref,
  onRowClick,
  pageSize = 25,
  initialSort,
  emptyMessage = "No records found.",
  className,
  showFooter,
  dense,
  mobileColumns,
}: DataTableProps<T>) {
  const router = useRouter()
  const sortId = useId()
  const [sort, setSort] = useState(initialSort ?? null)
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    const rows = data ?? []
    if (!sort) return rows
    const col = columns.find((c) => c.id === sort.id)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    return [...rows].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      if (va === vb) return 0
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))
      return sort.desc ? -r : r
    })
  }, [data, sort, columns])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const rows = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize)
  const clickable = Boolean(rowHref || onRowClick)

  const toggleSort = (id: string) => {
    setPage(0)
    setSort((s) => (s?.id !== id ? { id, desc: true } : s.desc ? { id, desc: false } : null))
  }

  const alignClass = (a?: Column<T>["align"]) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "")

  // Phone layout: a card per row (essential columns first, the rest under "More details"), so nothing has to be
  // read through a squeezed or sideways-scrolling table. The table itself is unchanged from md upwards.
  const actionCol = columns.find((c) => c.id === "act")
  const titleCol = columns.find((c) => c !== actionCol)
  const others = columns.filter((c) => c !== titleCol && c !== actionCol)
  const mainCols = mobileColumns ? others.filter((c) => mobileColumns.includes(c.id)) : others.filter((c) => !c.hideOnMobile).slice(0, MOBILE_MAIN)
  const detailCols = others.filter((c) => !mainCols.includes(c))
  const sortable = columns.filter((c) => c.sortValue)
  const footerCols = showFooter ? columns.filter((c) => c !== titleCol && c !== actionCol && c.footer !== undefined && c.footer !== null && c.footer !== "") : []
  const pairs = (cols: Column<T>[], row: T) => (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {cols.map((col) => (
        <div key={col.id} className="min-w-0">
          <dt className="text-[11px] leading-tight text-muted-foreground">{col.header}</dt>
          <dd className={cn("text-sm [overflow-wrap:anywhere]", col.align === "right" && "num")}>{col.cell(row)}</dd>
        </div>
      ))}
    </dl>
  )

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="md:hidden">
        {sortable.length > 0 && !isLoading && sorted.length > 1 && (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <label htmlFor={sortId} className="shrink-0">
              Sort by
            </label>
            <select
              id={sortId}
              value={sort?.id ?? ""}
              onChange={(e) => {
                setPage(0)
                setSort(e.target.value ? { id: e.target.value, desc: sort?.desc ?? true } : null)
              }}
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-base text-foreground"
            >
              <option value="">Default order</option>
              {sortable.map((c) => (
                <option key={c.id} value={c.id}>
                  {typeof c.header === "string" ? c.header : c.id}
                </option>
              ))}
            </select>
            {sort && (
              <Button variant="outline" size="icon-sm" onClick={() => setSort({ ...sort, desc: !sort.desc })} aria-label={sort.desc ? "Descending — switch to ascending" : "Ascending — switch to descending"}>
                {sort.desc ? <ArrowDown /> : <ArrowUp />}
              </Button>
            )}
          </div>
        )}
        {isLoading ? (
          <ul className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="space-y-2 px-3 py-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={getRowId(row)}
                className={cn("px-3 py-2.5", clickable && "cursor-pointer outline-none focus-visible:bg-muted/60 active:bg-muted/60")}
                // A tappable card is also reachable and openable from a keyboard (Enter, or Space for a button).
                role={clickable ? (onRowClick ? "button" : "link") : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={(e) => {
                  if (!clickable || e.target !== e.currentTarget || !(e.key === "Enter" || (onRowClick && e.key === " "))) return
                  e.preventDefault()
                  if (onRowClick) onRowClick(row)
                  else if (rowHref) router.push(rowHref(row))
                }}
                onClick={() => {
                  if (onRowClick) onRowClick(row)
                  else if (rowHref) router.push(rowHref(row))
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 pt-0.5 text-sm font-medium [overflow-wrap:anywhere]">{titleCol?.cell(row)}</div>
                  {actionCol && (
                    <div className="-my-1 -mr-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {actionCol.cell(row)}
                    </div>
                  )}
                </div>
                {mainCols.length > 0 && <div className="mt-1.5">{pairs(mainCols, row)}</div>}
                {detailCols.length > 0 && (
                  <details className="group mt-1" onClick={(e) => e.stopPropagation()}>
                    <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 text-xs font-medium text-primary [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                      More details
                    </summary>
                    <div className="pb-1">{pairs(detailCols, row)}</div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {footerCols.length > 0 && !isLoading && rows.length > 0 && (
          <div className="border-t bg-muted/40 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-semibold">Totals</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {footerCols.map((col) => (
                <div key={col.id} className="min-w-0">
                  <dt className="text-[11px] leading-tight text-muted-foreground">{col.header}</dt>
                  <dd className={cn("text-sm font-medium [overflow-wrap:anywhere]", col.align === "right" && "num")}>{col.footer}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
      <div className="max-md:hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              {columns.map((col) => {
                const active = sort?.id === col.id
                return (
                  <TableHead
                    key={col.id}
                    className={cn(
                      "h-9 text-xs font-medium text-muted-foreground",
                      alignClass(col.align),
                      col.hideOnMobile && "hidden md:table-cell",
                      col.className
                    )}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.id)}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          col.align === "right" && "flex-row-reverse",
                          active && "text-foreground"
                        )}
                      >
                        {col.header}
                        {active ? (
                          sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((col) => (
                    <TableCell key={col.id} className={cn(col.hideOnMobile && "hidden md:table-cell")}>
                      <Skeleton className="h-4 w-full max-w-32" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-32 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={getRowId(row)}
                  className={cn(clickable && "cursor-pointer")}
                  onClick={() => {
                    if (onRowClick) onRowClick(row)
                    else if (rowHref) router.push(rowHref(row))
                  }}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      className={cn(
                        dense ? "py-1.5" : "py-2",
                        alignClass(col.align),
                        col.align === "right" && "num",
                        col.hideOnMobile && "hidden md:table-cell",
                        col.className
                      )}
                    >
                      {col.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
          {showFooter && !isLoading && rows.length > 0 && (
            <TableFooter>
              <TableRow>
                {columns.map((col) => (
                  <TableCell
                    key={col.id}
                    className={cn(
                      "py-2 font-medium",
                      alignClass(col.align),
                      col.align === "right" && "num",
                      col.hideOnMobile && "hidden md:table-cell",
                      col.className
                    )}
                  >
                    {col.footer}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>
      {!isLoading && sorted.length > pageSize && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="num">
            {safePage * pageSize + 1}–{Math.min(sorted.length, (safePage + 1) * pageSize)} of{" "}
            {sorted.length.toLocaleString("en-IN")}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              <ChevronLeft />
              <span className="sr-only">Previous page</span>
            </Button>
            <span className="num px-1">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight />
              <span className="sr-only">Next page</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
