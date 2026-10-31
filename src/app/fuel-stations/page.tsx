import type { Metadata } from "next"
import { FuelStations } from "@/features/fuel-stations/fuel-stations"

export const metadata: Metadata = { title: "Fuel Stations" }

export default function FuelStationsPage() {
  return <FuelStations />
}
