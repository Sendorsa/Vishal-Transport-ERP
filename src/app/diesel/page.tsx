import type { Metadata } from "next"
import { DieselOverview } from "@/features/diesel/diesel-overview"

export const metadata: Metadata = { title: "Diesel" }

export default function DieselPage() {
  return <DieselOverview />
}
