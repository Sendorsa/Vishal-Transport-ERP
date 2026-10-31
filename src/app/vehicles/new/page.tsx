import type { Metadata } from "next"
import { RequirePermission } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { VehicleForm } from "@/features/vehicles/vehicle-form"

export const metadata: Metadata = { title: "Add vehicle" }

export default function NewVehiclePage() {
  return (
    <RequirePermission resource="vehicles" action="create" what="adding vehicles">
      <div className="mx-auto max-w-5xl">
        <PageHeader title="Add vehicle" description="Register a vehicle in the fleet." backHref="/vehicles" backLabel="Vehicles" />
        <VehicleForm />
      </div>
    </RequirePermission>
  )
}
