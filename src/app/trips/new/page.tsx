import type { Metadata } from "next"
import { RequirePermission } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { TripForm } from "@/features/trips/trip-form"

export const metadata: Metadata = { title: "New trip" }

export default async function NewTripPage(props: PageProps<"/trips/new">) {
  const { customerId } = await props.searchParams
  return (
    <RequirePermission resource="trips" action="create" what="creating trips">
      <div className="mx-auto max-w-6xl">
        <PageHeader title="New trip" description="Assign customer, vehicle and driver; revenue is calculated from the customer's pricing." backHref="/trips" backLabel="Trips" />
        <TripForm defaultCustomerId={typeof customerId === "string" ? customerId : undefined} />
      </div>
    </RequirePermission>
  )
}
