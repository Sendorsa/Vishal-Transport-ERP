/** Client-side CSV export (prototype stand-in for the reporting engine's exports). */
export function downloadCsv(filename: string, rows: Record<string, string | number | null | undefined>[]) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
