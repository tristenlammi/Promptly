import { useMemo, type ReactElement } from "react";

/**
 * A dozen built-in header pictures for a form, drawn here in the form's
 * accent colour (so they suit every preset, in light and dark) rather than
 * shipped as image files. ``theme.header_builtin`` stores the id.
 */
export interface BuiltinHeader {
  id: string;
  label: string;
}

export const BUILTIN_HEADERS: BuiltinHeader[] = [
  { id: "confetti", label: "Confetti" },
  { id: "bunting", label: "Bunting" },
  { id: "waves", label: "Waves" },
  { id: "hills", label: "Hills" },
  { id: "sunrise", label: "Sunrise" },
  { id: "mountains", label: "Mountains" },
  { id: "leaves", label: "Leaves" },
  { id: "flowers", label: "Flowers" },
  { id: "bubbles", label: "Bubbles" },
  { id: "stars", label: "Stars" },
  { id: "dots", label: "Dots" },
  { id: "stripes", label: "Stripes" },
];

const W = 1200;
const H = 300;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

function draw(id: string): ReactElement[] {
  const r = rng(id.split("").reduce((n, c) => n * 31 + c.charCodeAt(0), 7));
  const out: ReactElement[] = [];
  switch (id) {
    case "confetti":
      for (let i = 0; i < 90; i++) {
        const x = r() * W;
        const y = r() * H;
        const o = 0.25 + r() * 0.6;
        if (r() < 0.5)
          out.push(<circle key={i} cx={x} cy={y} r={3 + r() * 6} opacity={o} />);
        else
          out.push(
            <rect key={i} x={x} y={y} width={6 + r() * 10} height={3 + r() * 4} opacity={o}
              transform={`rotate(${r() * 180} ${x} ${y})`} rx={1.5} />
          );
      }
      break;
    case "bunting":
      for (let s = 0; s < 3; s++) {
        const y0 = 30 + s * 85;
        const sag = 40;
        out.push(
          <path key={`l${s}`} d={`M0 ${y0} Q ${W / 2} ${y0 + sag * 2} ${W} ${y0}`} fill="none" stroke="currentColor"
            strokeWidth={2} opacity={0.5} />
        );
        for (let i = 0; i < 16; i++) {
          const t = (i + 0.5) / 16;
          const x = t * W;
          const y = y0 + 2 * sag * 2 * t * (1 - t);
          out.push(
            <polygon key={`f${s}-${i}`} points={`${x - 22},${y} ${x + 22},${y} ${x},${y + 42}`}
              opacity={0.3 + ((i + s) % 3) * 0.25} />
          );
        }
      }
      break;
    case "waves":
      for (let i = 0; i < 4; i++) {
        const y = 90 + i * 55;
        const amp = 26 - i * 3;
        let d = `M0 ${y}`;
        for (let x = 0; x <= W; x += 150) d += ` Q ${x + 75} ${y + (i % 2 ? amp : -amp)} ${x + 150} ${y}`;
        d += ` L${W} ${H} L0 ${H} Z`;
        out.push(<path key={i} d={d} opacity={0.18 + i * 0.16} />);
      }
      break;
    case "hills":
      for (let i = 0; i < 4; i++) {
        const base = 140 + i * 45;
        const p1 = 60 + r() * 80;
        const p2 = 60 + r() * 80;
        out.push(
          <path key={i}
            d={`M0 ${base} C ${W * 0.2} ${base - p1}, ${W * 0.4} ${base - p1}, ${W * 0.55} ${base} S ${W * 0.85} ${base - p2}, ${W} ${base - 20} L${W} ${H} L0 ${H} Z`}
            opacity={0.18 + i * 0.18} />
        );
      }
      break;
    case "sunrise":
      for (let i = 0; i < 18; i++) {
        const a = Math.PI + (Math.PI / 17) * i;
        out.push(
          <line key={`r${i}`} x1={W / 2} y1={H} x2={W / 2 + Math.cos(a) * 700} y2={H + Math.sin(a) * 700}
            stroke="currentColor" strokeWidth={14} opacity={0.12} />
        );
      }
      for (let i = 0; i < 4; i++)
        out.push(<circle key={`c${i}`} cx={W / 2} cy={H + 20} r={200 - i * 45} opacity={0.2 + i * 0.18} />);
      break;
    case "mountains":
      for (let i = 0; i < 3; i++) {
        let d = `M0 ${H}`;
        let x = -100 + i * 60;
        while (x < W + 200) {
          const w = 200 + r() * 180;
          const h = 110 + r() * 90 - i * 25;
          d += ` L${x + w / 2} ${H - h - i * 10} L${x + w} ${H}`;
          x += w * 0.7;
        }
        d += " Z";
        out.push(<path key={i} d={d} opacity={0.22 + i * 0.22} />);
      }
      break;
    case "leaves":
      for (let i = 0; i < 46; i++) {
        const x = r() * W;
        const y = r() * H;
        const s = 10 + r() * 22;
        out.push(
          <ellipse key={i} cx={x} cy={y} rx={s} ry={s * 0.42} opacity={0.2 + r() * 0.55}
            transform={`rotate(${r() * 180} ${x} ${y})`} />
        );
      }
      break;
    case "flowers":
      for (let i = 0; i < 26; i++) {
        const x = r() * W;
        const y = r() * H;
        const s = 10 + r() * 16;
        const o = 0.25 + r() * 0.5;
        for (let p = 0; p < 5; p++) {
          const a = (Math.PI * 2 * p) / 5;
          out.push(
            <circle key={`${i}-${p}`} cx={x + Math.cos(a) * s} cy={y + Math.sin(a) * s} r={s * 0.75} opacity={o} />
          );
        }
        out.push(<circle key={`${i}-c`} cx={x} cy={y} r={s * 0.5} opacity={Math.min(1, o + 0.35)} />);
      }
      break;
    case "bubbles":
      for (let i = 0; i < 30; i++)
        out.push(<circle key={i} cx={r() * W} cy={r() * H} r={12 + r() * 70} opacity={0.08 + r() * 0.3} />);
      break;
    case "stars":
      for (let i = 0; i < 60; i++)
        out.push(<circle key={`d${i}`} cx={r() * W} cy={r() * H} r={1 + r() * 2.5} opacity={0.3 + r() * 0.6} />);
      for (let i = 0; i < 22; i++)
        out.push(<polygon key={`s${i}`} points={star(r() * W, r() * H, 6 + r() * 16)} opacity={0.3 + r() * 0.6} />);
      break;
    case "dots":
      for (let y = 15; y < H; y += 30)
        for (let x = 15; x < W; x += 30) {
          const t = x / W;
          out.push(<circle key={`${x}-${y}`} cx={x} cy={y} r={2 + t * 9} opacity={0.15 + t * 0.6} />);
        }
      break;
    case "stripes":
      for (let i = -10; i < 40; i++)
        out.push(
          <rect key={i} x={i * 48} y={-200} width={20} height={800} opacity={i % 3 === 0 ? 0.55 : 0.22}
            transform={`rotate(30 ${i * 48} 0)`} />
        );
      break;
    default:
      break;
  }
  return out;
}

/** A built-in header picture in the surrounding ``.pf-theme``'s accent. */
export function HeaderArt({ id, className }: { id: string; className?: string }) {
  const shapes = useMemo(() => draw(id), [id]);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ color: "var(--pf-accent)", display: "block" }}
    >
      <rect width={W} height={H} style={{ fill: "var(--pf-band)" }} />
      <g fill="currentColor">{shapes}</g>
    </svg>
  );
}

export function isBuiltinHeader(id: string | null | undefined): id is string {
  return !!id && BUILTIN_HEADERS.some((h) => h.id === id);
}
