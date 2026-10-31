import { notFound } from "next/navigation"
import { isMonthKey } from "@/domain/diesel"
import { VehicleDiesel } from "@/features/diesel/vehicle-diesel"

export default async function DieselVehiclePage(props: PageProps<"/diesel/[company]/[month]/[vehicle]">) {
  const { company, month, vehicle } = await props.params
  if (!isMonthKey(month)) notFound()
  return <VehicleDiesel slug={company} month={month} reg={decodeURIComponent(vehicle)} />
}
