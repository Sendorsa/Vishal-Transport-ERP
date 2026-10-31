import type { Metadata } from "next"
import { ReportsView } from "@/features/reports/reports-view"

export const metadata: Metadata = { title: "Reports" }

export default async function ReportsPage(props: PageProps<"/reports">) {
  const { tab } = await props.searchParams
  const t = typeof tab === "string" ? tab : undefined
  return <ReportsView key={t ?? "default"} initialTab={t} />
}
