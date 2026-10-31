import type { Metadata } from "next"
import { DieselView } from "@/features/diesel/diesel-view"

export const metadata: Metadata = { title: "Diesel ledger & vendors" }

export default function DieselLedgerPage() {
  return <DieselView />
}
