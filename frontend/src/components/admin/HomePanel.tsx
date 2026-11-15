import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Printer, Router } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { homeAdminApi, type AdminBox, type PreparedBox } from "@/api/home";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { SettingsCard } from "./SettingsCard";

/**
 * Admin → Home: turn Promptly Home on, and prepare boxes to hand out.
 *
 * Preparing a box gives two things, each shown once: the **setup string**
 * that goes into the box (so it knows this server and who it is), and the
 * **card** (a code and a QR) that goes with the box to whoever gets it.
 * After that this page only says whether a box was claimed and whether it's
 * online: whose home it's in and what's in that home isn't shown to admins.
 */

const KEY = ["home", "admin"];
const btn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60";
const primary = cn(btn, "bg-[var(--accent-strong)] text-white hover:opacity-90");
const quiet = cn(btn, "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]");

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "never";
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy. Select it and copy by hand.");
  }
}

export function HomePanel() {
  const qc = useQueryClient();
  // Asked again every few seconds until this server's own box is up.
  const { data: settings } = useQuery({
    queryKey: [...KEY, "settings"],
    queryFn: homeAdminApi.settings,
    refetchInterval: (q) => (q.state.data?.bundled && !q.state.data.box_ready ? 4000 : false),
  });
  const { data: boxes, isError, refetch } = useQuery({ queryKey: [...KEY, "boxes"], queryFn: homeAdminApi.boxes, refetchInterval: 15_000 });
  const [label, setLabel] = useState("");
  // Where boxes dial: this server as the outside world reaches it.
  const [server, setServer] = useState(() => window.location.origin);
  const [fresh, setFresh] = useState<PreparedBox | null>(null);
  const [card, setCard] = useState<{ code: string; url: string } | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const again = () => void qc.invalidateQueries({ queryKey: [...KEY, "boxes"] });
  const oops = (e: unknown) => toast.error(apiErrorMessage(e, "That didn't work. Try again."));

  const toggle = useMutation({
    mutationFn: homeAdminApi.setEnabled,
    onSuccess: (row) => {
      qc.setQueryData([...KEY, "settings"], row);
      void qc.invalidateQueries({ queryKey: ["home", "available"] });
    },
    onError: oops,
  });
  const prepare = useMutation({
    mutationFn: () => homeAdminApi.prepare(label.trim(), server.trim()),
    onSuccess: (made) => {
      setFresh(made);
      setCard({ code: made.claim_code, url: made.claim_url });
      setSetup(made.setup);
      setLabel("");
      again();
    },
    onError: oops,
  });

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard title="Promptly Home" icon={<Router className="h-4 w-4" />}>
        <label className="flex items-start justify-between gap-4">
          <span className="text-sm">
            <span className="font-medium text-[var(--text)]">Turn on Promptly Home</span>
            <span className="mt-0.5 block text-[var(--text-muted)]">
              {settings?.bundled
                ? "Your smart devices, in Promptly. Turn this on, then open Home: your home is there, ready for \"Add a device\". You add the rest of your household from Home's settings. Nobody outside a home sees its devices, admins included."
                : "People get a Home page for the smart devices in their own home. Nobody outside a home sees its devices, admins included."}
            </span>
            {settings?.bundled && (
              <span role="status" className="mt-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", settings.box_ready ? "bg-[var(--success)]" : "animate-pulse bg-[var(--warning)]")} aria-hidden />
                {settings.box_ready
                  ? "This server's home box is running."
                  : settings.box_online
                    ? "This server's home box is setting itself up. A minute or two."
                    : "This server's home box is starting. If this hasn't changed in ten minutes, check the Promptly-Home containers are running."}
              </span>
            )}
            {settings && !settings.bundled && (
              <span className="mt-2 block text-xs text-[var(--text-muted)]">
                This server doesn't have its own home box. Run Promptly's update to add it (it's bundled from this version on), or use a separate box below.
              </span>
            )}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Turn on Promptly Home"
            className="mt-1 h-5 w-5 accent-[var(--accent)]"
            checked={settings?.enabled ?? false}
            disabled={!settings || toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
        </label>
      </SettingsCard>

      <details className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-[var(--text)]">
          Other homes (advanced)
          <span className="ml-2 font-normal text-[var(--text-muted)]">A separate box, for a home that isn't where this server is.</span>
        </summary>
        <div className="flex flex-col gap-5 border-t border-[var(--border)] p-4">
      <SettingsCard title="How it works">
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p className="text-[var(--text-muted)]">
            A home box is a small computer in someone's home. It runs Home Assistant, a free program that knows how to talk to thousands of smart
            devices, plus a small Promptly connector that links it to this server. People only ever see Promptly.
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li><span className="font-medium">Start with a fresh Home Assistant.</span> <span className="text-[var(--text-muted)]">One nobody has opened or set up. The connector sets it up by itself. Add the connector and nothing else.</span></li>
            <li><span className="font-medium">Prepare a box below.</span> <span className="text-[var(--text-muted)]">You get a setup string for the box, and a card (a code and a QR) for whoever will use it. Both are shown once.</span></li>
            <li>
              <span className="font-medium">Start the box with the setup string.</span>{" "}
              <span className="text-[var(--text-muted)]">
                Two ways. To try it on any computer with Docker: open a terminal in this repository's <code className="rounded bg-[var(--hover)] px-1">home-box/compose</code> folder and
                run the two commands shown after you prepare a box. For a real box (a Home Assistant Green, a Raspberry Pi): install the Promptly Home add-on and
                paste the setup string into its settings. <code className="rounded bg-[var(--hover)] px-1">home-box/README.md</code> has every step.
              </span>
            </li>
            <li><span className="font-medium">Wait for "Waiting to be claimed · online".</span> <span className="text-[var(--text-muted)]">That means the box reached this server and nobody has added it to a home yet. It takes about a minute.</span></li>
            <li><span className="font-medium">Hand over the card.</span> <span className="text-[var(--text-muted)]">They open Home, tap Add a home box and type the code (or scan the QR). From then on the box and its devices are theirs: you see only that it was claimed and whether it's online.</span></li>
          </ol>
          <p className="text-xs text-[var(--text-muted)]">
            With Docker on Windows or macOS the box can't find devices by itself; people add them by brand and type the device's address. A real box, or Docker on Linux, finds them.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard title="Prepare a box">
        <p className="text-sm text-[var(--text-muted)]">
          Do this once for each box you hand out. You get a setup string to paste into the box, and a card to give with it.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-[var(--text-muted)]">
            A note for yourself (who it's for)
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Sam's box" className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" />
          </label>
          <button type="button" className={primary} disabled={prepare.isPending || !/^https?:\/\/\S+$/.test(server.trim())} onClick={() => prepare.mutate()}>
            {prepare.isPending ? "Preparing…" : "Prepare a box"}
          </button>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-[var(--text-muted)]">
          This server's address, as a box in someone's home will reach it
          <input value={server} onChange={(e) => setServer(e.target.value)} maxLength={300} inputMode="url" spellCheck={false} placeholder="https://promptly.example.com" className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-xs text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" />
        </label>
        {(setup || card) && (
          <div className="mt-4 flex flex-col gap-4 rounded-xl border border-[var(--warning)]/50 p-3">
            <p className="text-sm font-medium text-[var(--text)]">
              {fresh ? "Save these now." : "Here's the new one."} They're shown this once; only you can make new ones.
            </p>
            {setup && (
              <div>
                <p className="text-xs font-medium text-[var(--text-muted)]">1 · Setup string: goes into the box</p>
                <div className="mt-1 flex items-start gap-2">
                  <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-[var(--hover)] px-2 py-1.5 text-xs text-[var(--text)]">{setup}</code>
                  <button type="button" className={quiet} onClick={() => void copy(setup, "Setup string")}><Copy className="h-3.5 w-3.5" /> Copy</button>
                </div>
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  With Docker: in a terminal in the <code className="rounded bg-[var(--hover)] px-1">home-box/compose</code> folder, run this (it saves the setup string and starts the box).
                  On a Home Assistant OS box: paste the setup string into the Promptly Home add-on's settings instead.
                </p>
                {([
                  ["Windows (PowerShell)", `Set-Content .env "PROMPTLY_SETUP=${setup}"; docker compose up -d --build`],
                  ["macOS or Linux", `echo "PROMPTLY_SETUP=${setup}" > .env && docker compose up -d --build`],
                ] as const).map(([where, command]) => (
                  <div key={where} className="mt-2">
                    <p className="text-xs text-[var(--text-muted)]">{where}</p>
                    <div className="mt-1 flex items-start gap-2">
                      <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-[var(--hover)] px-2 py-1.5 text-xs text-[var(--text)]">{command}</code>
                      <button type="button" className={quiet} onClick={() => void copy(command, "Command")}><Copy className="h-3.5 w-3.5" /> Copy</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {card && <ClaimCard code={card.code} url={card.url} />}
            <button type="button" className={cn(quiet, "self-start")} onClick={() => { setFresh(null); setCard(null); setSetup(null); }}>I've saved them</button>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Boxes">
        {isError && (
          <p className="text-sm text-[var(--text-muted)]">
            Couldn't load the boxes. <button type="button" className="font-medium text-[var(--accent-text,var(--accent))] hover:underline" onClick={() => void refetch()}>Try again</button>
          </p>
        )}
        {boxes && boxes.length === 0 && <p className="text-sm text-[var(--text-muted)]">No boxes yet.</p>}
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {boxes?.map((b) => (
            <BoxRow
              key={b.id}
              box={b}
              onCard={(c) => { setFresh(null); setSetup(null); setCard(c); }}
              server={server.trim()}
              onSetup={(s) => { setFresh(null); setCard(null); setSetup(s); }}
              onChanged={again}
            />
          ))}
        </ul>
      </SettingsCard>
        </div>
      </details>
    </div>
  );
}

function status(b: AdminBox): string {
  if (b.revoked) return "Cut off";
  const where = b.claimed ? "In a home" : b.has_code ? "Waiting to be claimed" : "Needs a new card";
  return `${where} · ${b.online ? "online" : `offline, last seen ${when(b.last_seen_at)}`}`;
}

function BoxRow({ box, server, onCard, onSetup, onChanged }: { box: AdminBox; server: string; onCard: (c: { code: string; url: string }) => void; onSetup: (s: string) => void; onChanged: () => void }) {
  const oops = (e: unknown) => toast.error(apiErrorMessage(e, "That didn't work. Try again."));
  const newCard = useMutation({ mutationFn: () => homeAdminApi.newCode(box.id), onSuccess: (c) => { onCard({ code: c.claim_code, url: c.claim_url }); onChanged(); }, onError: oops });
  const newSetup = useMutation({ mutationFn: () => homeAdminApi.newSetup(box.id, server), onSuccess: (s) => { onSetup(s); onChanged(); }, onError: oops });
  const revoke = useMutation({ mutationFn: () => homeAdminApi.revoke(box.id, !box.revoked), onSuccess: onChanged, onError: oops });
  const remove = useMutation({ mutationFn: () => homeAdminApi.remove(box.id), onSuccess: onChanged, onError: oops });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", box.revoked ? "bg-[var(--danger)]" : box.online ? "bg-[var(--success)]" : "bg-[var(--border)]")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text)]">{box.label || "Unnamed box"}</p>
        <p className="text-xs text-[var(--text-muted)]">{status(box)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!box.claimed && !box.revoked && <button type="button" className={quiet} disabled={newCard.isPending} onClick={() => newCard.mutate()}>New card</button>}
        {!box.revoked && (
          <button type="button" className={quiet} disabled={newSetup.isPending} onClick={() => { if (window.confirm("Make a new setup string? The one in the box stops working until you paste the new one in.")) newSetup.mutate(); }}>
            New setup
          </button>
        )}
        <button type="button" className={quiet} disabled={revoke.isPending} onClick={() => { if (box.revoked || window.confirm("Cut this box off? It can't connect until you let it back.")) revoke.mutate(); }}>
          {box.revoked ? "Let it back" : "Cut off"}
        </button>
        {!box.claimed && <button type="button" className={cn(quiet, "text-[var(--danger)]")} disabled={remove.isPending} onClick={() => { if (window.confirm("Delete this box?")) remove.mutate(); }}>Delete</button>}
      </div>
    </li>
  );
}

/** The card that goes with the box: a QR that opens the Home page with the
 *  code filled in, and the code to type. */
function ClaimCard({ code, url }: { code: string; url: string }) {
  const [qr, setQr] = useState("");
  useEffect(() => {
    void QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }).then(setQr);
  }, [url]);
  const print = () => {
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) return toast.error("Allow pop-ups to print the card.");
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
    w.document.write(
      `<!doctype html><title>Promptly Home box</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:24px;color:#1c1917">` +
        `<h1 style="font-size:20px;margin:0 0 4px">Your Promptly Home box</h1>` +
        `<p style="font-size:13px;margin:0 0 12px">1. Plug it into power and your router.<br>2. Scan this with your phone's camera.<br>3. Tap "Add this box".</p>` +
        `<img src="${qr}" width="220" height="220" alt=""><p style="font:600 24px ui-monospace,monospace;letter-spacing:3px;margin:12px 0 4px">${esc(code)}</p>` +
        `<p style="font-size:12px;color:#57534e;margin:0">No camera? Open Promptly → Home → Add a home box, and type the code.</p></body>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <div>
      <p className="text-xs font-medium text-[var(--text-muted)]">2 · The card: print it and give it with the box</p>
      <div className="mt-1 flex flex-wrap items-center gap-4">
        {qr && <img src={qr} alt="QR code that opens the Home page with this box's code" width={132} height={132} className="rounded-lg bg-white p-1" />}
        <div className="flex flex-col items-start gap-2">
          <code className="select-all rounded-lg bg-[var(--hover)] px-3 py-1.5 font-mono text-lg tracking-widest text-[var(--text)]">{code}</code>
          <div className="flex gap-2">
            <button type="button" className={quiet} onClick={print} disabled={!qr}><Printer className="h-3.5 w-3.5" /> Print card</button>
            <button type="button" className={quiet} onClick={() => void copy(code, "Code")}><Copy className="h-3.5 w-3.5" /> Copy code</button>
          </div>
        </div>
      </div>
    </div>
  );
}
