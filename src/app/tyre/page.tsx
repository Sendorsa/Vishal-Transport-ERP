import type { Metadata } from "next"
import { TyreRegister } from "@/features/tyre/tyre-register"

export const metadata: Metadata = { title: "Tyre" }

export default function TyrePage() {
  return <TyreRegister />
}
