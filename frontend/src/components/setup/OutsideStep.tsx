import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Globe, House, Loader2, Map as MapIcon, Mic, PhoneCall, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";

import { adminApi, type OriginPreview } from "@/api/admin";
import { setupApi, type SetupOutside } from "@/api/setup";
import { Button } from "@/components/shared/Button";
import { apiErrorMessage } from "@/utils/apiError";

const README = "https://github.com/tristenlammi/Promptly#exposure-what-should-be-reachable";

type Tone = "ok" | "todo" | "warn" | "busy";

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const icon =
    tone === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
    : tone === "warn" ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
    : tone === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
    : <Circle className="h-3.5 w-3.5" aria-hidden />;
  const cls =
    tone === "ok" ? "text-emerald-700 dark:text-emerald-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
    : "text-[var(--text-muted)]";
  return <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}>{icon}{children}</span>;
}

function Block({ icon, title, status, children, testid }: { icon: ReactNode; title: string; status?: ReactNode; children: ReactNode; testid: string }) {
  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-3" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[var(--accent-text)]">{icon}</span>
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
        <span className="ml-auto">{status}</span>
      </div>
      <div className="mt-2 space-y-2 text-xs leading-relaxed text-[var(--text-muted)]">{children}</div>
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[11px] text-[var(--text)]">{children}</span>;
}

/**
 * "Using Promptly away from home": the address people use, and the things
 * only the admin can do outside Promptly (a tunnel, router ports), shown
 * only for the services this install has. Every status here is the
 * server's: the saved address, the last test call, the map build.
 *
 * `inApp` is false inside the first-run wizard, where the rest of the app
 * isn't reachable yet, so pages are named instead of linked.
 */
export function OutsideStep({ onDone, inApp, doneLabel = "Continue" }: { onDone: () => void; inApp: boolean; doneLabel?: string }) {
  const [info, setInfo] = useState<SetupOutside | null>(null);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<OriginPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The server's view, refreshed so a test call or the map build shows up
  // while the page is open.
  useEffect(() => {
    let alive = true;
    const load = () =>
      setupApi
        .checklist()
        .then((c) => alive && setInfo(c.outside))
        .catch(() => {});
    void load();
    const t = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // Start from the saved address; else from the address in the browser when
  // that is already a real one (the tunnel was set up first).
  useEffect(() => {
    if (!info || touched || value) return;
    if (info.address) setValue(info.address);
    else if (window.location.protocol === "https:") setValue(window.location.origin);
  }, [info, touched, value]);

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        setPreview(await adminApi.previewOrigin(trimmed));
        setPreviewError(null);
      } catch (err) {
        setPreview(null);
        setPreviewError(apiErrorMessage(err, "That doesn't look like a web address."));
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [value]);

  const typed = value.trim();
  const unsaved = !!typed && typed !== (info?.address ?? "") && preview?.canonical !== info?.address;

  const next = async () => {
    setSaveError(null);
    if (!unsaved) return onDone();
    if (!preview) {
      setSaveError("Check the address, or clear the box to leave it for later.");
      return;
    }
    setSaving(true);
    try {
      // Keep the home-network and localhost entries an admin may have added.
      const others = (info?.origins ?? []).filter((o) => o !== info?.address && o !== preview.canonical);
      await adminApi.updateAppSettings({ public_origins: [preview.canonical, ...others] });
      onDone();
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Couldn't save the address."));
    } finally {
      setSaving(false);
    }
  };

  if (!info) {
    return <div className="py-6 text-center text-xs text-[var(--text-muted)]">Checking what this server has…</div>;
  }

  const port = window.location.port ? `:${window.location.port}` : "";
  const machine = info.lan_address ? <Mono>{info.lan_address}</Mono> : "this computer";
  const page = (to: string, words: string) =>
    inApp ? <Link to={to} className="font-medium text-[var(--accent-text)] hover:underline">{words}</Link> : <span className="font-medium text-[var(--text)]">{words}</span>;

  return (
    <div className="space-y-3" data-testid="outside-step">
      <Block icon={<House className="h-4 w-4" />} title="At home" status={<Pill tone="ok">Works now</Pill>} testid="outside-home">
        <p>
          Any phone or computer on your home Wi-Fi can open Promptly at{" "}
          {info.lan_address ? (
            <Mono>http://{info.lan_address}{port}</Mono>
          ) : (
            <>this computer's home-network address (the installer printed it as "from other devices on your network")</>
          )}
          . Nothing to set up.
        </p>
      </Block>

      <Block
        icon={<Globe className="h-4 w-4" />}
        title="Away from home"
        status={
          info.https ? <Pill tone="ok">Address saved</Pill>
          : info.address ? <Pill tone="warn">Not secure (http)</Pill>
          : <Pill tone="todo">Not set up</Pill>
        }
        testid="outside-address"
      >
        <p>
          To use Promptly anywhere, it needs a web address that starts with <Mono>https://</Mono>. The easy way is a
          free Cloudflare Tunnel: it gives you the address and keeps the connection private, with nothing to open on
          your router.{" "}
          <a href={README} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--accent-text)] hover:underline">
            How to set one up
          </a>
        </p>
        <div className="flex items-start gap-2 rounded-card border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-amber-800 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Don't forward the web port{port ? <> ({port.slice(1)})</> : null} on your router. That would put your
            family's sign-in page on the open internet without encryption.
          </span>
        </div>
        <label className="block pt-1">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Once you have the address, enter it here so sign-in works on it
          </span>
          <input
            value={value}
            onChange={(e) => {
              setTouched(true);
              setValue(e.target.value);
            }}
            placeholder="https://promptly.example.com"
            aria-label="Web address"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
          />
        </label>
        {previewError && <p role="alert" className="text-red-600 dark:text-red-400">{previewError}</p>}
        {preview && preview.canonical !== typed && (
          <p>Will be saved as <Mono>{preview.canonical}</Mono></p>
        )}
        {preview?.warnings.map((w, i) => (
          <p key={i} role="status" className="text-amber-700 dark:text-amber-400">{w}</p>
        ))}
      </Block>

      {(info.voice.there || info.calls.there) && (
        <Block
          icon={<Mic className="h-4 w-4" />}
          title="The microphone on phones"
          status={info.https ? <Pill tone="ok">Ready</Pill> : <Pill tone="todo">Needs the https address</Pill>}
          testid="outside-mic"
        >
          <p>
            Phones and tablets only allow the microphone and camera (Talk, dictation, calls, scanning) on an{" "}
            <Mono>https://</Mono> address. On this computer itself it already works.
            {info.https ? "" : " It starts working on phones once the address above is set up."}
          </p>
        </Block>
      )}

      {info.calls.there && (
        <Block
          icon={<PhoneCall className="h-4 w-4" />}
          title="Calls when someone is away from home"
          status={
            !info.calls.running ? <Pill tone="warn">Calls service isn't answering</Pill>
            : info.calls.outside === true ? <Pill tone="ok">Test call from outside worked</Pill>
            : info.calls.outside === false ? <Pill tone="warn">Last test from outside failed</Pill>
            : <Pill tone="todo">Not tested from outside</Pill>
          }
          testid="outside-calls"
        >
          <p>
            At home, calls work with nothing to change. For someone away from home, call sound and video travel
            straight to this computer, not through your web address, so your router has to let them in. In your
            router's settings (often called "port forwarding"), send these two to {machine}:
          </p>
          <ul className="space-y-1">
            <li><Mono>UDP {info.ports.udp}</Mono> for calls</li>
            <li><Mono>TCP {info.ports.tcp}</Mono> as a fallback</li>
          </ul>
          <p>
            Only these two. Then check it: on a phone with Wi-Fi off, open {page("/account/voice", "Account → Voice & video → Test calls")}.
            This page shows the result.
          </p>
          {!info.calls.enabled && (
            <p>Voice channels are off until you turn them on in {page("/admin?tab=calls", "Admin → Calls")}.</p>
          )}
        </Block>
      )}

      {info.maps.there && (
        <Block
          icon={<MapIcon className="h-4 w-4" />}
          title="Maps"
          status={
            info.maps.ready && info.maps.state !== "failed" ? <Pill tone="ok">Ready</Pill>
            : info.maps.state === "failed" ? <Pill tone="warn">Stopped, will try again</Pill>
            : info.maps.state === "none" ? <Pill tone="todo">No map chosen</Pill>
            : <Pill tone="busy">{info.maps.step ? `Building: ${info.maps.step}` : "Getting ready"}</Pill>
          }
          testid="outside-maps"
        >
          <p>
            {info.maps.ready
              ? "The map is downloaded and works at home and away."
              : info.maps.state === "none"
                ? "No map has been chosen yet, so Maps is empty for now."
                : "The map is being downloaded and put together in the background. The first time takes about an hour and needs room on the disk; everything else works meanwhile. Nothing for you to do."}
          </p>
        </Block>
      )}

      {saveError && (
        <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {saveError}
        </div>
      )}

      <Button type="button" variant="primary" className="w-full" onClick={() => void next()} loading={saving}>
        {unsaved ? "Save address and continue" : doneLabel}
      </Button>
    </div>
  );
}
