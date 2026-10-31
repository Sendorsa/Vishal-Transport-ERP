import type { Metadata } from "next"
import { MonthlyMaster } from "@/features/diesel/master-sheets"

export const metadata: Metadata = { title: "Diesel Monthly Master" }

export default function MonthlyMasterPage() {
  return <MonthlyMaster />
}
