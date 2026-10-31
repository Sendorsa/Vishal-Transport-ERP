import type { Metadata } from "next"
import { QuarterlyMaster } from "@/features/diesel/master-sheets"

export const metadata: Metadata = { title: "Diesel Quarterly Master" }

export default function QuarterlyMasterPage() {
  return <QuarterlyMaster />
}
