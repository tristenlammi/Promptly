/* Whiteboard exercise submit shim.
 *
 * Injected into every AI-authored exercise iframe via a
 * ``<script src="/exercise-shim.js">`` tag. It runs BEFORE any
 * model-authored scripts (first thing inside <head>) and guarantees a
 * working submit contract regardless of what the AI ships:
 *
 *   1. Parent -> iframe "please submit now" (REQUEST_SUBMIT) always
 *      routes to a single collect-and-post path.
 *   2. The iframe -> parent submit payload is always EXERCISE_SUBMIT,
 *      with a best-effort collector walking ``input / select /
 *      textarea`` if the page didn't define ``window.collectAnswers``.
 *   3. Any submit-looking button the model added despite the prompt
 *      instructions is hidden, because the host renders its own
 *      "Submit answers" bar below the whiteboard.
 *
 * Loaded by ``<script src="/exercise-shim.js">`` which the backend
 * injects into every exercise page before serving it from
 * ``/api/study/exercise-frame/<id>``. That path has a loosened CSP
 * (set in ``nginx.conf``) that allows inline scripts for the model's
 * own glue, but ``script-src 'self'`` still accepts this external
 * script because it's same-origin. Parent and iframe stay cross-origin
 * (the iframe carries ``sandbox="allow-scripts"`` without
 * ``allow-same-origin``, so it's on a unique null origin), which is
 * why we postMessage rather than touching ``window.parent`` directly.
 */
(function () {
  if (window.__promptlySubmitShim) return;
  window.__promptlySubmitShim = true;

  function log() {
    try {
      console.log.apply(
        console,
        ["[promptly shim]"].concat(Array.from(arguments))
      );
    } catch (e) {
      /* console missing — non-fatal */
    }
  }
  function err() {
    try {
      console.error.apply(
        console,
        ["[promptly shim]"].concat(Array.from(arguments))
      );
    } catch (e) {
      /* console missing — non-fatal */
    }
  }

  log("loaded");

  // Direct call into the parent postMessage. Sandboxed iframes without
  // ``allow-same-origin`` have a unique opaque origin, so cross-origin
  // Window protections apply: ``.bind`` / ``.apply`` / property
  // assignment on ``window.parent.postMessage`` all throw. Always call
  // ``window.parent.postMessage(data, '*')`` directly, wrapped in
  // try/catch.
  function postToParent(data) {
    try {
      window.parent.postMessage(data, "*");
      log("posted to parent", data && data.type);
      return true;
    } catch (e) {
      err("postMessage failed", e && e.message);
      return false;
    }
  }

  function defaultCollect() {
    var data = {};
    var nodes = document.querySelectorAll("input, select, textarea");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.name || el.id || el.getAttribute("data-q");
      if (!key) continue;
      if (el.type === "checkbox") {
        if (!Array.isArray(data[key])) data[key] = [];
        if (el.checked) data[key].push(el.value);
      } else if (el.type === "radio") {
        if (el.checked) data[key] = el.value;
      } else if (el.type === "button" || el.type === "submit") {
        continue;
      } else {
        data[key] = el.value;
      }
    }
    return data;
  }

  function fireSubmit() {
    log("fireSubmit called");
    var payload;
    try {
      payload =
        typeof window.collectAnswers === "function"
          ? window.collectAnswers()
          : defaultCollect();
    } catch (e) {
      err("collectAnswers threw", e && e.message);
      payload = { _error: String(e) };
    }
    if (payload === undefined || payload === null) payload = {};
    log("collected payload", payload);
    postToParent({ type: "EXERCISE_SUBMIT", payload: payload });
  }

  // Exposed so any in-iframe button the model shipped can reach us.
  // The button itself is hidden by ``hideInlineSubmits`` below, but
  // if the model inlined a JS call through to this handle we stay
  // compatible.
  window.__promptlySubmit = fireSubmit;

  // Parent -> iframe "please submit now" — the primary path driven by
  // the SubmitBar below the whiteboard.
  window.addEventListener("message", function (e) {
    if (!e || !e.data) return;
    log("received message", e.data && e.data.type);
    if (e.data.type === "REQUEST_SUBMIT") fireSubmit();
  });

  // The host page renders a single "Submit answers" pill below the
  // whiteboard. Any submit UI inside the iframe would be a second,
  // redundant button — hide it aggressively so students aren't
  // staring at two buttons and guessing which one is real.
  var HIDE_SELECTORS = [
    "button[type=submit]",
    "input[type=submit]",
    "[data-submit]",
    "#submitBtn",
    ".submit-btn",
    ".btn.submit",
    "button.btn",
  ];
  function matchesSubmitText(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "button") {
      return false;
    }
    var txt = (el.textContent || "").trim().toLowerCase();
    return (
      txt === "submit" ||
      txt === "submit answers" ||
      txt === "submit answer"
    );
  }
  function hideInlineSubmits(root) {
    try {
      var seen = new Set();
      HIDE_SELECTORS.forEach(function (sel) {
        var nodes = root.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) {
          seen.add(nodes[i]);
        }
      });
      var buttons = root.querySelectorAll("button");
      for (var j = 0; j < buttons.length; j++) {
        if (matchesSubmitText(buttons[j])) seen.add(buttons[j]);
      }
      seen.forEach(function (el) {
        el.setAttribute("data-promptly-hidden", "1");
        el.style.setProperty("display", "none", "important");
      });
    } catch (e) {
      /* no-op */
    }
  }
  function runHide() {
    hideInlineSubmits(document);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runHide);
  } else {
    runHide();
  }
  // Re-run once the AI's own scripts have had a chance to mount UI,
  // and then observe for late insertions. Disconnect after a few
  // seconds so we're not sitting on an active observer forever.
  setTimeout(runHide, 200);
  try {
    var mo = new MutationObserver(function () {
      runHide();
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setTimeout(function () {
      try {
        mo.disconnect();
      } catch (e) {
        /* no-op */
      }
    }, 5000);
  } catch (e) {
    /* older browsers — the timeout-based pass covers it */
  }
})();
