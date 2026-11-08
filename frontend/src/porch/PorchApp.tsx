import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Check, Home, Loader2, Newspaper, PenSquare, Plus, Search, UserRound, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { porchApi, type Bootstrap } from "@/api/porch";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ItemButton, List } from "@/items/ui";
import "@/items/ui/items.css";
import { cn } from "@/utils/cn";

import "./porch.css";
import { useGroupActions } from "./actions";
import { BOOTSTRAP_KEY, discoverKey } from "./cache";
import { NewGroupSheet } from "./components/GroupSheets";
import { GroupTile, PorchAvatar } from "./components/ui";
import { WelcomeSheet } from "./components/WelcomeSheet";
import { PorchContext, isStandalone } from "./context";
import { usePorchEvents } from "./live";
import { FeedPage } from "./pages/FeedPage";
import { GroupPage } from "./pages/GroupPage";
import { DiscoverRow, GroupsPage, InviteRow } from "./pages/GroupsPage";
import { EditPostPage, NewPostPage } from "./pages/NewPostPage";
import { PostPage } from "./pages/PostPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SCROLLER_ID } from "./scroll";
import { usePorchStore } from "./store";

type Route =
  | { page: "feed" }
  | { page: "groups" }
  | { page: "new" }
  | { page: "edit"; id: string }
  | { page: "post"; id: string }
  | { page: "group"; id: string }
  | { page: "user"; id: string }
  | { page: "unknown" };

const ID = "([0-9a-fA-F-]{36})";

function parse(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/porch";
  if (p === "/porch") return { page: "feed" };
  if (p === "/porch/groups") return { page: "groups" };
  if (p === "/porch/new") return { page: "new" };
  let m = new RegExp(`^/porch/p/${ID}$`).exec(p);
  if (m) return { page: "post", id: m[1] };
  m = new RegExp(`^/porch/p/${ID}/edit$`).exec(p);
  if (m) return { page: "edit", id: m[1] };
  m = new RegExp(`^/porch/g/${ID}$`).exec(p);
  if (m) return { page: "group", id: m[1] };
  m = new RegExp(`^/porch/u/${ID}$`).exec(p);
  if (m) return { page: "user", id: m[1] };
  return { page: "unknown" };
}

/**
 * ``/porch/*`` — Porch, Promptly's own social app: photos and news shared
 * through groups. Its own app on a phone and when installed (manifest scope
 * ``/porch/``); inside Promptly's layout in a desktop browser (``PorchGate``).
 */
export function PorchApp({ embedded = false }: { embedded?: boolean } = {}) {
  const location = useLocation();
  const isPhone = useIsMobile(767);
  const q = useQuery({
    queryKey: BOOTSTRAP_KEY,
    queryFn: porchApi.bootstrap,
    staleTime: 30_000,
    retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2,
  });
  const b = q.data;
  const off = isAxiosError(q.error) && q.error.response?.status === 404;
  usePorchEvents(!!b);

  // Porch's accent on the whole page (sheets render in a portal).
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.porch = "";
    root.dataset.itemApp = "";
    return () => {
      delete root.dataset.porch;
      delete root.dataset.itemApp;
    };
  }, []);

  const invites = b?.invites.length ?? 0;
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    document.title = invites ? `(${invites}) Porch` : "Porch";
  }, [invites]);

  // Each page opens at its top; the feed comes back where you left it.
  const route = parse(location.pathname);
  const key = route.page === "feed" ? "feed" : location.pathname;
  const scrolls = useRef(new Map<string, number>());
  const lastKey = useRef(key);
  useLayoutEffect(() => {
    const el = document.getElementById(SCROLLER_ID);
    if (!el || lastKey.current === key) return;
    scrolls.current.set(lastKey.current, el.scrollTop);
    lastKey.current = key;
    el.scrollTop = key === "feed" ? (scrolls.current.get("feed") ?? 0) : 0;
  }, [key]);

  if (location.pathname === "/porch") {
    return <Navigate replace to={{ pathname: "/porch/", search: location.search, hash: location.hash }} />;
  }
  if (route.page === "unknown") return <Navigate replace to="/porch/" />;

  const frame = (children: ReactNode) => (
    <div
      className={cn(
        "flex flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]",
        embedded ? "h-full min-h-0" : "h-[100dvh] pl-safe pr-safe pt-safe",
      )}
    >
      {children}
      {!embedded && (
        <>
          <InstallFromLink appName="Porch" iconSrc="/item-icons/porch-192.png" description="Share photos and news with your family and friends on this Promptly, as its own app." />
          <NetworkStatusToast />
        </>
      )}
    </div>
  );

  if (!b) {
    return frame(
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--text-muted)]">
        {q.isPending ? (
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading Porch" />
        ) : off ? (
          <>
            <span className="text-4xl" aria-hidden>
              🏡
            </span>
            <p className="max-w-sm text-base text-[var(--text)]">Porch isn't turned on for you. Ask the person who runs this Promptly.</p>
            {!embedded && (
              <Link to="/chat" className="font-medium text-[var(--accent-text)] hover:underline">
                Back to Promptly
              </Link>
            )}
          </>
        ) : (
          <>
            <p className="text-[var(--text)]">Couldn't reach Porch.</p>
            <ItemButton variant="secondary" onClick={() => void q.refetch()}>
              Try again
            </ItemButton>
          </>
        )}
      </div>,
    );
  }

  let page: ReactNode;
  switch (route.page) {
    case "feed":
      page = <FeedPage />;
      break;
    case "groups":
      page = <GroupsPage />;
      break;
    case "new":
      page = <NewPostPage key={location.search} />;
      break;
    case "edit":
      page = <EditPostPage key={route.id} postId={route.id} />;
      break;
    case "post":
      page = <PostPage key={route.id} postId={route.id} />;
      break;
    case "group":
      page = <GroupPage key={route.id} groupId={route.id} />;
      break;
    case "user":
      page = <ProfilePage key={route.id} userId={route.id} />;
      break;
  }

  // Inside Promptly's layout there's a <main> already.
  const Main = embedded ? "div" : "main";
  return (
    <PorchContext.Provider value={{ isPhone, embedded, b }}>
      {frame(
        isPhone ? (
          <>
            <Main id={SCROLLER_ID} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {page}
            </Main>
            {/* The composer is full screen on a phone. */}
            {route.page !== "new" && route.page !== "edit" && <BottomBar b={b} route={route} />}
          </>
        ) : (
          <div className="flex min-h-0 flex-1">
            <SideNav b={b} route={route} embedded={embedded} />
            <Main id={SCROLLER_ID} className="min-w-0 flex-1 overflow-y-auto">
              <div className="px-2 pt-2 lg:px-6">{page}</div>
            </Main>
            <RightPanel b={b} />
          </div>
        ),
      )}
      <WelcomeSheet />
      <GlobalSheets />
    </PorchContext.Provider>
  );
}

function GlobalSheets() {
  const open = usePorchStore((s) => s.newGroupOpen);
  const set = usePorchStore((s) => s.setNewGroupOpen);
  return <NewGroupSheet open={open} onClose={() => set(false)} />;
}

function Badge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--item-accent)] px-1 text-[11px] font-bold leading-none text-white", className)}>
      {n > 99 ? "99+" : n}
      <span className="sr-only">{n === 1 ? " invite" : " invites"}</span>
    </span>
  );
}

/** Phone: Feed · Groups · ＋ · Profile. */
function BottomBar({ b, route }: { b: Bootstrap; route: Route }) {
  const navigate = useNavigate();
  const tab = "relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]";
  const is = (on: boolean) => (on ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]");
  const me = route.page === "user" && route.id === b.me.id;
  return (
    <nav aria-label="Porch" className="flex shrink-0 items-end border-t border-[var(--border)] bg-[var(--surface)] pb-safe">
      <Link to="/porch/" aria-current={route.page === "feed" ? "page" : undefined} className={cn(tab, is(route.page === "feed"))}>
        <Newspaper className="h-5 w-5" aria-hidden />
        Feed
      </Link>
      <Link to="/porch/groups" aria-current={route.page === "groups" ? "page" : undefined} className={cn(tab, is(route.page === "groups" || route.page === "group"))}>
        <span className="relative">
          <Users className="h-5 w-5" aria-hidden />
          <Badge n={b.invites.length} className="absolute -right-3 -top-1.5" />
        </span>
        Groups
      </Link>
      <button type="button" onClick={() => navigate("/porch/new")} aria-label="New post" className={cn(tab, "text-[var(--text-muted)]")}>
        <span className="flex h-9 w-12 items-center justify-center rounded-xl bg-[var(--item-accent)] text-white">
          <Plus className="h-5 w-5" aria-hidden />
        </span>
      </button>
      <Link to={`/porch/u/${b.me.id}`} aria-current={me ? "page" : undefined} className={cn(tab, is(me))}>
        <PorchAvatar user={b.me} size={22} className={cn(me && "ring-2 ring-[var(--item-accent)]")} />
        Profile
      </Link>
    </nav>
  );
}

/** Desktop: Porch's own column — pages, your groups with their ticks, Find groups. */
function SideNav({ b, route, embedded }: { b: Bootstrap; route: Route; embedded: boolean }) {
  const navigate = useNavigate();
  const { setTicks } = useGroupActions();
  const item = (on: boolean) =>
    cn(
      "flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
      on ? "bg-[var(--hover-strong)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
    );
  const me = route.page === "user" && route.id === b.me.id;
  return (
    <nav aria-label="Porch" className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-2 px-2 pb-3 pt-1">
        <img src="/item-icons/porch-192.png" alt="" className="h-8 w-8 rounded-lg" />
        <span className="text-lg font-bold text-[var(--text)]">Porch</span>
      </div>
      <ItemButton variant="primary" icon={<PenSquare className="h-4 w-4" />} onClick={() => navigate("/porch/new")} className="mb-2">
        New post
      </ItemButton>
      <Link to="/porch/" aria-current={route.page === "feed" ? "page" : undefined} className={item(route.page === "feed")}>
        <Newspaper className="h-[18px] w-[18px]" aria-hidden /> Feed
      </Link>
      <Link to="/porch/groups" aria-current={route.page === "groups" ? "page" : undefined} className={item(route.page === "groups")}>
        <Users className="h-[18px] w-[18px]" aria-hidden /> Groups
        <Badge n={b.invites.length} className="ml-auto" />
      </Link>
      <Link to={`/porch/u/${b.me.id}`} aria-current={me ? "page" : undefined} className={item(me)}>
        <UserRound className="h-[18px] w-[18px]" aria-hidden /> Profile
      </Link>

      <div className="mt-4 flex items-center justify-between px-3 pb-1">
        <h2 id="porch-feed-groups" className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          <span className="hidden lg:inline">In your feed</span>
          <span className="lg:hidden">Your groups</span>
        </h2>
      </div>
      {/* On wide screens these ticks are the feed's group picker (the chips
          above the feed are for phones and tablets). */}
      <div role="group" aria-labelledby="porch-feed-groups">
      <ul className="flex flex-col">
        {b.groups.map((g) => {
          const here = route.page === "group" && route.id === g.id;
          return (
            <li key={g.id} className={cn("flex items-center rounded-xl", here && "bg-[var(--hover-strong)]")}>
              <button
                type="button"
                role="checkbox"
                aria-checked={!!g.in_feed}
                aria-label={`${g.name} in your feed`}
                onClick={() => setTicks({ [g.id]: !g.in_feed })}
                className="hidden h-10 w-9 shrink-0 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] lg:flex"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-[18px] w-[18px] items-center justify-center rounded border",
                    g.in_feed ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)] bg-[var(--surface)]",
                  )}
                >
                  {g.in_feed && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
              <Link
                to={`/porch/g/${g.id}`}
                aria-current={here ? "page" : undefined}
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl pl-3 pr-2 text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] lg:pl-0"
              >
                <GroupTile group={g} size={24} />
                <span className="truncate">{g.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      </div>
      <Link to="/porch/groups#find" className={item(false)}>
        <Search className="h-[18px] w-[18px]" aria-hidden /> Find groups
      </Link>
      {!embedded && !isStandalone() && (
        <Link to="/chat" className={cn(item(false), "mt-auto")}>
          <Home className="h-[18px] w-[18px]" aria-hidden /> Back to Promptly
        </Link>
      )}
    </nav>
  );
}

/** Desktop: invites waiting, groups to join, and New group. */
function RightPanel({ b }: { b: Bootstrap }) {
  const setNewGroup = usePorchStore((s) => s.setNewGroupOpen);
  const discover = useQuery({ queryKey: discoverKey(""), queryFn: () => porchApi.discover(""), staleTime: 60_000 });
  const toJoin = useMemo(() => (discover.data ?? []).slice(0, 3), [discover.data]);
  return (
    <aside aria-label="This week" className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-[var(--border)] p-4 xl:flex">
      {b.invites.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">Invites</h2>
          <List>
            {b.invites.map((g) => (
              <InviteRow key={g.id} g={g} />
            ))}
          </List>
        </section>
      )}
      {toJoin.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">Groups you can join</h2>
          <List>
            {toJoin.map((g) => (
              <DiscoverRow key={g.id} g={g} compact />
            ))}
          </List>
        </section>
      )}
      <section className="flex flex-col gap-2 rounded-2xl border border-dashed border-[var(--border)] p-4">
        <h2 className="text-sm font-semibold text-[var(--text)]">Start a group</h2>
        <p className="text-xs text-[var(--text-muted)]">Family, your mates, a hobby. Only the people in it see its posts.</p>
        <ItemButton variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setNewGroup(true)} className="w-fit">
          New group
        </ItemButton>
      </section>
    </aside>
  );
}
