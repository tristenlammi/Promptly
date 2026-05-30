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

## Phase 2 — Consistent app shell

- [ ] **2.1 Shared `TopNav` on Tasks + Account** — retire the two bespoke
      headers. *(med · low)*
- [ ] **2.2 Account settings nav** — sticky section rail / tabs instead of a
      7-panel scroll. *(med · low-med)*
- [ ] **2.3 Header / spacing / card audit** — one card + section pattern
      across all pages. *(low-med · low)*

## Phase 3 — Mobile structural fix + discoverability *(the casual surface)*

- [ ] **3.1 Single-tree layout** — replace the 768px conditional remount with a
      CSS-driven sidebar/drawer; no scroll/state loss on rotate or
      window-drag. *(high · med-high)*
- [ ] **3.2 Visible `⋯` on touch conversation rows** — pin/rename/delete/export
      via the overflow pattern (no hidden long-press). *(med · low)*
- [ ] **3.3 Secondary-page mobile pass** — Task-detail run rail → bottom sheet,
      etc. *(med · med)*

## Phase 4 — First-impression polish *(the first 10 seconds)*

- [ ] **4.1 Skeleton loaders** — chat list, Files grid, Tasks cards (replace
      bare spinners). *(med · low-med)*
- [ ] **4.2 Context-aware empty states** — project name / recent topics + a
      one-line "what this does". *(med · low)*
- [ ] **4.3 Soften the truncation banner** — neutral, not alarming amber.
      *(low · low)*

## Phase 5 — Power-user & accessibility finish *(invisible to casuals)*

- [ ] **5.1 Keyboard nav + shortcut hints** — tab order in action rows,
      focusable popovers. *(low-med · med)*
- [ ] **5.2 `aria-live` on streaming + screen-reader pass** *(med · med)*
- [ ] **5.3 Reduced-motion + contrast audit** *(low · low)*

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
