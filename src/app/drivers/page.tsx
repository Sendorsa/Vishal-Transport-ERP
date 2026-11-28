import type { Metadata } from "next"
import { DriverList } from "@/features/drivers/driver-list"

export const metadata: Metadata = { title: "Drivers" }

export default function DriversPage() {
  return <DriverList />
}
