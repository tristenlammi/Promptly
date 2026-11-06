// QR in and out. The decoder is a pinned JS library, since BarcodeDetector is missing
// on Firefox and Safari. Everything runs on this device; images never leave it.
import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import { Button, errorText, Modal } from "./kit";

export function QrImage({ text, size = 220 }: { text: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: "M" }).then(setSrc);
  }, [text, size]);
  return src ? <img src={src} alt="QR code" width={size} height={size} className="rounded-lg bg-white p-1" /> : null;
}

export async function decodeQrFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

/** A resolver the current camera dialog answers. */
let openCamera: ((resolve: (text: string | null) => void) => void) | null = null;

export function scanQrFromCamera(): Promise<string | null> {
  if (!openCamera) return Promise.resolve(null);
  return new Promise((resolve) => openCamera!(resolve));
}

export function QrCameraHost() {
  const [resolver, setResolver] = useState<((t: string | null) => void) | null>(null);
  useEffect(() => {
    openCamera = (r) => setResolver(() => r);
    return () => {
      openCamera = null;
    };
  }, []);
  if (!resolver) return null;
  return (
    <CameraScanner
      onClose={(text) => {
        resolver(text);
        setResolver(null);
      }}
    />
  );
}

function CameraScanner({ onClose }: { onClose: (text: string | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = () => {
          if (done || !video.current) return;
          const v = video.current;
          if (v.videoWidth) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const hit = jsQR(img.data, img.width, img.height);
              if (hit?.data) {
                done = true;
                onClose(hit.data);
                return;
              }
            }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        setError(errorText(e));
      }
    })();
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onClose]);

  return (
    <Modal title="Scan a QR code" onClose={() => onClose(null)}>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <video ref={video} className="w-full rounded-lg" muted playsInline />}
      <Button className="mt-3" onClick={() => onClose(null)}>Cancel</Button>
    </Modal>
  );
}
