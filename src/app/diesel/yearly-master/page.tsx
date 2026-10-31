import type { Metadata } from "next"
import { YearlyMaster } from "@/features/diesel/master-sheets"

export const metadata: Metadata = { title: "Diesel Yearly Master" }

export default function YearlyMasterPage() {
  return <YearlyMaster />
}
