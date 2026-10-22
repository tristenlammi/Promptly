import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FolderInput, MessageSquare, PawPrint, Search, Smartphone, Upload, UserRound } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { filesApi } from "@/api/files";
import { peopleApi } from "@/api/people";
import { photosApi } from "@/api/photos";
import { Button } from "@/components/shared/Button";
import { ReviewCard } from "@/pages/PeoplePage";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** "Set up Photos" (PH-7): bring your photos in, let Promptly understand
 *  them, say which one is you, name the people and pets it found — then
 *  ask. Every step can be skipped and done later from Photos. */

const STEPS = ["Bring them in", "Understand them", "Who's who", "Pets", "Ask"] as const;

export function PhotoSetupPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const finish = async (to: string) => {
    try {
      await photosApi.saveSettings({ setup_done: true });
      void qc.invalidateQueries({ queryKey: ["photos", "settings"] });
    } catch {
      /* the banner just shows again */
    }
    navigate(to);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <Link to="/files/photos" aria-label="Back to Photos" className="rounded p-1 hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="flex-1 text-base font-semibold text-[var(--text)]">Set up Photos</h1>
        <button type="button" className="text-xs text-[var(--text-muted)] hover:underline" onClick={() => void finish("/files/photos")}>
          Skip setup
        </button>
      </header>
      <ol aria-label="Steps" className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-4 py-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" aria-current={i === step ? "step" : undefined} onClick={() => setStep(i)}
              className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1",
                i === step ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}>
              <span className={cn("flex h-4 w-4 items-center justify-center rounded-full text-[10px]", i < step ? "bg-[var(--accent)] text-white" : "border border-current")}>
                {i < step ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {s}
            </button>
          </li>
        ))}
      </ol>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl">
          {step === 0 && <BringIn />}
          {step === 1 && <Understand />}
          {step === 2 && <WhosWho />}
          {step === 3 && <Pets />}
          {step === 4 && <Ask onGo={(to) => void finish(to)} />}
        </div>
      </div>
      <footer className="flex justify-between border-t border-[var(--border)] px-4 py-2.5">
        <Button size="sm" variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</Button>
        {step < STEPS.length - 1 ? (
          <Button size="sm" variant="primary" onClick={() => setStep((s) => s + 1)}>Next</Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void finish("/files/photos")}>Done</Button>
        )}
      </footer>
    </div>
  );
}

function Lead({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{children}</p>
    </div>
  );
}

function Choice({ icon: Icon, title, text, children }: { icon: typeof Upload; title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text)]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        <p className="text-xs text-[var(--text-muted)]">{text}</p>
      </div>
      {children}
    </div>
  );
}

function BringIn() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "buckets", "all"], queryFn: () => photosApi.buckets("all") });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    let n = 0;
    for (const [i, f] of Array.from(files).entries()) {
      setBusy(`${i + 1} of ${files.length}`);
      try {
        await filesApi.upload("mine", f, null, "camera");
        n += 1;
      } catch (e) {
        toast.error(`${f.name}: ${apiErrorMessage(e, "couldn't upload")}`);
      }
    }
    setBusy(null);
    void qc.invalidateQueries({ queryKey: ["photos"] });
    if (n) toast.success(`${n} uploaded into Photos.`);
  };
  const total = data?.total ?? 0;
  return (
    <>
      <Lead title="Bring your photos in">
        {total ? `You have ${total.toLocaleString()} ${total === 1 ? "photo or video" : "photos and videos"} so far. ` : ""}
        Everything stays an ordinary file in Files — in your Photos folder, by month.
      </Lead>
      <div className="space-y-2">
        <Choice icon={Upload} title="Upload from this device" text="Pick photos and videos from this computer or phone.">
          <input ref={input} type="file" multiple accept="image/*,video/*,.heic,.heif,.dng,.cr2,.nef,.arw" hidden onChange={(e) => void upload(e.target.files)} />
          <Button size="sm" variant="secondary" loading={!!busy} onClick={() => input.current?.click()}>
            {busy ? busy : "Upload"}
          </Button>
        </Choice>
        <Choice icon={FolderInput} title="Move in from Google Photos, Apple Photos or a folder"
          text="A Google Takeout, an Apple Photos export or a zipped folder — dates, places, albums and favourites come with it.">
          <Link to="/files/import" className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--hover)]">Import</Link>
        </Choice>
        <Choice icon={Smartphone} title="Back up your phone" text="the Photos folder over WebDAV with an app password — new photos arrive by themselves.">
          <Link to="/account/devices" className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--hover)]">How</Link>
        </Choice>
      </div>
    </>
  );
}

function Understand() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  const { data: progress } = useQuery({ queryKey: ["photos", "understanding"], queryFn: photosApi.understanding, refetchInterval: 5000 });
  const set = async (body: { faces?: boolean; captions?: boolean }) => {
    const before = qc.getQueryData(["photos", "settings"]);
    // Ticked at once; put back if the server says no.
    qc.setQueryData(["photos", "settings"], (old: object | undefined) => (old ? { ...old, ...body } : old));
    try {
      qc.setQueryData(["photos", "settings"], await photosApi.saveSettings(body));
      void qc.invalidateQueries({ queryKey: ["photos", "understanding"] });
    } catch (e) {
      qc.setQueryData(["photos", "settings"], before);
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    }
  };
  return (
    <>
      <Lead title="Let Promptly understand them">
        Places, what's in each photo, text in signs and screenshots, pets — worked out on this server, in the background.
        Two things are yours to switch on:
      </Lead>
      <div className="space-y-2">
        <label className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
          <input type="checkbox" className="mt-1" checked={!!settings?.faces} onChange={(e) => void set({ faces: e.target.checked })} aria-label="Find faces" />
          <span>
            <span className="block text-sm font-medium text-[var(--text)]">Find faces, so you can name people</span>
            <span className="block text-xs text-[var(--text-muted)]">
              Done here, never sent anywhere. Turning it off later deletes every face found.
            </span>
          </span>
        </label>
        {settings?.captions_model && (
          <label className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
            <input type="checkbox" className="mt-1" checked={!!settings.captions} onChange={(e) => void set({ captions: e.target.checked })} aria-label="Describe photos" />
            <span>
              <span className="block text-sm font-medium text-[var(--text)]">Describe each photo in words</span>
              <span className="block text-xs text-[var(--text-muted)]">
                By {settings.captions_model.label}{settings.captions_model.local ? " (on this server)" : " — your photos are sent to it"}. Makes search and chat answers sharper.
              </span>
            </span>
          </label>
        )}
      </div>
      {progress && progress.stages.length > 0 && (
        <div className="mt-4 space-y-1.5" aria-label="Progress">
          {progress.stages.map((s) => (
            <div key={s.stage} className="text-xs">
              <div className="flex justify-between text-[var(--text-muted)]">
                <span>{s.label}</span>
                <span className="tabular-nums">{s.done.toLocaleString()} / {s.total.toLocaleString()}</span>
              </div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[var(--hover)]">
                <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${s.total ? Math.round((100 * s.done) / s.total) : 100}%` }} />
              </div>
            </div>
          ))}
          <p className="pt-1 text-xs text-[var(--text-muted)]">You needn't wait — carry on; it keeps going.</p>
        </div>
      )}
    </>
  );
}

function WhosWho() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  const { data: review } = useQuery({ queryKey: ["people", "review"], queryFn: peopleApi.review, refetchInterval: 15_000 });
  const { data: people } = useQuery({ queryKey: ["people", "person", false], queryFn: () => peopleApi.list("person") });
  const me = (people ?? []).find((p) => p.me);
  const candidates = [...(people ?? []).filter((p) => p.cover)].slice(0, 12);
  const unnamed = (review ?? []).filter((r) => r.kind === "person").slice(0, 8);
  if (!settings?.faces) {
    return (
      <Lead title="Who's who">
        Face recognition is off, so there's nobody to name yet. Switch it on in the step before (or later in Photos settings) — the
        people it finds show here and in People.
      </Lead>
    );
  }
  return (
    <>
      <Lead title="Who's who">
        Name someone once and they're named in every photo — then "me and Sarah at the beach" just works. More appear as photos are
        looked at; finish any time in People.
      </Lead>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
        <UserRound className="h-4 w-4" /> Which one is you? {me && <span className="font-normal text-[var(--text-muted)]">— {me.name ?? "chosen"}</span>}
      </h3>
      {candidates.length ? (
        <ul aria-label="Which one is you?" className="mb-5 flex flex-wrap gap-2">
          {candidates.map((p) => (
            <li key={p.id}>
              <button type="button" aria-pressed={p.me} aria-label={p.name ?? "Unnamed person"}
                onClick={() => void peopleApi.update(p.id!, { me: true }).then(() => qc.invalidateQueries({ queryKey: ["people"] }))}
                className={cn("block overflow-hidden rounded-full ring-offset-2 ring-offset-[var(--bg)]", p.me && "ring-2 ring-[var(--accent)]")}>
                <img src={p.cover ?? undefined} alt="" className="h-14 w-14 object-cover" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-5 text-xs text-[var(--text-muted)]">Nobody yet — faces are still being found.</p>
      )}
      {unnamed.length > 0 && (
        <>
          <h3 className="mb-2 text-sm font-medium text-[var(--text)]">Who is this?</h3>
          <div role="region" aria-label="Who is this?" className="flex flex-wrap gap-3">
            {unnamed.map((r) => <ReviewCard key={r.id ?? r.species} entry={r} known={people ?? []} />)}
          </div>
        </>
      )}
    </>
  );
}

function Pets() {
  const { data: review } = useQuery({ queryKey: ["people", "review"], queryFn: peopleApi.review, refetchInterval: 15_000 });
  const { data: pets } = useQuery({ queryKey: ["people", "pet", false], queryFn: () => peopleApi.list("pet") });
  const unnamed = (review ?? []).filter((r) => r.kind === "pet").slice(0, 8);
  return (
    <>
      <Lead title="Your pets">
        Dogs, cats and other animals are found by themselves. Name each of yours once — "Max on the beach" then finds him, not every
        dog.
      </Lead>
      {(pets ?? []).filter((p) => p.name).length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <PawPrint className="h-3.5 w-3.5" /> Named: {(pets ?? []).filter((p) => p.name).map((p) => p.name).join(", ")}
        </p>
      )}
      {unnamed.length ? (
        <div role="region" aria-label="Name your pets" className="flex flex-wrap gap-3">
          {unnamed.map((r) => <ReviewCard key={r.id ?? r.species} entry={r} known={pets ?? []} />)}
        </div>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">No animals to name yet.</p>
      )}
    </>
  );
}

function Ask({ onGo }: { onGo: (to: string) => void }) {
  const { data: people } = useQuery({ queryKey: ["people", "person", false], queryFn: () => peopleApi.list("person") });
  const { data: pets } = useQuery({ queryKey: ["people", "pet", false], queryFn: () => peopleApi.list("pet") });
  const someone = (people ?? []).find((p) => p.name && !p.me)?.name;
  const pet = (pets ?? []).find((p) => p.name)?.name;
  const year = new Date().getFullYear() - 1;
  const tries = [
    someone && (people ?? []).some((p) => p.me) ? `me and ${someone}` : someone ? `${someone}` : null,
    pet ? `${pet} at the beach` : "dog on the beach",
    `photos from summer ${year}`,
    "a sign or a menu",
    "sunset",
  ].filter(Boolean) as string[];
  return (
    <>
      <Lead title="Ask your photos">
        Search the way you'd ask someone who'd seen them all — who, which pet, where, when and what's in it. Or ask in a chat with
        Tools on, and follow up.
      </Lead>
      <div className="flex flex-wrap gap-2">
        {tries.map((q) => (
          <button key={q} type="button" onClick={() => onGo(`/files/photos/search?q=${encodeURIComponent(q)}`)}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]">
            <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" /> {q}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => onGo("/chat")}
        className="mt-4 flex items-center gap-1.5 text-sm text-[var(--accent-text)] hover:underline">
        <MessageSquare className="h-4 w-4" /> Ask in a chat instead
      </button>
    </>
  );
}
