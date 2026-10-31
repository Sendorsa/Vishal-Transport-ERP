"use client"

import { useMemo, useState } from "react"
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
  /** Hidden below the md breakpoint to keep tables readable on phones. */
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
}

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
}: DataTableProps<T>) {
  const router = useRouter()
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

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
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
