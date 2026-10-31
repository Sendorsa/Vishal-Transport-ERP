import { redirect } from "next/navigation"

/** The ERP opens on Fuel Stations (owner, 1 Nov 2026). The Dashboard is at /dashboard. */
export default function Home() {
  redirect("/fuel-stations")
}
