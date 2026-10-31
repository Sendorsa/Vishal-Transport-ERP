import type { Metadata } from "next"
import { DieselTanker } from "@/features/tanker/diesel-tanker"

export const metadata: Metadata = { title: "Diesel Tankers" }

export default function DieselTankerPage() {
  return <DieselTanker />
}
