"use client"

import { useEffect, useState } from "react"

/** A real on-screen keyboard, not a toolbar collapse or rounding. */
const MIN_KEYBOARD_PX = 120

export interface ViewportSample {
  /** window.innerHeight: the layout viewport (iOS doesn't shrink it for the keyboard). */
  innerHeight: number
  /** visualViewport.height / offsetTop / scale: the part actually visible above the keyboard. */
  height: number
  offsetTop: number
  scale: number
  /** Phone layout (below md): only there is the Save bar fixed. */
  narrow: boolean
}

/**
 * How far above the layout viewport's bottom the visible area ends, i.e. how many CSS pixels the on-screen keyboard
 * covers, or 0. A fixed element with `bottom: <this>` sits right on top of the keyboard.
 * - iOS Safari: the keyboard shrinks only the visual viewport (and may scroll it: offsetTop), so this is the keyboard.
 * - Android Chrome with `interactive-widget=resizes-content`: the layout viewport shrinks too, so this stays ~0 and
 *   the normal layout already sits above the keyboard.
 * - Pinch-zoomed (scale > 1) or not the phone layout: 0, so zooming never moves the bar.
 */
export function keyboardInset(v: ViewportSample): number {
  if (!v.narrow || v.scale > 1.01) return 0
  const gap = v.innerHeight - v.height - v.offsetTop
  return gap > MIN_KEYBOARD_PX ? Math.round(gap) : 0
}

/**
 * Live keyboardInset for the current page (Visual Viewport API). Updates at most once per animation frame, and only
 * re-renders when the value changes, so switching between inputs while the keyboard stays open doesn't move anything.
 * Browsers without visualViewport get 0 (the bar keeps its normal place above the tab bar).
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const narrow = window.matchMedia("(width < 48rem)")
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setInset(keyboardInset({ innerHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale, narrow: narrow.matches }))
      )
    }
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    narrow.addEventListener("change", update)
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
      narrow.removeEventListener("change", update)
    }
  }, [])
  return inset
}

/** The keyboard / visible area has stopped changing for this long: safe to measure. */
const SETTLE_MS = 150

/**
 * With the keyboard open, keeps the focused field visible above the Save bar (`barPx` tall) that now rides on the
 * keyboard: scrolls the page just enough when the field's bottom would be hidden behind the bar — once, after the
 * keyboard has settled (every change of `inset` restarts the wait), so its opening animation never triggers a series
 * of scrolls. Nothing is scheduled after unmount.
 */
export function useKeepFocusAboveBar(inset: number, barPx: number) {
  useEffect(() => {
    if (!inset) return
    const vv = window.visualViewport
    let timer: ReturnType<typeof setTimeout> | undefined
    const reveal = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const el = document.activeElement
        if (!vv || !(el instanceof HTMLElement) || !el.matches("input, textarea, select, [contenteditable='true']")) return
        const visibleBottom = vv.offsetTop + vv.height - barPx
        const hidden = el.getBoundingClientRect().bottom - visibleBottom
        if (hidden > 0) window.scrollBy({ top: hidden + 8, behavior: "smooth" })
      }, SETTLE_MS)
    }
    reveal()
    document.addEventListener("focusin", reveal)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("focusin", reveal)
    }
  }, [inset, barPx])
}
