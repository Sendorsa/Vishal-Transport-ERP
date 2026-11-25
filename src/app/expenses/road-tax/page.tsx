import type { Metadata } from "next"
import { ExpensePage } from "@/features/expenses/expense-page"

export const metadata: Metadata = { title: "Road Tax" }

export default function RoadTaxPage() {
  return <ExpensePage section="ROAD_TAX" />
}
