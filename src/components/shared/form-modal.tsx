"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * Dialog wrapping a <form>. Keeps footer actions consistent across modules. On phones it opens as a bottom sheet and
 * the Cancel / Save buttons stay pinned at its bottom while the fields scroll (and above the on-screen keyboard).
 */
export function FormModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel = "Save",
  pending,
  className,
  destructive,
  submitDisabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  submitLabel?: string
  pending?: boolean
  className?: string
  destructive?: boolean
  /** Keeps the submit button disabled (e.g. until a required field is valid). */
  submitDisabled?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90svh] overflow-y-auto sm:max-w-lg max-sm:max-h-[92dvh]", className)}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(e)
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter className="max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mb-[max(1rem,env(safe-area-inset-bottom))] max-sm:flex-row max-sm:rounded-none max-sm:bg-popover max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:[&>*]:flex-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || submitDisabled} variant={destructive ? "destructive" : "default"}>
              {pending && <Loader2 className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
