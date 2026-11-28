import type { Metadata } from "next"
import { ExpensePage } from "@/features/expenses/expense-page"

export const metadata: Metadata = { title: "Insurance" }

export default function InsurancePage() {
  return <ExpensePage section="INSURANCE" />
}
