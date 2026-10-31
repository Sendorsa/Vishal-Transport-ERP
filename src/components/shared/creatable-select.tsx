"use client"

import { useState } from "react"
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface CreatableOption {
  value: string
  label: string
  disabled?: boolean
}

/**
 * Searchable select. With `onCreate` it can also create a missing value inline
 * (Notion / Airtable style): the new item is persisted, then selected.
 * Without `onCreate` it is a plain search-and-pick selector.
 */
export function CreatableSelect({
  value,
  options,
  onChange,
  onCreate,
  placeholder = "Select…",
  createLabel = (q) => `Create "${q}"`,
  invalid,
}: {
  value: string | null | undefined
  options: CreatableOption[]
  onChange: (value: string) => void
  onCreate?: (label: string) => Promise<string>
  placeholder?: string
  createLabel?: (query: string) => string
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const selected = options.find((o) => o.value === value)
  const q = query.trim()
  const exists = options.some((o) => o.label.toLowerCase() === q.toLowerCase())

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid || undefined} className="w-full min-w-0 justify-between bg-background font-normal">
          <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        {/* Plain substring match — fuzzy matching makes registration numbers ("KA51") noisy. */}
        <Command filter={(value, search) => (value.split("\u0000")[0].toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={onCreate ? "Search or type to create…" : "Search…"} />
          <CommandList>
            <CommandEmpty>{q ? "No match" : onCreate ? "Nothing yet — type to create" : "Nothing to show"}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={`${o.label}\u0000${o.value}`} disabled={o.disabled} onSelect={() => pick(o.value)}>
                  <Check className={cn(o.value === value ? "opacity-100" : "opacity-0")} />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
            {onCreate && q && !exists && (
              <CommandGroup>
                <CommandItem
                  value={`create ${q}`}
                  disabled={creating}
                  onSelect={async () => {
                    setCreating(true)
                    try {
                      pick(await onCreate!(q))
                    } finally {
                      setCreating(false)
                    }
                  }}
                >
                  {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                  {createLabel(q)}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
