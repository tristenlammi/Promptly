import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, GripVertical, Loader2, Minus, Pencil, Pin, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { extractError } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { rememberLaunchedApp } from "@/lib/appLaunch";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { itemsApi, type LauncherApp } from "./api";
import { useBuiltInApps, useNavApps, type NavApp } from "./navApps";
import "./ui/items.css";

/**
 * ``/apps`` — the launcher: the apps this person added, as tiles they
 * arrange (drag in Edit, or long-press a tile on a phone). Tap a tile to
 * open the app; the last tile gets more apps. Each app's data lives in
 * ``My files/Apps/<App>``. In Edit, the pin on a tile puts that app in the
 * sidebar — so it can be used from Promptly without installing it — and the
 * list under the tiles sets their order there.
 */
export function AppsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["apps-launcher"], queryFn: itemsApi.launcher });
  const [order, setOrder] = useState<LauncherApp[]>([]);
  const [editing, setEditing] = useState(false);
  const nav = useNavApps();
  const builtIn = useBuiltInApps();
  const pinProps = (id: string) => ({ editing, pinned: nav.pinned.includes(id), onTogglePin: () => void nav.toggle(id) });

  useEffect(() => {
    if (data) setOrder(data);
  }, [data]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = order.findIndex((a) => a.kind === e.active.id);
    const to = order.findIndex((a) => a.kind === e.over!.id);
    const next = arrayMove(order, from, to);
    setOrder(next);
    void itemsApi
      .saveLauncher(next.map((a) => a.kind))
      .then(() => qc.invalidateQueries({ queryKey: ["apps-launcher"] }))
      .catch((err) => toast.error(extractError(err)));
  };

  const onSidebarDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = nav.apps.map((a) => a.id);
    void nav.reorder(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };

  const remove = async (app: LauncherApp) => {
    if (!window.confirm(`Remove ${app.name} from your apps? Its files stay in My files › Apps › ${app.name}.`)) return;
    try {
      await itemsApi.remove(app.kind);
      setOrder((o) => o.filter((a) => a.kind !== app.kind));
      void qc.invalidateQueries({ queryKey: ["installed-items"] });
      void qc.invalidateQueries({ queryKey: ["item-store"] });
    } catch (err) {
      toast.error(extractError(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopNav
        title="Apps"
        actions={
          <>
            <button
              type="button"
              onClick={() => navigate("/apps/install")}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)]"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Install apps</span>
              <span className="sm:hidden">Install</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing((v) => !v);
              }}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition",
                editing ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
              )}
            >
              {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
              {editing ? "Done" : "Edit"}
            </button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto" onClick={() => editing && setEditing(false)}>
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      {isLoading ? (
        <div className="flex justify-center py-20 text-[var(--text-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : order.length === 0 ? (
        <>
        <ul className="grid grid-cols-4 gap-x-2 gap-y-6 sm:grid-cols-5 md:grid-cols-6" aria-label="Built-in apps">
          {builtIn.map((app) => (
            <BuiltInTile key={app.id} name={app.name} blurb={app.blurb} icon={app.icon} onOpen={() => navigate(`${app.to}/`)} onLongPress={() => setEditing(true)} {...pinProps(app.id)} />
          ))}
        </ul>
        <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-[var(--border)] px-6 py-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[var(--accent)] text-white shadow-[var(--shadow-md)]">
            <Sparkles className="h-8 w-8" />
          </span>
          <div className="flex max-w-md flex-col gap-1">
            <p className="text-lg font-semibold text-[var(--text)]">Your apps live here</p>
            <p className="text-sm text-[var(--text-muted)]">
              Workout, Budget, Habits, Journal and more — free apps that keep everything in your Promptly, with an
              assistant built into each. Your chats can read them too.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/apps/store")}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" /> Get apps
          </button>
        </div>
        </>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order.map((a) => a.kind)} strategy={rectSortingStrategy}>
            <ul className="grid grid-cols-4 gap-x-2 gap-y-6 sm:grid-cols-5 md:grid-cols-6" aria-label="Your apps">
              {builtIn.map((app) => (
                <BuiltInTile key={app.id} name={app.name} blurb={app.blurb} icon={app.icon} onOpen={() => navigate(`${app.to}/`)} onLongPress={() => setEditing(true)} {...pinProps(app.id)} />
              ))}
              {order.map((app) => (
                <Tile
                  key={app.kind}
                  app={app}
                  onLongPress={() => setEditing(true)}
                  onOpen={() => navigate(`/apps/${app.kind}`)}
                  onRemove={() => void remove(app)}
                  {...pinProps(app.kind)}
                />
              ))}
              <li className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate("/apps/store");
                  }}
                  className="flex h-16 w-16 items-center justify-center rounded-[22px] border-2 border-dashed border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] md:h-[72px] md:w-[72px]"
                  aria-label="Get more apps"
                >
                  <Plus className="h-7 w-7" />
                </button>
                <span className="text-xs text-[var(--text-muted)]">Get apps</span>
              </li>
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {editing && (
        <>
          <p className="text-center text-xs text-[var(--text-muted)]">
            Drag to arrange · tap the pin to show an app in your sidebar · tap − to remove (its files stay in My files › Apps)
          </p>
          {nav.apps.length > 0 && (
            <section className="mx-auto w-full max-w-sm" aria-label="Sidebar order" onClick={(e) => e.stopPropagation()}>
              <h2 className="mb-2 text-xs font-semibold text-[var(--text-muted)]">In your sidebar</h2>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSidebarDragEnd}>
                <SortableContext items={nav.apps.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                  <ul className="flex flex-col gap-1">
                    {nav.apps.map((app) => (
                      <SidebarRow key={app.id} app={app} onRemove={() => void nav.toggle(app.id)} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </section>
          )}
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]" onClick={(e) => e.stopPropagation()}>
            <span>Sidebar icons</span>
            <div role="radiogroup" aria-label="Sidebar icons" className="inline-flex rounded-lg border border-[var(--border)] p-0.5">
              {(["line", "color"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={nav.iconStyle === s}
                  onClick={() => void nav.setIconStyle(s)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium transition",
                    nav.iconStyle === s ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:bg-[var(--hover)]",
                  )}
                >
                  {s === "line" ? "Simple" : "Colour"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
      </div>
    </div>
  );
}

interface PinProps {
  editing: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}

/** In Edit: one pinned app, dragged up or down to set its place in the sidebar. */
function SidebarRow({ app, onRemove }: { app: NavApp; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id });
  const Glyph = app.glyph;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface)]",
        isDragging && "relative z-10 shadow-[var(--shadow-md)]",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${app.name}`}
        className="flex min-h-11 min-w-0 flex-1 cursor-grab touch-manipulation items-center gap-2.5 rounded-xl px-3 text-left text-sm font-medium text-[var(--text)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <Glyph className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{app.name}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Take ${app.name} off the sidebar`}
        title="Remove from sidebar"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

/** In Edit: the corner button that adds an app to (or takes it off) the sidebar. */
function PinButton({ name, pinned, onTogglePin }: { name: string; pinned: boolean; onTogglePin: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onTogglePin();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={pinned}
      aria-label={pinned ? `Remove ${name} from the sidebar` : `Show ${name} in the sidebar`}
      title={pinned ? "In your sidebar — tap to remove" : "Show in sidebar"}
      className={cn(
        "absolute -top-1.5 right-1 flex h-6 w-6 items-center justify-center rounded-full shadow-[var(--shadow-md)] sm:right-2",
        pinned ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text)]",
      )}
    >
      <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
    </button>
  );
}

/** An app that's part of Promptly itself (not a file-backed item): always
 *  there, not arrangeable or removable — but it can be pinned. */
function BuiltInTile({
  name,
  blurb,
  icon,
  onOpen,
  onLongPress,
  editing,
  pinned,
  onTogglePin,
}: { name: string; blurb?: string; icon: string; onOpen: () => void; onLongPress: () => void } & PinProps) {
  return (
    <li className="relative flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!editing) onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onLongPress();
        }}
        aria-label={`Open ${name}`}
        className="relative rounded-[22px] shadow-[var(--shadow-sm)] transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
      >
        <img src={icon} alt="" className="h-16 w-16 select-none rounded-[22px] md:h-[72px] md:w-[72px]" draggable={false} />
      </button>
      <span className="flex w-full flex-col items-center px-1 text-center">
        <span className="w-full truncate text-xs font-medium text-[var(--text)]">{name}</span>
        {blurb && <span className="line-clamp-2 text-[11px] leading-tight text-[var(--text-muted)]">{blurb}</span>}
      </span>
      {editing && <PinButton name={name} pinned={pinned} onTogglePin={onTogglePin} />}
    </li>
  );
}

function Tile({
  app,
  editing,
  onOpen,
  onRemove,
  onLongPress,
  pinned,
  onTogglePin,
}: {
  app: LauncherApp;
  onOpen: () => void;
  onRemove: () => void;
  onLongPress: () => void;
} & PinProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.kind, disabled: !editing });
  const press = useRef<number | null>(null);
  const longPressed = useRef(false);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative flex flex-col items-center gap-2", isDragging && "z-10 opacity-80")}
      {...(editing ? attributes : {})}
      {...(editing ? listeners : {})}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          if (!editing) onOpen();
        }}
        onPointerDown={() => {
          if (editing) return;
          press.current = window.setTimeout(() => {
            longPressed.current = true;
            navigator.vibrate?.(15);
            onLongPress();
          }, 550);
        }}
        onPointerUp={() => press.current && window.clearTimeout(press.current)}
        onPointerLeave={() => press.current && window.clearTimeout(press.current)}
        onContextMenu={(e) => {
          e.preventDefault();
          onLongPress();
        }}
        aria-label={`Open ${app.name}`}
        className={cn(
          "relative rounded-[22px] shadow-[var(--shadow-sm)] transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
          editing && "animate-[appWiggle_0.3s_ease-in-out_infinite_alternate] cursor-grab",
        )}
      >
        <img src={`/item-icons/${app.kind}-192.png`} alt="" className="h-16 w-16 select-none rounded-[22px] md:h-[72px] md:w-[72px]" draggable={false} />
      </button>
      <span className="flex w-full flex-col items-center px-1 text-center">
        <span className="w-full truncate text-xs font-medium text-[var(--text)]">{app.name}</span>
        {/* Store taglines are a sentence: only where the tiles are wide. */}
        {app.tagline && (
          <span className="hidden w-full truncate text-[11px] leading-tight text-[var(--text-muted)] md:block" title={app.tagline}>
            {app.tagline}
          </span>
        )}
      </span>
      {editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${app.name}`}
          className="absolute -top-1.5 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] shadow-[var(--shadow-md)] sm:left-2"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      )}
      {editing && <PinButton name={app.name} pinned={pinned} onTogglePin={onTogglePin} />}
    </li>
  );
}

/** ``/apps/:kind`` — launching an app: open its most recent file (or a new one). */
/** ``/app/open/<kind>``: an app's fixed address for a home-screen icon (the
 *  Android app's launchers) — opens your copy of it as its own app, with no
 *  Promptly chrome, at ``/app/<file>/``. */
export function AppOpen() {
  const navigate = useNavigate();
  const kind = window.location.pathname.split("/")[3] ?? "";
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    itemsApi
      .openApp(kind)
      .then(({ file_id }) => {
        if (!live) return;
        // Launched from its home-screen icon: this window is that app.
        rememberLaunchedApp(`open:${kind}`, `app:${file_id}`);
        navigate(`/app/${file_id}/`, { replace: true });
      })
      .catch((err) => live && setFailed(extractError(err)));
    return () => {
      live = false;
    };
  }, [kind, navigate]);
  if (failed) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--bg)] px-6 text-center">
        <p className="text-sm text-[var(--text)]">{failed}</p>
        <a href="/apps" className="text-sm font-medium text-[var(--accent-text)] hover:underline">
          Open your apps in Promptly
        </a>
      </div>
    );
  }
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[var(--bg)] text-[var(--text-muted)]">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export function AppLaunch() {
  const navigate = useNavigate();
  const kind = window.location.pathname.split("/")[2] ?? "";
  useEffect(() => {
    let live = true;
    itemsApi
      .openApp(kind)
      .then(({ file_id }) => live && navigate(`/apps/${kind}/${file_id}${window.location.search}`, { replace: true }))
      .catch((err) => {
        toast.error(extractError(err));
        navigate("/apps", { replace: true });
      });
    return () => {
      live = false;
    };
  }, [kind, navigate]);
  return (
    <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
