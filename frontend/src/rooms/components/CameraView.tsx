import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Aperture, Flashlight, FlashlightOff, Images, Loader2, RefreshCw, SendHorizontal, SwitchCamera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { roomsApi } from "@/api/rooms";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { sendMessage } from "../actions";
import {
  HOLD_MS,
  MAX_FILE_BYTES,
  MAX_VIDEO_S,
  audioBits,
  autoSettings,
  bitsForPicture,
  cameraConstraints,
  cameraProblem,
  captureName,
  focusSettings,
  pickVideoType,
  pictureSpot,
  pinchZoom,
  plainType,
  recordingClock,
  ringFraction,
  videoBits,
  zoomLabel,
  zoomRange,
  type CameraCaps,
} from "../camera";

/**
 * The camera, inside Rooms (a phone's composer has the button). A live
 * picture fills the screen; **tap** the round button for a photo, **press
 * and hold** it for a video for as long as you hold (a minute at most). Then
 * you see what you took, with Retake and Send, and room for a few words.
 * Send posts it to the conversation as a normal message with one attachment.
 *
 * The camera is on only while this is open and the page is in front: closing
 * it, sending, or switching away lets go of it (and the microphone) at once.
 * The microphone is asked for the first time you hold for a video, not
 * before; said no, a video is recorded without sound.
 *
 * Where the phone's browser lets a page do it (Chrome on Android), the
 * camera keeps itself in focus, **a tap on the picture** focuses there, and
 * **a pinch** zooms. Where it doesn't, those do nothing and show nothing.
 *
 * **Phone camera** hands over to the phone's own camera app for one photo:
 * a browser's camera gives the sensor's picture as it is, while the camera
 * app merges frames, balances light and sharpens. What it takes comes back
 * to the same review screen.
 */

type Phase = "starting" | "live" | "recording" | "review" | "sending" | "error";
type Facing = "environment" | "user";
interface Shot {
  kind: "photo" | "video";
  /** What's sent, untouched. */
  file: File;
  /** What's shown: the file itself, or a smaller copy of a big photo. */
  url: string;
}

// Chrome's still-photo API: full sensor resolution, where the phone has it.
interface PhotoRange {
  max?: number;
}
interface ImageCaptureLike {
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities?(): Promise<{ imageWidth?: PhotoRange; imageHeight?: PhotoRange }>;
}
// A still as big as the sensor gives, up to about 12 megapixels: plenty for a
// chat, and not a 50-megapixel upload on phones that offer one.
const STILL_LONG = 4032;
const STILL_SHORT = 3024;
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

/** Any picture the browser can read, re-saved as a JPEG at its own size. */
async function asJpeg(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  } catch {
    return null;
  }
}

// A 12-megapixel still decodes to about 50 MB; the review screen shows a
// copy no bigger than the screen needs. The file that's sent is the real one.
const PREVIEW_OVER_BYTES = 1_500_000;
const PREVIEW_EDGE = 2048;

async function previewUrl(file: File): Promise<string> {
  if (file.size > PREVIEW_OVER_BYTES && typeof createImageBitmap === "function") {
    try {
      const full = await createImageBitmap(file);
      const scale = Math.min(1, PREVIEW_EDGE / Math.max(full.width, full.height));
      if (scale < 1) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(full.width * scale);
        canvas.height = Math.round(full.height * scale);
        canvas.getContext("2d")?.drawImage(full, 0, 0, canvas.width, canvas.height);
        full.close?.();
        const small = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
        if (small && small.size > 0) return URL.createObjectURL(small);
      } else {
        full.close?.();
      }
    } catch {
      // A kind of picture this browser can't read here: show the file itself.
    }
  }
  return URL.createObjectURL(file);
}

/** Apply camera settings the browser may refuse; says whether they took. */
async function setCamera(track: MediaStreamTrack, settings: Record<string, unknown>): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [settings as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/** After a tap has focused somewhere, the camera goes back to looking after
 *  itself, so what you point at next is sharp too. */
const REFOCUS_MS = 4000;

const round =
  "flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40";

export function CameraView({
  roomId,
  replyToId,
  onSent,
  onClose,
  onGallery,
}: {
  roomId: string;
  /** Sent as a reply to this message, if you were replying. */
  replyToId: string | null;
  onSent: () => void;
  onClose: () => void;
  /** "Choose from gallery instead": the ordinary file picker. */
  onGallery: () => void;
}) {
  const qc = useQueryClient();
  const video = useRef<HTMLVideoElement>(null);
  const phoneCamera = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const micAsked = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const press = useRef<{ at: number; timer: number; down: boolean } | null>(null);
  const startedAt = useRef(0);
  const tick = useRef<number | null>(null);
  const stopAt = useRef<number | null>(null);
  const alive = useRef(true);
  // What this camera can do (focus, zoom), and the pinch and tap in progress.
  const caps = useRef<CameraCaps>({});
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; zoom: number } | null>(null);
  const tap = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const zoomNow = useRef(1);
  const zoomBusy = useRef(false);
  const zoomNext = useRef<number | null>(null);
  const refocus = useRef<number | null>(null);
  const ringGone = useRef<number | null>(null);
  // How big a file may be here: far more than the fallback where the server
  // takes big uploads, and the video's quality follows it.
  const { data: uploadPolicy } = useQuery({ queryKey: ["rooms", "upload-policy"], queryFn: roomsApi.uploadPolicy, staleTime: 10 * 60_000 });
  const maxBytes = uploadPolicy?.max_bytes ?? MAX_FILE_BYTES;
  const maxBytesRef = useRef(maxBytes);
  maxBytesRef.current = maxBytes;

  const [phase, setPhase] = useState<Phase>("starting");
  const [facing, setFacing] = useState<Facing>("environment");
  const [problem, setProblem] = useState("");
  const [hint, setHint] = useState("");
  const [cameras, setCameras] = useState(1);
  const [torch, setTorch] = useState<boolean | null>(null); // null: this camera has no light
  const [elapsed, setElapsed] = useState(0);
  const [shot, setShot] = useState<Shot | null>(null);
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState(0);
  const [sendError, setSendError] = useState("");
  const [zoom, setZoom] = useState<number | null>(null); // null: this camera doesn't zoom
  const [ring, setRing] = useState<{ x: number; y: number; key: number } | null>(null);

  const release = useCallback(() => {
    if (refocus.current !== null) window.clearTimeout(refocus.current);
    if (ringGone.current !== null) window.clearTimeout(ringGone.current);
    refocus.current = ringGone.current = null;
    touches.current.clear();
    pinch.current = null;
    tap.current = null;
    caps.current = {};
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  const open = useCallback(
    async (which: Facing) => {
      release();
      setTorch(null);
      setZoom(null);
      setRing(null);
      phaseRef.current = "starting";
      setPhase("starting");
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(cameraProblem(null, window.isSecureContext));
        setPhase("error");
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: cameraConstraints(which),
          audio: false,
        });
        // Gone, behind something else, or already looking at a photo the
        // phone's camera app handed back: nothing to film.
        const phaseNow = phaseRef.current as Phase; // may have moved on while the camera opened
        if (!alive.current || document.visibilityState === "hidden" || phaseNow === "review" || phaseNow === "sending") {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        const track = s.getVideoTracks()[0];
        const can = (track?.getCapabilities?.() ?? {}) as CameraCaps;
        caps.current = can;
        setTorch(can.torch ? false : null);
        // Keep itself in focus and well lit, where the phone lets a page ask.
        const auto = autoSettings(can);
        if (track && auto) void setCamera(track, auto);
        const range = zoomRange(can);
        if (range) {
          const at = (track?.getSettings?.() as { zoom?: number } | undefined)?.zoom;
          zoomNow.current = typeof at === "number" ? at : range.min;
          setZoom(zoomNow.current);
        }
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          setCameras(all.filter((d) => d.kind === "videoinput").length || 1);
        } catch {
          setCameras(1);
        }
        setPhase("live");
      } catch (e) {
        if (!alive.current) return;
        setProblem(cameraProblem(e, window.isSecureContext));
        setPhase("error");
      }
    },
    [release],
  );

  // Open on arrival; let go on leaving.
  useEffect(() => {
    alive.current = true;
    void open("environment");
    return () => {
      alive.current = false;
      if (tick.current !== null) window.clearInterval(tick.current);
      if (stopAt.current !== null) window.clearTimeout(stopAt.current);
      if (press.current) window.clearTimeout(press.current.timer);
      try {
        if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      } catch {
        // already stopped
      }
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishRecording = useCallback(() => {
    if (tick.current !== null) window.clearInterval(tick.current);
    if (stopAt.current !== null) window.clearTimeout(stopAt.current);
    tick.current = stopAt.current = null;
    const r = recorder.current;
    if (r && r.state !== "inactive") r.stop(); // onstop makes the file
  }, []);

  // The page went behind something else: stop and let go of the camera. A
  // video being recorded is kept as far as it got.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (recorder.current && recorder.current.state !== "inactive") finishRecording();
        release();
      } else if (phaseRef.current === "live" || phaseRef.current === "starting") {
        void open(facingRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [finishRecording, open, release]);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const facingRef = useRef<Facing>(facing);
  facingRef.current = facing;

  // Escape closes (not mid-send).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phaseRef.current === "sending") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const keep = useCallback(
    (kind: "photo" | "video", blob: Blob, type: string) => {
      if (!alive.current) return;
      if (blob.size === 0) {
        setHint(kind === "video" ? "That video was too short. Hold the button a little longer." : "That didn't take. Try again.");
        setPhase(stream.current ? "live" : "starting");
        if (!stream.current) void open(facingRef.current);
        return;
      }
      if (blob.size > maxBytesRef.current) {
        setHint("That video is too big to send. Try a shorter one.");
        setPhase(stream.current ? "live" : "starting");
        if (!stream.current) void open(facingRef.current);
        return;
      }
      const file = new File([blob], captureName(kind, new Date(), type), { type: plainType(type) });
      setCaption("");
      setSendError("");
      setHint("");
      phaseRef.current = "review"; // a camera still opening must not take over
      setPhase("review");
      // Nothing more to film until Retake: the camera goes off.
      release();
      if (kind === "video") {
        setShot({ kind, file, url: URL.createObjectURL(file) });
        return;
      }
      void previewUrl(file).then((url) => {
        if (alive.current) setShot({ kind, file, url });
        else URL.revokeObjectURL(url);
      });
    },
    [open, release],
  );

  const takePhoto = useCallback(async () => {
    const s = stream.current;
    const el = video.current;
    const track = s?.getVideoTracks()[0];
    if (!s || !el || !track) return;
    setHint("");
    const Capture = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (Capture) {
      try {
        const capture = new Capture(track);
        // Asked for nothing, Chrome takes the still at the preview's size
        // (about 2 megapixels). Ask for the sensor's own size.
        let size: { imageWidth?: number; imageHeight?: number } | undefined;
        try {
          const caps = await capture.getPhotoCapabilities?.();
          const w = caps?.imageWidth?.max;
          const h = caps?.imageHeight?.max;
          if (w && h) {
            const scale = Math.min(1, STILL_LONG / Math.max(w, h), STILL_SHORT / Math.min(w, h));
            size = { imageWidth: Math.round(w * scale), imageHeight: Math.round(h * scale) };
          }
        } catch {
          // No list of sizes: take what it gives.
        }
        let blob: Blob;
        try {
          blob = await capture.takePhoto(size);
        } catch (e) {
          // Some phones refuse a size they listed: the default still, then.
          if (!size) throw e;
          blob = await capture.takePhoto();
        }
        if (blob.size > 0 && blob.type === "image/jpeg") return keep("photo", blob, "image/jpeg");
        // Some browsers hand back a PNG: the same picture, as a JPEG.
        const jpeg = blob.size > 0 ? await asJpeg(blob) : null;
        if (jpeg) return keep("photo", jpeg, "image/jpeg");
      } catch {
        // Some phones refuse; the frame on screen is the photo instead.
      }
    }
    // The frame as the camera gives it: never the mirrored picture a front
    // camera is shown as.
    const w = el.videoWidth;
    const h = el.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(el, 0, 0, w, h);
    canvas.toBlob((blob) => blob && keep("photo", blob, "image/jpeg"), "image/jpeg", 0.92);
  }, [keep]);

  const startVideo = useCallback(async () => {
    const s = stream.current;
    const track = s?.getVideoTracks()[0];
    if (!s || !track || typeof MediaRecorder === "undefined") {
      setHint("This browser can't record video here. Tap for a photo.");
      return;
    }
    const type = pickVideoType((t) => MediaRecorder.isTypeSupported(t));
    if (!type) {
      setHint("This browser can't record video here. Tap for a photo.");
      return;
    }
    // The microphone, the first time only. Its prompt takes your finger off
    // the button, so that hold doesn't record: the next one does.
    if (!micAsked.current) {
      micAsked.current = true;
      let prompted = false;
      try {
        const state = await navigator.permissions?.query({ name: "microphone" as PermissionName }).then((p) => p.state).catch(() => "prompt");
        prompted = state !== "granted";
        mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        mic.current = null;
        setHint("Videos will have no sound: Promptly isn't allowed to use the microphone.");
      }
      if (!alive.current) return;
      if (prompted || !press.current?.down) {
        if (mic.current) setHint("Hold the button to record a video.");
        return;
      }
    }
    if (!press.current?.down) return; // let go while we were getting ready
    const tracks = [track, ...(mic.current?.getAudioTracks() ?? [])];
    let r: MediaRecorder;
    try {
      // As good as this picture's size wants, and never more than a minute of it fits in one file.
      const shape = track.getSettings?.() ?? {};
      const best = bitsForPicture(shape.width ?? 0, shape.height ?? 0, shape.frameRate ?? 30);
      r = new MediaRecorder(new MediaStream(tracks), {
        mimeType: type,
        videoBitsPerSecond: videoBits(maxBytesRef.current, MAX_VIDEO_S, best),
        audioBitsPerSecond: audioBits,
      });
    } catch {
      setHint("This browser can't record video here. Tap for a photo.");
      return;
    }
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
    r.onstop = () => {
      const blob = new Blob(chunks.current, { type: plainType(r.mimeType || type) });
      chunks.current = [];
      recorder.current = null;
      keep("video", blob, r.mimeType || type);
    };
    recorder.current = r;
    r.start(1000);
    startedAt.current = performance.now();
    setElapsed(0);
    setHint("");
    setPhase("recording");
    navigator.vibrate?.(15);
    tick.current = window.setInterval(() => setElapsed(performance.now() - startedAt.current), 100);
    stopAt.current = window.setTimeout(finishRecording, MAX_VIDEO_S * 1000);
  }, [finishRecording, keep]);

  // ---- the shutter: tap for a photo, hold for a video
  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (phase !== "live") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const timer = window.setTimeout(() => void startVideo(), HOLD_MS);
    press.current = { at: performance.now(), timer, down: true };
  };
  const up = () => {
    const p = press.current;
    if (!p) return;
    p.down = false;
    window.clearTimeout(p.timer);
    if (recorder.current && recorder.current.state !== "inactive") {
      finishRecording();
    } else if (performance.now() - p.at < HOLD_MS && phaseRef.current === "live") {
      void takePhoto();
    }
    press.current = null;
  };
  const cancel = () => {
    const p = press.current;
    if (!p) return;
    p.down = false;
    window.clearTimeout(p.timer);
    if (recorder.current && recorder.current.state !== "inactive") finishRecording();
    press.current = null;
  };

  // ---- on the picture: a tap focuses there, a pinch zooms. Both only where
  // this camera says it can; otherwise nothing happens and nothing shows.
  const applyZoom = (z: number) => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    zoomNow.current = z;
    setZoom(z);
    // One request at a time: a pinch asks faster than a camera answers.
    if (zoomBusy.current) {
      zoomNext.current = z;
      return;
    }
    zoomBusy.current = true;
    void setCamera(track, { zoom: z }).then(() => {
      zoomBusy.current = false;
      const next = zoomNext.current;
      zoomNext.current = null;
      if (next !== null && next !== z && stream.current) applyZoom(next);
    });
  };
  const focusAt = async (clientX: number, clientY: number) => {
    const el = video.current;
    const track = stream.current?.getVideoTracks()[0];
    if (!el || !track) return;
    const box = el.getBoundingClientRect();
    const spot = pictureSpot({ x: clientX, y: clientY }, box, { width: el.videoWidth, height: el.videoHeight }, facingRef.current === "user");
    const settings = spot && focusSettings(caps.current, spot);
    if (!settings) return;
    if (!(await setCamera(track, settings))) return;
    if (!alive.current || stream.current?.getVideoTracks()[0] !== track) return;
    setRing({ x: clientX - box.left, y: clientY - box.top, key: Date.now() });
    if (ringGone.current !== null) window.clearTimeout(ringGone.current);
    ringGone.current = window.setTimeout(() => setRing(null), 1200);
    // Then back to looking after itself.
    if (refocus.current !== null) window.clearTimeout(refocus.current);
    refocus.current = window.setTimeout(() => {
      const auto = autoSettings(caps.current);
      if (auto && stream.current?.getVideoTracks()[0] === track) void setCamera(track, auto);
    }, REFOCUS_MS);
  };
  const gap = () => {
    const [a, b] = [...touches.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const pictureDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (phaseRef.current !== "live" && phaseRef.current !== "recording") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 1) {
      tap.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
    } else {
      tap.current = null;
      pinch.current = touches.current.size === 2 && zoomRange(caps.current) ? { gap: gap(), zoom: zoomNow.current } : null;
    }
  };
  const pictureMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = tap.current;
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) tap.current = null;
    const p = pinch.current;
    const range = zoomRange(caps.current);
    if (p && range && touches.current.size === 2) {
      const z = pinchZoom(p.zoom, p.gap, gap(), range);
      if (z !== zoomNow.current) applyZoom(z);
    }
  };
  const pictureUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    touches.current.delete(e.pointerId);
    pinch.current = null;
    const t = tap.current;
    tap.current = null;
    if (t && t.id === e.pointerId && e.type === "pointerup" && performance.now() - t.at < 500) void focusAt(t.x, t.y);
  };

  const flip = () => {
    const next: Facing = facing === "environment" ? "user" : "environment";
    setFacing(next);
    void open(next);
  };
  const light = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setSendError("");
    void open(facing);
  };

  const send = async () => {
    if (!shot || phase === "sending") return;
    setPhase("sending");
    setSendError("");
    setProgress(0);
    try {
      const att = await roomsApi.upload(roomId, shot.file, setProgress, undefined, uploadPolicy);
      void sendMessage(qc, roomId, { body: caption.trim(), reply_to_id: replyToId, attachments: [att] });
      URL.revokeObjectURL(shot.url);
      onSent();
    } catch (e) {
      if (!alive.current) return;
      // Still here to try again: nothing you took is lost.
      setSendError(apiErrorMessage(e, "Couldn't send that. Check your connection and try again."));
      setPhase("review");
    }
  };

  // A photo from the phone's own camera app. Backing out of it gives no
  // file and changes nothing.
  const fromPhoneCamera = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setHint("That wasn't a photo. Tap the round button, or try the phone camera again.");
      return;
    }
    keep("photo", file, file.type);
  };

  const reviewing = (phase === "review" || phase === "sending") && shot;
  const developing = (phase === "review" || phase === "sending") && !shot;
  const recording = phase === "recording";
  const R = 36;
  const around = 2 * Math.PI * R;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Camera" data-testid="camera-view" className="fixed inset-0 z-[92] flex select-none flex-col bg-black text-white">
      {/* The phone's own camera app: one tap, no chooser (images only). */}
      <input ref={phoneCamera} type="file" accept="image/*" capture="environment" onChange={fromPhoneCamera} className="hidden" tabIndex={-1} aria-hidden data-testid="camera-phone-input" />
      {/* ---- the picture */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!reviewing && !developing && (
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            onPointerDown={pictureDown}
            onPointerMove={pictureMove}
            onPointerUp={pictureUp}
            onPointerCancel={pictureUp}
            className={cn("h-full w-full touch-none object-cover", facing === "user" && "-scale-x-100", phase === "error" && "hidden")}
          />
        )}
        {ring && !reviewing && !developing && (
          <span
            key={ring.key}
            aria-hidden
            data-testid="camera-focus-ring"
            style={{ left: ring.x, top: ring.y }}
            className="pointer-events-none absolute h-16 w-16 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-2 border-white/90"
          />
        )}
        {reviewing && shot.kind === "photo" && <img src={shot.url} alt="The photo you took" className="h-full w-full object-contain" />}
        {reviewing && shot.kind === "video" && <video src={shot.url} controls playsInline autoPlay loop className="h-full w-full object-contain" data-testid="camera-review-video" />}

        {(phase === "starting" || developing) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-white/70" />
          </div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <p className="max-w-sm text-base text-white/90">{problem}</p>
            <button
              type="button"
              onClick={() => phoneCamera.current?.click()}
              className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black"
            >
              <Aperture className="h-4 w-4" />
              Use the phone's camera app
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onGallery();
              }}
              className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/25"
            >
              <Images className="h-4 w-4" />
              Choose from gallery instead
            </button>
          </div>
        )}

        {/* ---- along the top */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-3 pt-safe">
          <button type="button" aria-label="Close the camera" onClick={onClose} disabled={phase === "sending"} className={round}>
            <X className="h-5 w-5" />
          </button>
          {recording && (
            <span role="timer" aria-live="off" className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-sm font-medium tabular-nums">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--danger)]" />
              {recordingClock(elapsed)}
            </span>
          )}
          {phase === "live" && torch !== null ? (
            <button type="button" aria-label={torch ? "Turn the light off" : "Turn the light on"} aria-pressed={torch} onClick={() => void light()} className={round}>
              {torch ? <Flashlight className="h-5 w-5" /> : <FlashlightOff className="h-5 w-5" />}
            </button>
          ) : (
            <span className="h-11 w-11" />
          )}
        </div>

        {zoom !== null && zoom > (zoomRange(caps.current)?.min ?? 1) + 0.05 && !reviewing && !developing && phase !== "error" && (
          <span data-testid="camera-zoom" className="pointer-events-none absolute inset-x-0 bottom-16 mx-auto w-fit rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium tabular-nums">
            {zoomLabel(zoom)}
          </span>
        )}
        {hint && !reviewing && phase !== "error" && (
          <p role="status" className="absolute inset-x-6 bottom-4 mx-auto w-fit max-w-sm rounded-xl bg-black/65 px-3 py-2 text-center text-sm">
            {hint}
          </p>
        )}
      </div>

      {/* ---- along the bottom */}
      {!reviewing && !developing && phase !== "error" && (
        <div className="flex shrink-0 flex-col items-center gap-2 px-6 pb-safe pt-4">
          <div className="grid w-full max-w-sm grid-cols-3 items-center pb-3">
            <span className="flex justify-start">
              {(phase === "live" || phase === "starting") && (
                <button
                  type="button"
                  onClick={() => phoneCamera.current?.click()}
                  data-testid="camera-phone-camera"
                  aria-label="Use the phone's camera app for a sharper photo"
                  className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1 text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <Aperture className="h-6 w-6" />
                  <span className="whitespace-nowrap text-[11px] font-medium leading-tight">Phone camera</span>
                </button>
              )}
            </span>
            <button
              type="button"
              aria-label="Take a photo, or hold for a video"
              data-testid="camera-shutter"
              disabled={phase !== "live" && !recording}
              onPointerDown={down}
              onPointerUp={up}
              onPointerCancel={cancel}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                // A keyboard has no hold: Enter or Space is a photo.
                if ((e.key === "Enter" || e.key === " ") && phase === "live" && !e.repeat) {
                  e.preventDefault();
                  void takePhoto();
                }
              }}
              style={{ touchAction: "none", WebkitTouchCallout: "none" }}
              className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
            >
              <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
                <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="4" />
                {recording && (
                  <circle
                    cx="40"
                    cy="40"
                    r={R}
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={around}
                    strokeDashoffset={around * (1 - ringFraction(elapsed))}
                  />
                )}
              </svg>
              <span className={cn("block rounded-full transition-all duration-150", recording ? "h-8 w-8 rounded-lg bg-[var(--danger)]" : "h-[58px] w-[58px] bg-white")} />
            </button>
            <span className="flex justify-end">
              {phase === "live" && cameras > 1 && (
                <button type="button" aria-label="Switch between the front and back camera" onClick={flip} className={round}>
                  <SwitchCamera className="h-5 w-5" />
                </button>
              )}
            </span>
          </div>
          <p className="pb-3 text-center text-xs text-white/70">{recording ? "Let go to stop" : "Tap for a photo, hold for a video. Phone camera takes a sharper one."}</p>
        </div>
      )}

      {reviewing && (
        <div className="flex shrink-0 flex-col gap-2 px-3 pb-safe pt-3">
          {sendError && (
            <p role="alert" className="rounded-lg bg-[var(--danger)]/20 px-3 py-2 text-sm text-white">
              {sendError}
            </p>
          )}
          <div className="flex items-center gap-2 pb-3">
            <button type="button" onClick={retake} disabled={phase === "sending"} className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-4 text-sm font-medium hover:bg-white/25 disabled:opacity-40">
              <RefreshCw className="h-4 w-4" />
              Retake
            </button>
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              disabled={phase === "sending"}
              maxLength={2000}
              placeholder="Add a few words…"
              aria-label="A few words to go with it"
              enterKeyHint="send"
              className="h-11 min-w-0 flex-1 rounded-full border border-white/20 bg-white/10 px-4 text-[15px] text-white placeholder:text-white/55 focus:border-white/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={phase === "sending"}
              aria-label={shot.kind === "photo" ? "Send this photo" : "Send this video"}
              data-testid="camera-send"
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-70"
            >
              {phase === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
              {phase === "sending" ? `${Math.round(progress * 100)}%` : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
