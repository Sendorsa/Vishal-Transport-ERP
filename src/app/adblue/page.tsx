import type { Metadata } from "next"
import { AdBlueInventory } from "@/features/adblue/adblue-inventory"

export const metadata: Metadata = { title: "AdBlue Inventory" }

export default function AdBlueInventoryPage() {
  return <AdBlueInventory />
}
