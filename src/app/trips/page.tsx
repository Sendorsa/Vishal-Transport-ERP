import type { Metadata } from "next"
import { TripList } from "@/features/trips/trip-list"

export const metadata: Metadata = { title: "Trips" }

export default function TripsPage() {
  return <TripList />
}
