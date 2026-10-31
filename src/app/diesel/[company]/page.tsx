import { CompanyDiesel } from "@/features/diesel/company-diesel"

export default async function CustomerDieselPage(props: PageProps<"/diesel/[company]">) {
  const { company } = await props.params
  return <CompanyDiesel key={company} slug={company} />
}
