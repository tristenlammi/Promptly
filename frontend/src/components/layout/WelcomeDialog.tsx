import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Download, Image, Loader2, MessageCircle, NotebookPen, Share, Sparkles, SquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { authApi } from "@/api/auth";
import { apiClient } from "@/api/client";
import { porchApi } from "@/api/porch";
import { roomsApi, type RoomUser } from "@/api/rooms";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useInstallPrompt } from "@/lib/installPrompt";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { UserAvatar } from "@/rooms/components/ui";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** The iPhone way to install: Safari's Share → Add to Home Screen. */
export function IosHomeScreenSteps() {
  return (
    <ol className="flex flex-col gap-2 text-sm text-[var(--text)]">
      <li className="flex items-start gap-2">
        <span className="font-semibold">1.</span>
        <span>
          Open Promptly in <b>Safari</b>.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span className="font-semibold">2.</span>
        <span>
          Tap <b>Share</b> <Share className="inline h-4 w-4 align-text-bottom text-[var(--accent-text)]" aria-label="(the square with an arrow)" />{" "}
          at the bottom of the screen.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span className="font-semibold">3.</span>
        <span>
          Scroll down and tap <b>Add to Home Screen</b>{" "}
          <SquarePlus className="inline h-4 w-4 align-text-bottom text-[var(--accent-text)]" aria-hidden />, then <b>Add</b>.
        </span>
      </li>
    </ol>
  );
}

const WHAT: { icon: typeof MessageCircle; label: string }[] = [
  { icon: MessageCircle, label: "Messages with your family" },
  { icon: Image, label: "Your photos, backed up and private" },
  { icon: Calendar, label: "A shared calendar" },
  { icon: NotebookPen, label: "Notes and lists" },
  { icon: Sparkles, label: "An AI helper to ask anything" },
];

/** First sign-in for a new member (not admins — they set the place up): a
 *  short welcome — what Promptly is, putting it on this device, and saying
 *  hi to the person who invited them — then they land on Today. Answered
 *  once (``settings.features_chosen``); the sidebar's optional apps keep
 *  their new-member defaults and live in Account → Sidebar features. */
export function WelcomeDialog() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const install = useInstallPrompt();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<null | "finish" | "dm">(null);

  const ask = !!user && user.role !== "admin" && !user.must_change_password && !user.settings?.features_chosen;

  // First sign-in lands on Today, not an empty chat. Only the default
  // landing (/chat) is redirected; a link they followed is kept.
  const redirected = useRef(false);
  useEffect(() => {
    if (ask && !redirected.current && pathname === "/chat") {
      redirected.current = true;
      navigate("/today", { replace: true });
    }
  }, [ask, pathname, navigate]);

  const { data: host } = useQuery({
    queryKey: ["people", "host"],
    queryFn: async () => (await apiClient.get<{ user: RoomUser | null }>("/people/host")).data.user,
    enabled: ask,
    staleTime: Infinity,
  });
  const { data: porchOn } = useQuery({
    queryKey: ["porch", "available"],
    queryFn: porchApi.available,
    enabled: ask,
    staleTime: 5 * 60_000,
  });

  if (!ask) return null;

  const installed = install.standalone || install.installed;
  // Already in the installed app: nothing to install, skip that step.
  const steps = installed ? (["what", "hi"] as const) : (["what", "install", "hi"] as const);
  const current = steps[Math.min(step, steps.length - 1)];
  const last = step >= steps.length - 1;

  const markDone = async (): Promise<boolean> => {
    try {
      setUser(await authApi.updatePreferences({ features_chosen: true }));
      return true;
    } catch {
      toast.error("Couldn't save that. Try again in a moment.");
      return false;
    }
  };

  const finish = async (to = "/today") => {
    setBusy("finish");
    if (await markDone()) navigate(to);
    setBusy(null);
  };

  const sayHi = async () => {
    if (!host) return;
    setBusy("dm");
    try {
      const room = await roomsApi.openDm([host.id]);
      await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      if (await markDone()) navigate(`/rooms/r/${room.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't start the conversation."));
    } finally {
      setBusy(null);
    }
  };

  const titles = {
    what: `Welcome${user?.username ? `, ${user.username}` : ""}`,
    install: "Put Promptly on this device",
    hi: "Say hi",
  } as const;
  const descriptions = {
    what: "Promptly is your family's private space. Only the people here can see what you share.",
    install: "It opens like any other app, full screen, with its own icon.",
    hi: "Let them know you're in.",
  } as const;

  return (
    <Modal
      open
      onClose={() => void finish()}
      title={titles[current]}
      description={descriptions[current]}
      widthClass="max-w-md"
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="mr-auto text-xs text-[var(--text-muted)]" aria-live="polite">
            Step {Math.min(step, steps.length - 1) + 1} of {steps.length}
          </span>
          {step > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setStep((s) => s - 1)} disabled={busy !== null}>
              Back
            </Button>
          )}
          {last ? (
            <Button variant="primary" size="sm" onClick={() => void finish()} loading={busy === "finish"} disabled={busy !== null}>
              Start using Promptly
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => setStep((s) => s + 1)}>
              Next
            </Button>
          )}
        </div>
      }
    >
      <div data-testid="welcome-dialog" data-step={current}>
        {current === "what" && (
          <ul className="flex flex-col gap-2.5">
            {WHAT.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm text-[var(--text)]">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent-text)]">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                {label}
              </li>
            ))}
          </ul>
        )}

        {current === "install" && (
          <div className="flex flex-col gap-3">
            {install.ios ? (
              <IosHomeScreenSteps />
            ) : install.canPrompt ? (
              <Button
                variant="primary"
                onClick={() => void install.prompt()}
                className="self-start"
              >
                <Download className="h-4 w-4" aria-hidden /> Install Promptly
              </Button>
            ) : (
              <p className="text-sm text-[var(--text)]">The Install apps page shows how, for this device.</p>
            )}
            <button
              type="button"
              onClick={() => void finish("/apps/install")}
              className="self-start text-sm font-medium text-[var(--accent-text)] hover:underline"
            >
              {install.ios ? "More help with installing" : "Open Install apps"}
            </button>
          </div>
        )}

        {current === "hi" && (
          <div className="flex flex-col gap-3">
            {host ? (
              <button
                type="button"
                onClick={() => void sayHi()}
                disabled={busy !== null}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)] disabled:opacity-60"
              >
                <UserAvatar user={host} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--text)]">Message {host.username}</span>
                  <span className="block text-xs text-[var(--text-muted)]">They set up Promptly for your family.</span>
                </span>
                {busy === "dm" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MessageCircle className="h-4 w-4 text-[var(--accent-text)]" aria-hidden />}
              </button>
            ) : (
              <p className="text-sm text-[var(--text)]">Rooms is where your family's messages are.</p>
            )}
            {porchOn && (
              <button
                type="button"
                onClick={() => void finish("/porch/")}
                disabled={busy !== null}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)] disabled:opacity-60"
              >
                <img src="/item-icons/porch-192.png" alt="" className="h-9 w-9 rounded-xl" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--text)]">See what's on Porch</span>
                  <span className="block text-xs text-[var(--text-muted)]">Photos and news from your family.</span>
                </span>
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
