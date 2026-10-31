import { TripDetail } from "@/features/trips/trip-detail"

export default async function TripPage(props: PageProps<"/trips/[id]">) {
  const { id } = await props.params
  return <TripDetail id={id} />
}
