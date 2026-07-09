import Lenis from 'lenis';

let lenis: Lenis | null = null;

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Global momentum smooth-scroll (Lenis) - the single biggest "premium journey"
 * upgrade. Self-driven RAF so it needs no animation engine; GSAP loads only in
 * the landing chunk and syncs to this instance there. No-op (native scroll)
 * under prefers-reduced-motion. Idempotent; returns a teardown.
 */
export function initSmoothScroll(): () => void {
  if (prefersReduced() || lenis) return () => {};
  lenis = new Lenis({
    duration: 1.05,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    touchMultiplier: 1.4,
    autoRaf: true,
  });
  return () => {
    lenis?.destroy();
    lenis = null;
  };
}

/** The live Lenis instance (null under reduced-motion), for scroll-scene sync. */
export function getLenis(): Lenis | null {
  return lenis;
}

/** Jump to the top, through Lenis when active so it stays smooth. */
export function scrollToTop(): void {
  if (lenis) lenis.scrollTo(0, { duration: 0.8 });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Freeze / resume page scroll (used while a modal is open). */
export function lockScroll(): void {
  lenis?.stop();
}
export function unlockScroll(): void {
  lenis?.start();
}
