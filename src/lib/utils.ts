import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The search boxes' match: case-insensitive, partial, ignoring spaces and dashes (so "ka 53" finds KA53C0538).
 * An empty query matches everything.
 */
export function matchesSearch(query: string, ...fields: (string | null | undefined)[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "")
  const q = norm(query)
  return !q || fields.some((f) => !!f && norm(f).includes(q))
}
