import { useEffect, useRef } from 'react';

// Scroll-scrubbed gavel animation. The 8s clip is pre-extracted to 96 JPEG
// frames (public/anim); scroll progress through the tall .scene wrapper picks
// the frame, and a keyframed virtual camera pans/zooms to follow the gavel
// head as it rises and strikes.

const FRAMES = 96;
const frameSrc = (i: number) => `/anim/f_${String(i + 1).padStart(3, '0')}.jpg`;

// Camera keyframes: progress -> normalized center (x, y) and zoom.
// Hand-tracked against the gavel head in the source frames.
const TRACK = [
  { p: 0.0, x: 0.5, y: 0.55, z: 1.0 }, // full tableau
  { p: 0.08, x: 0.46, y: 0.6, z: 1.25 }, // gavel at rest on the book
  { p: 0.16, x: 0.42, y: 0.42, z: 1.45 }, // lift begins
  { p: 0.26, x: 0.33, y: 0.16, z: 1.6 }, // swung high
  { p: 0.44, x: 0.3, y: 0.12, z: 1.6 }, // held at the top
  { p: 0.56, x: 0.45, y: 0.2, z: 1.5 }, // wind-up
  { p: 0.66, x: 0.54, y: 0.52, z: 1.65 }, // descent
  { p: 0.78, x: 0.55, y: 0.62, z: 1.72 }, // impact, paper flies
  { p: 0.9, x: 0.52, y: 0.55, z: 1.3 }, // release
  { p: 1.0, x: 0.5, y: 0.5, z: 1.0 }, // full tableau again
];

const CAPTIONS = [
  {
    from: 0.03,
    to: 0.17,
    side: 'left',
    title: 'An open auction leaks everything.',
    body: 'Every public bid broadcasts your ceiling, your strategy, and your wallet. Rivals read it in real time and bid exactly one step above you.',
  },
  {
    from: 0.24,
    to: 0.4,
    side: 'right',
    title: 'Sealed envelopes just move the problem.',
    body: 'Classic sealed bids still get opened by someone. Whoever holds the envelopes holds the auction, and you cannot prove they played fair.',
  },
  {
    from: 0.48,
    to: 0.62,
    side: 'left',
    title: 'Midnight replaces the trusted hand.',
    body: 'On Gavel, bids are committed on-chain as zero-knowledge proofs. No auctioneer, no operator. Nobody can peek inside a sealed bid.',
  },
  {
    from: 0.68,
    to: 0.86,
    side: 'right',
    title: 'The gavel falls. The verdict is provable.',
    body: 'Settlement proves the winner paid the highest price without revealing any other bid. Losing bids are never published. Not then, not ever.',
  },
] as const;

function camera(p: number) {
  let a = TRACK[0];
  let b = TRACK[TRACK.length - 1];
  for (let i = 0; i < TRACK.length - 1; i++) {
    if (p >= TRACK[i].p && p <= TRACK[i + 1].p) {
      a = TRACK[i];
      b = TRACK[i + 1];
      break;
    }
  }
  const t = a === b ? 0 : (p - a.p) / (b.p - a.p);
  const e = t * t * (3 - 2 * t); // smoothstep
  return {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    z: a.z + (b.z - a.z) * e,
  };
}

export function ScrollScene() {
  const wrapRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!wrap || !canvas || !ctx) return;

    const imgs: HTMLImageElement[] = [];
    const ready: boolean[] = Array(FRAMES).fill(false);
    let lastDrawn = -1;
    let lastP = -1;
    let raf = 0;

    const load = (i: number) => {
      if (imgs[i]) return;
      const im = new Image();
      im.onload = () => {
        ready[i] = true;
        lastDrawn = -1; // allow redraw with the better frame
      };
      im.src = frameSrc(i);
      imgs[i] = im;
    };
    // Deferred to idle time: none of these frames are on screen yet (the
    // scene sits below the hero), and firing 96 loads immediately competes
    // with the hero's zoom-out animation for decode/network and makes it stutter.
    const loadFrames = () => {
      // Coarse pass first so scrubbing works while the rest streams in.
      for (let i = 0; i < FRAMES; i += 8) load(i);
      for (let i = 0; i < FRAMES; i++) load(i);
    };
    const hasIdleCallback = typeof window.requestIdleCallback === 'function';
    const idleHandle = hasIdleCallback ? window.requestIdleCallback(loadFrames) : setTimeout(loadFrames, 500);

    const nearestReady = (t: number) => {
      for (let d = 0; d < FRAMES; d++) {
        if (ready[t - d]) return t - d;
        if (ready[t + d]) return t + d;
      }
      return -1;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      lastDrawn = -1;
      lastP = -1;
    };
    resize();
    window.addEventListener('resize', resize);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const rect = wrap.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;

      const span = rect.height - window.innerHeight;
      const p = Math.min(1, Math.max(0, -rect.top / Math.max(span, 1)));
      const idx = nearestReady(Math.round(p * (FRAMES - 1)));
      if (idx < 0) return;
      if (idx === lastDrawn && Math.abs(p - lastP) < 0.0005) return;
      lastDrawn = idx;
      lastP = p;

      const img = imgs[idx];
      const cam = camera(p);
      const cw = canvas.width;
      const ch = canvas.height;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const scale = Math.max(cw / iw, ch / ih) * cam.z;
      const sw = cw / scale;
      const sh = ch / scale;
      const sx = Math.min(Math.max(cam.x * iw - sw / 2, 0), iw - sw);
      const sy = Math.min(Math.max(cam.y * ih - sh / 2, 0), ih - sh);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

      CAPTIONS.forEach((c, i) => {
        const el = capRefs.current[i];
        if (!el) return;
        const fade = 0.045;
        const o = Math.max(0, Math.min(1, (p - c.from) / fade, (c.to - p) / fade));
        el.style.opacity = o.toFixed(3);
        el.style.transform = `translateY(${((1 - o) * 22).toFixed(1)}px)`;
      });
    };
    raf = requestAnimationFrame(tick);

    return () => {
      if (hasIdleCallback) window.cancelIdleCallback(idleHandle as number);
      else clearTimeout(idleHandle as ReturnType<typeof setTimeout>);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <section className="scene" id="story" ref={wrapRef}>
      <div className="scene-sticky">
        <canvas ref={canvasRef} aria-hidden="true" />
        {CAPTIONS.map((c, i) => (
          <div
            key={c.title}
            className={`scene-caption ${c.side}`}
            ref={(el) => {
              capRefs.current[i] = el;
            }}
          >
            <h2>{c.title}</h2>
            <p>{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
