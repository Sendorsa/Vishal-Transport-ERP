/**
 * Offline checks for the keyboard-aware Save bar (src/lib/keyboard.ts): where the bar sits for each browser's
 * viewport behaviour when an on-screen keyboard opens. Numbers are CSS pixels of an iPhone 14 / Pixel-sized screen.
 */
import assert from "node:assert/strict"
import { keyboardInset, type ViewportSample } from "./keyboard"

const phone = (s: Partial<ViewportSample>): ViewportSample => ({ innerHeight: 844, height: 844, offsetTop: 0, scale: 1, narrow: true, ...s })

assert.equal(keyboardInset(phone({})), 0, "no keyboard: the bar stays above the tab bar")
assert.equal(keyboardInset(phone({ height: 508 })), 336, "iPhone keyboard (336 px): the bar sits right on top of it")
assert.equal(keyboardInset(phone({ height: 508, offsetTop: 120 })), 216, "iPhone scrolled the visible area down by 120 px: still exactly on the keyboard")
assert.equal(keyboardInset(phone({ height: 508.4, offsetTop: 0.3 })), 335, "fractional viewport sizes are rounded")
assert.equal(keyboardInset(phone({ height: 800 })), 0, "Safari's toolbar collapsing (44 px) is not a keyboard: no jump")
assert.equal(keyboardInset(phone({ innerHeight: 500, height: 500 })), 0, "Android resizes-content: the page already shrank above the keyboard, nothing to add")
assert.equal(keyboardInset(phone({ height: 500 })), 344, "Android overlaying the keyboard (older Chrome): the bar rides on it too")
assert.equal(keyboardInset(phone({ height: 422, scale: 2 })), 0, "pinch-zoomed: the bar never moves")
assert.equal(keyboardInset(phone({ height: 508, narrow: false })), 0, "tablet / desktop layout: the bar isn't fixed, nothing changes")
// Switching between inputs with the keyboard open gives the same sample, so the same value: React keeps the state and
// nothing re-renders or jumps.
assert.equal(keyboardInset(phone({ height: 508 })), keyboardInset(phone({ height: 508 })))

console.log("mobile keyboard: the Save bar rides on the iPhone / overlaying keyboard, stays put for Android resizing, toolbar changes, zoom and larger layouts: all checks passed")
