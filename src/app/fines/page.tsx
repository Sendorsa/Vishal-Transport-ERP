import type { Metadata } from "next"
import { ExpensePage } from "@/features/expenses/expense-page"

export const metadata: Metadata = { title: "Fines" }

export default function FinesPage() {
  return <ExpensePage section="FINE" />
}
