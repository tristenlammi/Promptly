# Promptly — UI Polish & v1-Readiness Roadmap

> Created 2026-05-30. Tracks the UI/UX refinement pass toward a v1 release.
> Check items off as they land.

## North star

Cater to **non-power users first** — the default surface stays calm, obvious,
and finished — while keeping **every power feature reachable one tap deeper**
(hover / overflow / disclosure). Never add a permanently-visible control a
casual user won't touch. Anything provider-specific degrades gracefully.

Each phase ends with `tsc --noEmit` + `npm run build` + a Docker rebuild of the
frontend, plus a visual check at a phone width.

---

## Phase 0 — Shipped this session (groundwork)

- [x] Fixed ~8 undefined CSS design tokens (`--accent-hover`, `--surface-1/2`,
      `--surface-hover`, `--surface-muted`, `--bg-muted`, `--background`,
      `--muted`) in both themes — restored broken hover/text states across ~12
      components.
- [x] Collapsed assistant message actions to icon-only on mobile + moved
      Branch/Delete into a `⋯` overflow menu (`MessageActionOverflow`).
- [x] Shared `usePopoverFlip` hook; applied to RegenerateControl, the
      thumbs-down feedback note, and the overflow menu (no more off-screen
      clipping on the last reply).
- [x] Decluttered the composer: tucked Reasoning effort + Enhance behind a
      single **More** menu (`ComposerMoreMenu`). Bar now reads
      Attach · Web · Tools · Voice · More · Send.

---

## Phase 1 — Shared primitives *(foundation — de-risks everything after it)*

Build the reusable pieces later phases consume, so we stop hand-rolling
one-offs and keep the UI consistent.

- [x] **1.1 Toast system** — `toastStore` + `ToastViewport` (top-centre,
      auto-expiring, pause-on-hover, dismissable, capped stack) + imperative
      `toast.*` helpers; mounted once in `App.tsx`. Adopted in ChatPage
      (delete/compact errors+success), FilesPage (drop errors), TasksPage
      (delete). *(high · med)*
- [x] **1.2 Confirm dialog primitive** — promise-based `confirm()` + single
      `ConfirmHost`, built on the shared `Modal`/`Button`. Replaced native
      `window.confirm()` in 8 sites (Tasks, Compare ×2, ChatPage ×2, Provider,
      Memory, Custom/Local models). *(PdfEditorPanel's two unsaved-changes
      guards left native to avoid nesting traps inside its own modal.)* *(med · low)*
- [x] **1.3 Design-token migration** — added `--hover`/`--hover-strong` +
      `--danger`/`--warning`/`--success` (+ `-bg`/`-border` tints). Swept all
      59 adjacent `hover:bg-black/[…] dark:hover:bg-white/[…]` pairs across 39
      files onto `--hover`/`--hover-strong`; tokenised Button + Modal; migrated
      danger colours in touched files. *(Remaining: a handful of standalone
      `bg-black/[…]` badges + scattered raw red/amber in untouched components —
      low-risk follow-up.)* *(med · med)*
- [x] **1.4 Modal/popover a11y baseline** — `Modal` now traps Tab, restores
      focus to the trigger on close, and autofocuses the first control;
      new shared `usePopoverDismiss` hook consolidates the outside-click +
      Escape contract (pairs with `usePopoverFlip`). *(med · med)*

## Phase 2 — Consistent app shell ✅

- [x] **2.1 Shared `TopNav` on Tasks + Account** — retired the bespoke headers.
      Bonus: this restored the **mobile nav hamburger**, which those pages
      were missing entirely (AppLayout expects each page's TopNav to host it).
- [x] **2.2 Account settings nav** — section rail (sticky vertical on desktop,
      scrollable chip strip on mobile) with IntersectionObserver scroll-spy +
      smooth-scroll jump, over 7 grouped sections.
- [x] **2.3 Header / spacing / card audit** — also moved **TaskDetailPage** and
      **CompareArchivePage** onto `TopNav` (both were bespoke + missing the
      mobile hamburger); tokenised stray `text-green-500`/`text-red-500` and a
      missed hover pair. *(ComparePage's live multi-column surface keeps its
      own full-screen header by design.)*

## Phase 3 — Mobile structural fix + discoverability ✅

- [x] **3.1 Single-tree layout** — AppLayout now renders one tree for both form
      factors; only class names / a11y attrs differ across 768px, so the
      `<Outlet>` and `<Sidebar>` keep their tree position and **re-style rather
      than remount**. Chat scroll position + in-flight state survive rotation /
      window-resize. Bonus: the drawer now sizes to the sidebar's natural 288px
      instead of `85vw`, fixing the "drawer too wide in landscape" issue.
- [x] **3.2 Visible `⋯` on touch conversation rows** — touch rows show an
      always-visible ⋯ that opens the full action menu; **added Pin + Delete to
      that menu** (it previously only had Move/Export, so touch users couldn't
      pin or delete at all). Desktop keeps hover quick-actions + right-click.
- [x] **3.3 Secondary-page mobile pass** — TaskDetailPage's 224px run rail
      becomes a horizontal run-selector strip on mobile so the report gets full
      width; vertical rail stays on desktop.

## Phase 4 — First-impression polish ✅

- [x] **4.1 Skeleton loaders** — shared `Skeleton` primitive (pulse animation,
      reduced-motion-safe) used for the chat list (Sidebar), Files grid/list,
      and Tasks cards, replacing bare spinners / "Loading…" text.
- [x] **4.2 Context-aware empty states** — the chat empty state now greets with
      the project name + project-flavoured starters when inside a project,
      names the active model, and teaches capabilities (attach / web search)
      in its one-liner.
- [x] **4.3 Soften the truncation banner** — recoloured from alarming amber to
      a neutral surface tone; Continue is the accent action.

## Phase 5 — Power-user & accessibility finish ✅

- [x] **5.1 Keyboard nav + shortcut hints** — global `:focus-visible` accent
      ring (keyboard-only; components with their own ring keep precedence).
      SearchPalette already surfaces ↑↓/⏎/Esc hints; modals trap+restore focus
      (Phase 1.4).
- [x] **5.2 `aria-live` on streaming + SR pass** — a visually-hidden polite
      `StreamingAnnouncer` announces "responding…/response ready" without
      reading every token; streaming bubbles carry `aria-busy`.
- [x] **5.3 Reduced-motion + contrast audit** — confirmed the global
      `prefers-reduced-motion` block neutralises the new toast/skeleton
      animations; status tokens are background tints / icon colours with
      acceptable contrast.

---

## Sequencing logic

1. **Phase 1 first on purpose** — toasts, confirm, tokens, and the
   popover/modal wrapper are *building blocks*; Phases 2–4 reuse them instead
   of inventing new patterns.
2. The single highest-value individual item for "amazing mobile" is **3.1**,
   but it's safest after the Phase 1 primitives exist.
3. **Scope guard per item:** before adding any visible control, confirm a
   casual user needs it on the default surface; if not, it goes in an
   overflow/disclosure.
