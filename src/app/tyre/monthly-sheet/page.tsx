import type { Metadata } from "next"
import { TyreMonthlySheet } from "@/features/tyre/tyre-monthly-sheet"

export const metadata: Metadata = { title: "Tyre Monthly Sheet" }

export default function TyreMonthlySheetPage() {
  return <TyreMonthlySheet />
}
