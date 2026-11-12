import Image from "next/image"
import logo from "@/assets/logo.png"
import { cn } from "@/lib/utils"

/**
 * The company logo (owner, 12 Nov 2026): the file in the project's `assests/logo.png`, copied unchanged to
 * `src/assets/logo.png` (Next.js serves only files inside the app). Its background — and the "V" inside it — are
 * transparent, so it always sits on a white tile, in light and dark mode alike, with padding and its own aspect ratio
 * (object-contain: never cropped or stretched). Decorative: the name "Vishal Transport" is always next to it.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex aspect-square shrink-0 items-center justify-center rounded-lg bg-white p-1 ring-1 ring-black/10", className)}>
      <Image src={logo} alt="" aria-hidden className="size-full object-contain" priority />
    </div>
  )
}
