// Runs in every page, in the isolated world. It finds fields and asks the background
// for nothing it doesn't need. Secrets arrive only at fill time, for fields it checked,
// and are never kept. Its DOM footprint is one empty host element, shown only when a
// person focuses a field, carrying nothing about whether the vault's locked.
import { capture, type Captured, looksFailed, requestVerdict } from "../../../frontend/src/passwords/core/autofill/capture";
import { analyzePage, type DomAdapter, type FillableElement, type FormInfo, isVisible } from "../../../frontend/src/passwords/core/autofill/classify";
import { fillField, fillFields, type FillValues } from "../../../frontend/src/passwords/core/autofill/fill";
import { checkAtClick, fieldIsClear, fieldIsFillable, type GuardState, inViewport, visibilityV2 } from "../../../frontend/src/passwords/core/autofill/guard";
import { applyRule, describeForm, selectorFor } from "../../../frontend/src/passwords/core/autofill/rules";
import type { SiteRule } from "../../../frontend/src/passwords/core/model";
import { ext, type PageReport, type ToContent } from "./rpc";

const w = window as unknown as { __promptlyContent?: boolean };
// A document with an opaque origin (a site's sandboxed uploads, say) isn't the site its
// address says, whatever location.href claims. It doesn't get this script's attention.
if (!w.__promptlyContent && self.origin !== "null") {
  w.__promptlyContent = true;
  main();
}

function isPassword(role: string): boolean {
  return role === "password" || role === "new-password" || role === "current-password";
}

/** IntersectionObserver v2, which only Chromium has. */
function ioSupported(): boolean {
  return typeof IntersectionObserverEntry !== "undefined" && "isVisible" in IntersectionObserverEntry.prototype;
}

function watchVisibility(el: Element, onReading: (visible: boolean) => void): IntersectionObserver {
  const io = new IntersectionObserver(
    (entries) => onReading((entries[entries.length - 1] as unknown as { isVisible: boolean }).isVisible),
    { threshold: [0, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  io.observe(el);
  return io;
}

/** One reading for an element, or undefined if the browser can't say. */
function readVisibility(el: Element): Promise<boolean | undefined> {
  // A tab in the background has nothing on screen to read. Its answer means nothing.
  if (!ioSupported() || document.visibilityState !== "visible") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // A frame in another process reads false until its parent's answer gets to it, so
    // false only counts if it's still false when the time's up.
    let reading: boolean | undefined;
    const timer = setTimeout(() => {
      io.disconnect();
      resolve(reading);
    }, 500);
    const io = watchVisibility(el, (visible) => {
      reading = visible;
      if (!visible) return;
      clearTimeout(timer);
      io.disconnect();
      resolve(true);
    });
  });
}

function main() {
  const dom: DomAdapter = {
    shadowRoot: (el) => {
      const c = chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } };
      try {
        const viaApi = c.dom?.openOrClosedShadowRoot?.(el);
        if (viaApi) return viaApi;
      } catch {
        /* no such root */
      }
      // Firefox: on the element itself, visible to content scripts only.
      const ff = (el as unknown as { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
      return ff ?? el.shadowRoot ?? null;
    },
  };

  let rule: SiteRule | null = null;
  let forms: FormInfo[] = [];
  let best: FormInfo | null = null;
  let lastAnalysis = 0;
  let analyses = 0;
  let lastCapture: Captured | null = null;
  let lookAgain: ReturnType<typeof setTimeout> | null = null;

  // Noticing a submit that has no submit event: the password box a person typed in, what
  // it held, and what background requests said since. Page memory only.
  let dirty: { form: FormInfo; snapshot: Captured } | null = null;
  let gone: { snapshot: Captured; at: number } | null = null;
  let submittedAt = 0;
  let submittedPerf = 0;
  let requestOkAt = 0;
  let requests: PerformanceObserver | null = null;

  // What a person typed in a box, or we put there. A capture only trusts a password box
  // still holding exactly that: a page can set a value and submit with no one involved.
  const vouched = new WeakMap<Element, string>();
  // "On click" mode has no inline menu. Off until the background says otherwise.
  let inlineMenu = false;

  const roleOf = (el: EventTarget | null) => forms.flatMap((f) => f.fields).find((f) => f.el === el);

  /** The boxes that could get a value right now. Off-screen ones may yet be scrolled to. */
  const showing = (f: FormInfo["fields"][number]) => fieldIsFillable(f.el).ok && (!inViewport(f.el) || fieldIsClear(f.el, dom.shadowRoot).ok);

  function analyze() {
    const page = analyzePage(document, dom);
    forms = page.forms;
    best = page.best;
    if (rule) {
      const taught = applyRule(document, rule);
      if (taught) {
        forms = [taught, ...forms];
        best = taught;
      } else if (rule.never) {
        forms = [];
        best = null;
      }
    }
    lastAnalysis = Date.now();
    analyses++;
    noticeFormGone();
  }

  /** ``strict`` is for a fill: only boxes that can be seen count, so a hidden one isn't
   *  even sent a value. It takes layout, so ordinary reports don't. */
  /** For a bug report: the page's structure, and what was decided about each box and why. No values. */
  function diagnose(): string {
    analyze();
    const about = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        name: el.getAttribute("name"),
        type: el.getAttribute("type"),
        size: [Math.round(r.width), Math.round(r.height)],
        tabindex: el.getAttribute("tabindex"),
        aria_hidden_above: !!el.closest('[aria-hidden="true"]'),
        visible: isVisible(el, dom),
        fillable: fieldIsFillable(el),
        on_screen: inViewport(el),
        clear: fieldIsClear(el, dom.shadowRoot),
        role: forms.flatMap((f) => f.fields).find((f) => f.el === el)?.role ?? null,
      };
    };
    return JSON.stringify(
      {
        structure: JSON.parse(describeForm(document, location.hostname)),
        decided: {
          frames: window.parent === window ? "top" : "framed",
          forms: forms.map((f) => ({ kind: f.kind, roles: f.fields.map((x) => x.role), has_submit: !!f.submit, submit_text: f.submit?.textContent?.trim().slice(0, 30) ?? null })),
          best: best?.kind ?? null,
          strict_field_count: report(true).fieldCount,
          boxes: [...document.querySelectorAll("input")].filter((i) => i.type !== "hidden" && i.type !== "checkbox").slice(0, 30).map(about),
          last_fill: lastFill,
        },
      },
      null,
      1,
    );
  }

  function report(strict = false): PageReport {
    const fields = strict ? (best?.fields ?? []).filter(showing) : best?.fields ?? [];
    return {
      url: location.href,
      origin: self.origin,
      kinds: forms.filter((f) => f.fields.length).map((f) => f.kind),
      roles: fields.map((f) => f.role),
      fieldCount: fields.length,
      top: window === window.top,
    };
  }

  // After an extension update or removal this frame is orphaned, and the call throws.
  const send = (m: unknown): Promise<unknown> => {
    try {
      return ext.runtime.sendMessage(m).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  function publish() {
    send({ t: "pageReport", report: report() });
  }

  // ---- A budgeted observer: SPAs add fields late, and some pages never stop changing. ----

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    const wait = analyses > 60 ? 4000 : analyses > 20 ? 1200 : 250;
    setTimeout(() => {
      pending = false;
      if (Date.now() - lastAnalysis < wait / 2) return schedule();
      analyze();
      publish();
      if (menuField && !menuField.isConnected) closeMenu();
    }, wait);
  };

  const hasField = (n: Node) => n.nodeType === 1 && ((n as Element).tagName === "INPUT" || !!(n as Element).querySelector?.("input,select,textarea"));

  const observer = new MutationObserver((records) => {
    if (pending) return;
    for (const r of records) {
      if (r.type === "attributes") {
        if (dirty || ["INPUT", "SELECT", "TEXTAREA", "FORM"].includes((r.target as Element).tagName)) return schedule();
        continue;
      }
      for (const n of r.addedNodes) {
        if (hasField(n) || (n as Element).shadowRoot) return schedule();
      }
      for (const n of r.removedNodes) {
        if (hasField(n)) return schedule();
      }
    }
  });

  function startObserving() {
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "style", "class", "hidden", "disabled"] });
  }

  // Routes that change with no field added or removed. schedule() is the same budget.
  // pushState can't be seen from here: the background tells us, from webNavigation.
  window.addEventListener("hashchange", schedule);
  window.addEventListener("popstate", schedule);

  async function hello() {
    const r = (await send({ t: "hello", url: location.href })) as { r?: { rule: SiteRule | null; pendingSave: boolean; submittedKind?: string; unlocked: boolean; inlineMenu: boolean } } | null;
    rule = r?.r?.rule ?? null;
    inlineMenu = !!r?.r?.inlineMenu;
    analyze();
    publish();
    if (r?.r?.pendingSave) arrived(r.r.submittedKind ?? "signin");
  }

  let arriving: ReturnType<typeof setTimeout> | null = null;

  /** A new page with a save waiting, from a submit on the page before. If that form's
   *  back, or there's an error, the login failed and the page reloaded. */
  function arrived(kind: string) {
    if (window !== window.top || arriving) return;
    arriving = setTimeout(() => {
      arriving = null;
      if (looksFailed(document, { kind: kind as FormInfo["kind"] }, dom)) send({ t: "submitFailed" });
      else showSaveBar();
    }, 600);
  }

  // ---- The inline menu ---------------------------------------------------------------

  let host: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let guard: GuardState | null = null;
  let tampered = false;
  let hostObserver: MutationObserver | null = null;
  let menuField: Element | null = null;
  let closedRoot: ShadowRoot | null = null;
  let io: IntersectionObserver | null = null;
  let ioReading: boolean | undefined;
  // Names this menu. Only the frame holding it speaks for the menu the click landed on.
  let menuToken: string | null = null;

  const newToken = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  function closeMenu() {
    hostObserver?.disconnect();
    hostObserver = null;
    io?.disconnect();
    io = null;
    ioReading = undefined;
    host?.remove();
    host = null;
    frame = null;
    guard = null;
    menuField = null;
    closedRoot = null;
    menuToken = null;
  }

  function openMenu(field: Element) {
    closeMenu();
    tampered = false;
    menuField = field;
    host = document.createElement("div");
    // No id, class or data attribute: nothing a script can read to learn about us.
    const shadow = host.attachShadow({ mode: "closed" });
    closedRoot = shadow;
    frame = document.createElement("iframe");
    menuToken = newToken();
    frame.src = `${ext.runtime.getURL("menu.html")}#${menuToken}`;
    frame.setAttribute("allow", "");
    frame.setAttribute("style", "all:initial;display:block;width:320px;height:240px;border:0;background:transparent;color-scheme:normal");
    shadow.appendChild(frame);
    const r = field.getBoundingClientRect();
    const top = Math.min(r.bottom + 4, window.innerHeight - 248);
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 328));
    host.setAttribute(
      "style",
      `all:initial;position:fixed;left:${left}px;top:${top}px;width:320px;height:240px;z-index:2147483647;display:block;opacity:1;border:0;padding:0;margin:0;overflow:hidden;inset:auto;background:transparent`,
    );
    // Style it again with inset so a page's popover rules can't move it.
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
    for (const [k, v] of [["opacity", "1"], ["visibility", "visible"], ["display", "block"], ["filter", "none"], ["clip-path", "none"], ["mask-image", "none"], ["transform", "none"], ["mix-blend-mode", "normal"], ["position", "fixed"], ["pointer-events", "auto"]]) {
      host.style.setProperty(k, v, "important");
    }
    host.setAttribute("popover", "manual");
    document.documentElement.appendChild(host);
    try {
      host.showPopover();
    } catch {
      /* older browsers: it's still last in the DOM at the top z-index */
    }
    const b = host.getBoundingClientRect();
    guard = { shownAt: performance.now(), rect: { left: b.left, top: b.top, width: b.width, height: b.height } };
    if (ioSupported()) {
      io = watchVisibility(host, (visible) => {
        ioReading = visible;
      });
    }
    hostObserver = new MutationObserver(() => {
      tampered = true;
    });
    hostObserver.observe(host, { attributes: true, attributeFilter: ["style", "class", "popover", "hidden"] });
    // Tampering with the document around it is checked at click time.
    new MutationObserver((_, obs) => {
      if (!host) return obs.disconnect();
      if (document.documentElement.lastElementChild !== host) tampered = true;
    }).observe(document.documentElement, { childList: true });
  }

  function onFocus(e: Event) {
    // A page can dispatch a focus event any time it likes.
    if (!e.isTrusted || !inlineMenu) return;
    const target = (e.composedPath()[0] ?? e.target) as Element;
    if (!target || !["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (Date.now() - lastAnalysis > 1500) analyze();
    const f = roleOf(target);
    if (!f || f.el !== target) return;
    if (host && menuField === target) return;
    // Only into visible fields a person could have chosen.
    if (!fieldIsFillable(target).ok) return;
    openMenu(target);
  }

  function onBlurOrEscape(e: Event) {
    if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
    if (e.type === "focusout") {
      const to = (e as FocusEvent).relatedTarget as Element | null;
      if (to && (to === host || host?.contains(to))) return;
      // Focus moved into our iframe, which isn't visible from here: wait and see.
      setTimeout(() => {
        const active = document.activeElement;
        if (active !== host && !roleOf(active)) closeMenu();
      }, 150);
      return;
    }
    closeMenu();
  }

  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("focusout", onBlurOrEscape, true);
  document.addEventListener("keydown", onBlurOrEscape, true);
  window.addEventListener("pagehide", closeMenu);

  // ---- Filling ----------------------------------------------------------------------

  /** The check for each box, right before its value goes in. A box off screen is scrolled
   *  to and looked at again, but only if it's near the box before it: a form's boxes sit
   *  together, and one 5000 px away from the rest isn't meant to be seen. */
  let lastFill: Record<string, unknown> | null = null;

  function readyToFill(): (el: Element) => boolean {
    let last: { x: number; y: number } | null = null;
    return (el) => {
      if (!fieldIsFillable(el).ok) return false;
      if (!inViewport(el)) {
        const r = el.getBoundingClientRect();
        const at = { x: r.left + window.scrollX, y: r.top + window.scrollY };
        if (last && (Math.abs(at.x - last.x) > window.innerWidth || Math.abs(at.y - last.y) > window.innerHeight)) return false;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        if (!inViewport(el)) return false;
      }
      if (!fieldIsClear(el, dom.shadowRoot).ok) return false;
      const r = el.getBoundingClientRect();
      last = { x: r.left + window.scrollX, y: r.top + window.scrollY };
      return true;
    };
  }

  async function doFill(values: FillValues, origin: string): Promise<{ filled: string[]; left: string[] }> {
    const out = await doFillInner(values, origin);
    lastFill = { at: new Date().toISOString(), asked: Object.keys(values), filled: out.filled, left: out.left, form: best?.kind ?? null, ...out.how };
    return { filled: out.filled, left: out.left };
  }

  async function doFillInner(values: FillValues, origin: string): Promise<{ filled: string[]; left: string[]; how?: Record<string, unknown> }> {
    // The frame may not hold what the background checked by now. Secrets stop here.
    if (self.origin !== origin || self.origin === "null") return { filled: [], left: [], how: { stopped: "origin" } };
    // First, since our own menu covers boxes below the one it opened on.
    closeMenu();
    analyze();
    const form = best;
    if (!form) return { filled: [], left: [], how: { stopped: "no form" } };
    // From inside a frame, a parent hiding the whole frame can't be seen by style. Where
    // the browser can say, it decides. A background tab can't, and then this adds nothing.
    if (window !== window.top && (await readVisibility(document.documentElement)) === false) return { filled: [], left: form.fields.map((f) => f.role) };
    // Only the boxes these values are for, and the page gets no box it can hide.
    const wanted = form.fields.filter((f) => values[f.role] !== undefined || (f.role === "otp-digit" && values.otp !== undefined) || (f.role === "email" && values.username !== undefined) || (f.role === "username" && values.email !== undefined));
    const results = await fillFields(wanted, values, (role) => {
      analyze();
      return (best?.fields.find((f) => f.role === role)?.el as FillableElement | undefined) ?? null;
    }, readyToFill());
    for (const r of results) if (r.ok) vouched.set(r.el, r.el.value);
    const filled = wanted.filter((f) => results.some((r) => r.el === f.el && r.ok)).map((f) => f.role);
    const left = wanted.filter((f) => results.some((r) => r.el === f.el && r.method === "skipped")).map((f) => f.role);
    if (filled.some(isPassword)) markDirty(form);
    return { filled, left, how: { wanted: wanted.map((f) => f.role), results: results.map((r) => ({ ok: r.ok, method: r.method })) } };
  }

  // ---- Noticing a submit --------------------------------------------------------------

  /** What a person put in these boxes, or we did. A password box holding anything else
   *  says nothing: the page may have written it. */
  function provenCapture(form: FormInfo): Captured | null {
    const c = capture(form, location);
    if (!c) return null;
    const proven = (f: FormInfo["fields"][number]) => vouched.get(f.el) === (f.el as HTMLInputElement).value;
    const boxes = form.fields.filter((f) => isPassword(f.role) && (f.el as HTMLInputElement).value);
    if (boxes.some((f) => !proven(f))) {
      c.password = undefined;
      c.newPassword = undefined;
    }
    if (!c.password && !c.newPassword) {
      // The username step, for the next page: only if someone really typed it.
      const box = form.fields.find((f) => (f.role === "username" || f.role === "email") && (f.el as HTMLInputElement).value);
      if (!box || !proven(box)) return null;
    }
    return c;
  }

  function grab(form0?: FormInfo, snapshot?: Captured) {
    if (!form0 && !snapshot && !best) analyze();
    const form = form0 ?? forms.find((f) => f.fields.some((x) => isPassword(x.role))) ?? best;
    if (!form && !snapshot) return;
    const c = snapshot ?? provenCapture(form!);
    if (!c || (!c.password && !c.newPassword)) {
      // Username on one page, password on the next. It may be a full navigation, so the
      // background keeps it for this tab. It never comes back here.
      if (c?.username) {
        lastCapture = c;
        send({ t: "capturedUser", username: c.username });
      }
      return;
    }
    if (!c.username && lastCapture?.username) c.username = lastCapture.username;
    lastCapture = c;
    submittedAt = Date.now();
    submittedPerf = performance.now();
    watchRequests();
    send({ t: "captured", capture: c });
    // SPAs: no navigation. Look again shortly, once however many events said "submit".
    lookIn(1800);
  }

  function lookIn(ms: number) {
    if (lookAgain) clearTimeout(lookAgain);
    lookAgain = setTimeout(() => {
      lookAgain = null;
      if (lastCapture) void checkPendingSave();
    }, ms);
  }

  function markDirty(form: FormInfo) {
    const snapshot = provenCapture(form);
    if (!snapshot?.password && !snapshot?.newPassword) return;
    dirty = { form, snapshot };
    watchRequests();
  }

  /** What the page's own requests came back with. Read from the page's performance
   *  timeline, here in the isolated world: nothing is patched and nothing runs in the
   *  page. Cross-origin requests without CORS report status 0, and say nothing. */
  function watchRequests() {
    if (requests || typeof PerformanceObserver === "undefined") return;
    try {
      requests = new PerformanceObserver((list) => onRequests(list.getEntries() as PerformanceResourceTiming[]));
      requests.observe({ type: "resource" });
    } catch {
      requests = null;
    }
  }

  function onRequests(entries: PerformanceResourceTiming[]) {
    for (const e of entries) {
      if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest") continue;
      const verdict = requestVerdict((e as unknown as { responseStatus?: number }).responseStatus ?? 0);
      const afterSubmit = submittedAt > 0 && e.startTime >= submittedPerf - 20;
      if (verdict === "failed" && afterSubmit) {
        // The server said no. Nobody should be asked to save a typo.
        if (lookAgain) clearTimeout(lookAgain);
        lookAgain = null;
        submittedAt = 0;
        lastCapture = null;
        send({ t: "submitFailed" });
        return;
      }
      if (verdict !== "ok") continue;
      requestOkAt = Date.now();
      if (gone && Date.now() - gone.at < 2000) {
        const { snapshot } = gone;
        gone = null;
        grab(undefined, snapshot);
      } else if (afterSubmit && lastCapture) {
        lookIn(400);
      }
    }
  }

  /** The form a person typed a password into has left the page, with no submit event we
   *  could see. That's a submit only if a request just succeeded, and no other password
   *  box took its place: closing a dialog or switching to a Register tab isn't one. */
  function noticeFormGone() {
    if (!dirty) return;
    const box = dirty.form.fields.find((f) => isPassword(f.role));
    if (box && box.el.isConnected && fieldIsFillable(box.el).ok) return;
    if (forms.some((f) => f.fields.some((x) => isPassword(x.role) && fieldIsFillable(x.el).ok))) return;
    const { snapshot } = dirty;
    dirty = null;
    if (requests) onRequests(requests.takeRecords() as PerformanceResourceTiming[]);
    if (submittedAt && Date.now() - submittedAt < 8000) {
      if (lastCapture) lookIn(150);
      return;
    }
    if (Date.now() - requestOkAt < 6000) grab(undefined, snapshot);
    else gone = { snapshot, at: Date.now() };
  }

  document.addEventListener(
    "input",
    (e) => {
      if (!e.isTrusted) return;
      const t = e.composedPath()[0] as Element;
      if (!t || !["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      vouched.set(t, (t as HTMLInputElement).value);
      let form = forms.find((f) => f.fields.some((x) => x.el === t));
      // Typing in a chat box or a document isn't a reason to read the whole page again.
      if (!form && (t as HTMLInputElement).type === "password" && Date.now() - lastAnalysis > 300) {
        analyze();
        form = forms.find((f) => f.fields.some((x) => x.el === t));
      }
      if (dirty?.form.fields.some((x) => x.el === t)) markDirty(dirty.form);
      else if (form?.fields.some((x) => x.el === t && isPassword(x.role))) markDirty(form);
    },
    true,
  );

  function onClickCapture(e: Event) {
    if (!e.isTrusted) return;
    const t = (e.composedPath()[0] ?? e.target) as Element;
    if (!t?.closest) return;
    const button = t.closest("button,input[type=submit],input[type=button],[role=button]");
    if (button && forms.some((f) => f.submit === button || f.container?.contains(button))) grab();
  }

  document.addEventListener("submit", (e) => e.isTrusted && grab(), true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted && e.key === "Enter" && roleOf(e.composedPath()[0])) grab();
    },
    true,
  );

  let saveHost: HTMLElement | null = null;
  let saveToken: string | null = null;

  async function checkPendingSave() {
    if (window !== window.top) return;
    if (lastCapture && looksFailed(document, lastCapture, dom)) {
      send({ t: "submitFailed" });
      lastCapture = null;
      return;
    }
    const r = (await send({ t: "hello", url: location.href })) as { r?: { pendingSave: boolean } } | null;
    if (r?.r?.pendingSave) showSaveBar();
  }

  function hideSaveBar() {
    saveHost?.remove();
    saveHost = null;
    saveToken = null;
  }

  function showSaveBar() {
    if (saveHost) return;
    requests?.disconnect();
    requests = null;
    saveHost = document.createElement("div");
    const shadow = saveHost.attachShadow({ mode: "closed" });
    const f = document.createElement("iframe");
    saveToken = newToken();
    f.src = `${ext.runtime.getURL("save.html")}#${saveToken}`;
    f.setAttribute("style", "all:initial;display:block;width:360px;height:150px;border:0;color-scheme:normal");
    shadow.appendChild(f);
    saveHost.setAttribute("style", "all:initial;position:fixed;top:12px;right:12px;width:360px;height:150px;z-index:2147483647;display:block;inset:12px 12px auto auto;border:0;padding:0;margin:0;overflow:hidden;background:transparent");
    // As for the menu: a page's stylesheet can't reach past these.
    for (const [k, v] of [["opacity", "1"], ["visibility", "visible"], ["display", "block"], ["filter", "none"], ["clip-path", "none"], ["mask-image", "none"], ["transform", "none"], ["mix-blend-mode", "normal"], ["position", "fixed"], ["pointer-events", "auto"], ["top", "12px"], ["right", "12px"]]) {
      saveHost.style.setProperty(k, v, "important");
    }
    saveHost.setAttribute("popover", "manual");
    document.documentElement.appendChild(saveHost);
    try {
      saveHost.showPopover();
    } catch {
      /* it's still there at the top z-index */
    }
  }

  // ---- A short note on the page, with nothing a script could read ------------------------

  function notice(text: string) {
    if (window !== window.top) return;
    const note = document.createElement("div");
    const shadow = note.attachShadow({ mode: "closed" });
    const p = document.createElement("p");
    p.textContent = text;
    p.setAttribute("style", "margin:0;background:#1A1A19;color:#fff;font:13px system-ui,sans-serif;padding:8px 12px;border-radius:8px");
    shadow.appendChild(p);
    note.setAttribute("style", "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;display:block;pointer-events:none");
    // Not a popover and never after the menu, so it can't make the menu's own checks fail.
    if (host && host.parentNode === document.documentElement) document.documentElement.insertBefore(note, host);
    else document.documentElement.appendChild(note);
    setTimeout(() => note.remove(), 3500);
  }

  // ---- Passkeys: the bridge from the page's world. Every decision is made on this side. --

  const pkWaiting = new Map<number, boolean>();

  /** The frame's real Permissions-Policy, from this world. A browser with no way to ask
   *  gets the conservative answer: top-level or same-origin frames only. */
  function policyAllows(op: "get" | "create"): boolean {
    const feature = op === "get" ? "publickey-credentials-get" : "publickey-credentials-create";
    const policy = (document as unknown as { featurePolicy?: { allowsFeature: (f: string) => boolean } }).featurePolicy;
    if (policy) return policy.allowsFeature(feature);
    if (window === window.top) return true;
    try {
      return window.top!.location.origin === location.origin;
    } catch {
      return false;
    }
  }

  /** Cross-origin means any ancestor differs, not just the top: A inside B inside A is. */
  function ancestry(): { crossOrigin: boolean; topOrigin?: string } {
    if (window === window.top) return { crossOrigin: false };
    let crossOrigin = false;
    for (let at: Window = window; at !== at.parent; at = at.parent) {
      try {
        if (at.parent.location.origin !== location.origin) crossOrigin = true;
      } catch {
        crossOrigin = true;
      }
    }
    const listed = location.ancestorOrigins;
    if (listed && [...listed].some((o) => o !== location.origin)) crossOrigin = true;
    let topOrigin: string | undefined;
    try {
      topOrigin = window.top!.location.origin;
    } catch {
      topOrigin = listed?.[listed.length - 1];
    }
    return { crossOrigin, topOrigin };
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as { __pk?: string; id?: number; op?: "get" | "create"; options?: unknown };
    if (d?.__pk === "cancel" && typeof d.id === "number") {
      pkWaiting.delete(d.id);
      return;
    }
    if (d?.__pk !== "req" || typeof d.id !== "number" || (d.op !== "get" && d.op !== "create") || typeof d.options !== "object") return;
    const reply = (r: Record<string, unknown>) => window.postMessage({ __pk: "res", id: d.id, ...r }, location.origin);
    // Tells the page's wrapper someone's here. Without this it goes to the browser's own.
    window.postMessage({ __pk: "ack", id: d.id }, location.origin);
    if (!policyAllows(d.op)) {
      // Fails closed here, before anything reaches the background.
      reply({ ok: false, name: "NotAllowedError", message: "The Permissions-Policy of this page doesn't allow it." });
      return;
    }
    // No person, no window of ours: a page could open as many as it liked. The browser
    // answers such a request by its own rules.
    if (!(navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive) {
      reply({ ok: false, native: true });
      return;
    }
    pkWaiting.set(d.id, true);
    const { crossOrigin, topOrigin } = ancestry();
    const r = (await send({ t: "pkRequest", op: d.op, options: d.options, crossOrigin, topOrigin })) as { ok: boolean; r?: Record<string, unknown> } | null;
    if (!pkWaiting.get(d.id)) return;
    pkWaiting.delete(d.id);
    reply(r?.r ?? { ok: false, native: true });
  });

  // ---- Teach it once --------------------------------------------------------------------

  function teach() {
    const steps: { key: keyof SiteRule; say: string }[] = [
      { key: "username", say: "Click the username box. Esc to skip." },
      { key: "password", say: "Click the password box. Esc to skip." },
      { key: "submit", say: "Click the sign-in button. Esc to skip." },
    ];
    const rule: SiteRule = { host: location.hostname };
    let i = 0;
    const tip = document.createElement("div");
    tip.setAttribute("style", "all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1A1A19;color:#fff;font:14px system-ui;padding:8px 12px;border-radius:8px");
    tip.textContent = steps[0].say;
    document.documentElement.appendChild(tip);
    const done = () => {
      document.removeEventListener("click", onPick, true);
      document.removeEventListener("keydown", onKey, true);
      tip.remove();
      if (rule.username || rule.password) send({ t: "teachResult", rule });
      rule_applied(rule);
    };
    const next = () => {
      i++;
      if (i >= steps.length) return done();
      tip.textContent = steps[i].say;
    };
    const onPick = (e: Event) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.composedPath()[0] as Element;
      (rule as unknown as Record<string, string>)[steps[i].key as string] = selectorFor(el);
      next();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") next();
    };
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function rule_applied(r: SiteRule) {
    rule = r;
    analyze();
    publish();
  }

  // ---- From the background ----------------------------------------------------------------

  ext.runtime.onMessage.addListener((msg: ToContent, sender, reply) => {
    if (sender.id !== ext.runtime.id) return false;
    switch (msg.t) {
      case "report":
        // A page mid-step has just swapped its boxes, and what gets sent depends on this.
        if (msg.fresh || Date.now() - lastAnalysis > 400) analyze();
        reply(report(!!msg.fresh));
        return false;
      case "doFill":
        doFill(msg.values, msg.origin).then(reply);
        return true;
      case "ownsMenu":
        reply(host && menuToken && msg.token === menuToken ? { origin: self.origin, url: location.href } : false);
        return false;
      case "ownsSave":
        reply(saveHost && saveToken && msg.token === saveToken ? { origin: self.origin, url: location.href } : false);
        return false;
      case "menuCheck": {
        if (!host || !guard || msg.token !== menuToken) {
          reply({ ok: false, reason: "no-menu" });
          return false;
        }
        const verdict = checkAtClick(host, guard, {
          isTrusted: true, // Checked in the menu frame, where the page can't reach.
          tampered,
          shadowContains: (el) => el === host || el === frame || (closedRoot?.contains(el) ?? false),
          visibleV2: visibilityV2(ioSupported(), ioReading),
        });
        reply(verdict);
        return false;
      }
      case "fillGenerated": {
        const form = forms.find((f) => f.fields.some((x) => x.role === "new-password")) ?? forms.find((f) => f.fields.some((x) => x.role === "password")) ?? best;
        const boxes = (form?.fields ?? []).filter((f) => ["new-password", "confirm-password", "password"].includes(f.role));
        (async () => {
          if (self.origin !== msg.origin) return reply(false);
          closeMenu();
          const ready = readyToFill();
          for (const b of boxes) {
            if (!ready(b.el)) continue;
            const r = await fillField(b.el as FillableElement, msg.password);
            if (r.ok) vouched.set(r.el, r.el.value);
          }
          if (form) markDirty(form);
          reply(true);
        })();
        return true;
      }
      case "openMenu": {
        if (!inlineMenu) {
          reply(false);
          return false;
        }
        const active = document.activeElement;
        analyze();
        const f = roleOf(active) ?? best?.fields[0];
        if (f) openMenu(f.el);
        reply(true);
        return false;
      }
      case "teachStart":
        teach();
        reply(true);
        return false;
      case "describeForm":
        reply(diagnose());
        return false;
      case "routeChanged":
        schedule();
        reply(true);
        return false;
      case "notice":
        notice(msg.text);
        reply(true);
        return false;
      case "checkFailed":
        reply(lastCapture ? looksFailed(document, lastCapture, dom) : false);
        return false;
      case "showSave":
        arrived(msg.kind);
        reply(true);
        return false;
      case "hideSave":
        hideSaveBar();
        reply(true);
        return false;
      default:
        return false;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startObserving();
      hello();
    });
  } else {
    startObserving();
    hello();
  }
}
