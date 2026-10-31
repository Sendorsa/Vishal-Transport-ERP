import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function ChartCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  isLoading,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
  isLoading?: boolean
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("min-w-0", contentClassName)}>
        {isLoading ? <Skeleton className="h-[240px] w-full" /> : children}
      </CardContent>
    </Card>
  )
}
