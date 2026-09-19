import { useEffect, useState } from 'react'

export function useMotionPreference(): [boolean, (value: boolean) => void] {
  const [reduced, setReduced] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('seltren-motion')
      if (stored === 'reduced') return true
      if (stored === 'motion') return false
    } catch { /* storage unavailable */ }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    try { localStorage.setItem('seltren-motion', reduced ? 'reduced' : 'motion') } catch { /* ignore */ }
  }, [reduced])
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (event: MediaQueryListEvent) => {
      try { if (!localStorage.getItem('seltren-motion')) setReduced(event.matches) } catch { setReduced(event.matches) }
    }
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return [reduced, setReduced]
}
