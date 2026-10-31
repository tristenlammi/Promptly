import { Camera, History, Keyboard, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ItemButton, List, ListRow, TextInput } from "@/items/ui";

import { barcodeProblem, defaultPortionText, foodLabel, normalizeBarcode } from "./lib";
import type { Food, Settings } from "./types";

/*
 * Barcode scanning with the browser's own BarcodeDetector + the rear
 * camera. That API exists in Chrome / Edge on Android (and some desktop
 * Chrome builds) but NOT in Safari on iPhone / iPad or in Firefox — and no
 * extra decoder library is bundled — so everywhere else the typed number is
 * the main path: it's checked (length + GTIN check digit) before any
 * lookup, and foods you've scanned or typed before are one tap away (from
 * your own library, so that works offline too).
 */

interface Detected {
  rawValue: string;
}
type DetectorCtor = new (opts?: { formats?: string[] }) => { detect(src: CanvasImageSource): Promise<Detected[]> };

function detectorCtor(): DetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: DetectorCtor };
  return typeof w.BarcodeDetector === "function" ? w.BarcodeDetector : null;
}

export function canScan(): boolean {
  return !!detectorCtor() && !!navigator.mediaDevices?.getUserMedia;
}

const NO_CAMERA_SCAN =
  "Camera scanning needs Chrome or Edge on Android (iPhone, iPad and this browser can't read barcodes from the camera yet). Type the digits printed under the barcode instead — it's checked before it's looked up.";

export function Scanner({
  onCode,
  busy,
  recent = [],
  onRecent,
  settings,
}: {
  onCode: (code: string) => void;
  busy?: boolean;
  recent?: Food[];
  onRecent?: (f: Food) => void;
  settings?: Settings;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(canScan() ? null : NO_CAMERA_SCAN);
  const [typed, setTyped] = useState("");
  const [touched, setTouched] = useState(false);
  const [starting, setStarting] = useState(canScan());
  const done = useRef(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let alive = true;
    done.current = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!alive || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
        setStarting(false);
        let detector: InstanceType<DetectorCtor>;
        try {
          detector = new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "itf"] });
        } catch {
          detector = new Ctor();
        }
        const tick = async () => {
          if (!alive || done.current || !video.current) return;
          try {
            if (video.current.readyState >= 2) {
              const found = await detector.detect(video.current);
              // Only accept a read whose check digit is right (a misread
              // frame just keeps scanning).
              const code = found.map((f) => normalizeBarcode(f.rawValue.replace(/\D/g, ""))).find((c): c is string => !!c);
              if (code) {
                done.current = true;
                navigator.vibrate?.(40);
                onCodeRef.current(code);
                return;
              }
            }
          } catch {
            /* a frame that couldn't be read */
          }
          timer = window.setTimeout(tick, 220);
        };
        void tick();
      } catch (e) {
        setStarting(false);
        const name = (e as { name?: string })?.name;
        setError(name === "NotAllowedError" ? "Camera access was refused — allow it in your browser settings, or type the number below." : "The camera couldn't start — type the number below instead.");
      }
    })();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const digits = typed.replace(/\D/g, "");
  const problem = barcodeProblem(digits);
  const submit = () => {
    setTouched(true);
    const code = normalizeBarcode(digits);
    if (code) onCode(code);
  };

  return (
    <div className="flex flex-col gap-3">
      {!error ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
          <video ref={video} playsInline muted className="h-full w-full object-cover" aria-label="Camera preview for barcode scanning" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          {(starting || busy) && (
            <div className="absolute inset-0 flex items-center justify-center text-white">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          <p className="absolute inset-x-0 bottom-2 text-center text-xs font-medium text-white/90">
            <Camera className="mr-1 inline h-3.5 w-3.5" /> Point at the barcode
          </p>
        </div>
      ) : (
        <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--text-muted)]">{error}</p>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Keyboard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <TextInput
              inputMode="numeric"
              autoComplete="off"
              aria-label="Barcode number"
              aria-invalid={touched && !!problem}
              aria-describedby="meals-barcode-hint"
              placeholder="e.g. 9300633603557"
              value={typed}
              autoFocus={!!error}
              onChange={(e) => setTyped(e.target.value.replace(/[^\d ]/g, "").slice(0, 20))}
              onBlur={() => digits && setTouched(true)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="pl-9 tabular-nums"
            />
          </div>
          <ItemButton variant="primary" disabled={!digits || !!problem || busy} onClick={submit}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Look up"}
          </ItemButton>
        </div>
        <p id="meals-barcode-hint" className={touched && problem ? "px-1 text-xs text-[var(--danger)]" : "px-1 text-xs text-[var(--text-muted)]"} aria-live="polite">
          {touched && problem ? problem : digits && !problem ? "Looks right." : "The 8, 12 or 13 digits under the stripes."}
        </p>
      </div>
      {recent.length > 0 && onRecent && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <History className="h-3.5 w-3.5" /> Scanned before
          </h3>
          <List>
            {recent.map((f) => (
              <ListRow key={f.id} onClick={() => onRecent(f)} title={foodLabel(f)} subtitle={[f.barcode, settings ? defaultPortionText(f, settings) : null].filter(Boolean).join(" · ")} />
            ))}
          </List>
        </section>
      )}
    </div>
  );
}
