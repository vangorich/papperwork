import { createContext, useInsertionEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'

export const AppMotion = createContext(true)
const key = 'paperwork-animations'
// These are output modes, not Windows' animation preference. Keep the user's choice intact.
const staticOutput = 'print, (forced-colors: active)'
const isStaticOutput = () => window.matchMedia(staticOutput).matches
function watchOutput(change: () => void) {
  const media = window.matchMedia(staticOutput)
  media.addEventListener('change', change)
  return () => media.removeEventListener('change', change)
}

export function useAppMotion() {
  const [animations, setAnimations] = useState(() => {
    try { return localStorage.getItem(key) !== 'off' } catch { return true }
  })
  const staticMode = useSyncExternalStore(watchOutput, isStaticOutput)
  const motionEnabled = animations && !staticMode
  // Apply the CSS mode (including portals) before layout effects settle native
  // scrolls: a note's animated screen bounds are not its final destination.
  useInsertionEffect(() => {
    document.documentElement.dataset.motion = motionEnabled ? 'on' : 'off'
  }, [motionEnabled])
  useLayoutEffect(() => {
    try { localStorage.setItem(key, animations ? 'on' : 'off') } catch { /* In-memory setting still applies. */ }
  }, [animations])
  return { animations, setAnimations, motionEnabled }
}
