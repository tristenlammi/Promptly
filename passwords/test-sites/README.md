# Autofill test sites

A local corpus of 161 pages for testing the password manager's field classifier and filler
(134 positive, 27 negative). Each page reproduces a pattern seen on real sites, written from
scratch with invented brands. The pages were written without reference to the classifier, so
they are not fitted to it. Nothing here contacts the network.

## Running

```
node server.mjs                                 # 127.0.0.1:8101 and :8102
PW_SITES_PORTS=9101,9102 node server.mjs        # other ports
node validate.mjs                               # static manifest check, no browser
node smoke.mjs [id-prefix]                      # browser walk, uses e2e/'s Playwright
node gen/build.mjs                              # regenerate fixtures/ and manifest.json
```

`server.mjs` also exports `start(ports?)`, which resolves to `{ close, ports }`. The Host header
is not checked, so `a.localhost`, `b.localhost`, `other.localhost`, `localhost` and deeper names
such as `login.a.localhost` all reach it. `/` lists every fixture.

HTML responses have two tokens replaced so that frames follow a port override: `__PORT__` (the
port the request came in on) and `__OTHER_PORT__`. Open fixtures through the server, not from disk.

`fixtures/` and `manifest.json` are build output. Edit the modules in `gen/` and rebuild.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures/<id>.html` | One page per manifest entry |
| `fixtures/_frames/` | Documents loaded inside iframes; no manifest entry of their own |
| `fixtures/_steps/` | Later pages of real-navigation flows (`advance.goto` points here) |
| `fixtures/_data/` | JSON a late-rendering fixture fetches |
| `lib/` | React and Vue builds, see `lib/README.md` |
| `gen/` | The generator: `kit.mjs` holds shared chrome, one module per group of categories |

## Manifest

`manifest.json` is an array with one entry per fixture:

```json
{
  "id": "signin-classic-01",
  "category": "signin",
  "description": "what real-world pattern this is",
  "path": "/fixtures/signin-classic-01.html",
  "host": "a.localhost",
  "negative": false,
  "steps": [
    {
      "kind": "signin",
      "wait": "#selector",
      "expected": [
        { "selector": "#user", "role": "username", "frame": null }
      ],
      "honeypots": ["#hp"],
      "advance": { "click": "#next" }
    }
  ],
  "state": { "username": "username" }
}
```

- `host` is optional and defaults to `localhost`. `negative: true` means nothing on the page may
  ever be filled; `expected` is then empty and there is no `state` map.
- `kind` is one of `signin`, `email-first`, `password-next`, `signup`, `change-password`, `otp`,
  `card`, `identity`, `search`, `newsletter`, `none`.
- `wait` is a CSS selector in the top document. Wait for it before classifying. Fields inside a
  frame or a shadow root may need polling beyond that.
- `selector` is a CSS string, or an array `["#host", "#inner"]` meaning find `#host`, enter its
  shadow root, then find `#inner`. Longer arrays go through nested roots. A closed root is at
  `window.__closedRoots[hostSelector]`, keyed by the selector as written in the array.
- `frame` is `null` for the top document, or the array of iframe selectors from the top down.
- `honeypots` must stay untouched. They are selectors in the top document, and cover hidden traps,
  the fields of a hidden tab, and also the page's decoys: header search boxes, footer newsletter
  boxes, guest-checkout emails, and hidden inputs that carry a username.
- `advance` moves to the next step: `click` a selector, or `goto` a path on the same host. The
  page's own Next button does the same thing as `goto`, and its state survives either route.
- **`advance.frame`** is an addition to the original schema: when the button is inside an iframe,
  it gives the frame chain to click in. Only `iframe-09` uses it.
- `state` maps each role filled across the fixture to its key in `window.__fixture.state()`. The
  key is the role name, except that `otp-digit` boxes share the key `otp`, holding the joined digits.

## Reading state

Every page defines `window.__fixture.state()`, including negative pages, which return `{}`.

- Controlled patterns (React, Vue, Angular-style, Svelte-style, masks, components) report the
  app's own model, so a filled-looking box that the app never accepted shows up as empty.
- Plain uncontrolled pages report the live input value.
- Real-navigation flows keep values in `sessionStorage`, as a server session would. `state()` on a
  later page still reports earlier steps. Use one tab and one host.
- Iframe fixtures relay each edit to the parent with `postMessage`, so the top page's `state()` is
  async by one tick. Poll briefly rather than reading in the same task as the fill.
- Masked inputs store digits only (`otp-09`, `card-03`). Compare with non-alphanumerics stripped
  and case folded, which is what `smoke.mjs` does.

## Conventions worth knowing

- Role `username` includes an email used as the login, also on sign-up forms. Role `email` appears
  only when a separate username box exists alongside it.
- Email-first step 2 is `password-next` when the identifier has been removed, hidden, or made
  read-only, and expected lists the password alone. `email-first-02` keeps the email editable, so
  its step 2 is a full `signin` with both fields.
- Pages that open a modal, drawer or route on click have a first step of kind `none` with nothing
  expected. Pages with a CSS transition set a `data-settled` marker, and `wait` targets it, so a
  field is not read mid-animation.
- `otp-11` and `otp-12` are backup-code screens: category `otp`, kind `none`, `negative: true`.
- `iframe-02` (a.localhost in b.localhost) is **cross-site** to a browser: each `*.localhost` name
  is its own registrable domain, confirmed by `Sec-Fetch-Site: cross-site` in Chromium.
  `iframe-11` (login.a.localhost in a.localhost) is the truly same-site case.

## Coverage

| Category | Count | Notes |
| --- | --- | --- |
| `signin` | 17 | tables, no form, generated ids, wrapped and aria-labelledby labels, placeholder-only, icon-only, toggle, text-until-focus, WebForms single form |
| `email-first` | 6 | in place on one page |
| `multi-step` | 12 | 4 by real navigation, 4 with a code step, account chooser, hidden carrier fields |
| `modal` | 8 | dialog, popover, overlay on a timer, tabs, drawer, dropdown, portal |
| `shadow` | 9 | open, closed, nested, slotted, internal labels, form-associated, declarative |
| `iframe` | 11 | same-origin, other host, other port, nested, srcdoc, late, stepped, shadow inside |
| `framework` | 12 | 3 real React, 3 real Vue, 3 Angular-style, 3 Svelte-style |
| `otp` | 12 | 10 positive, 2 backup-code negatives |
| `signup` | 7 | |
| `change-password` | 7 | |
| `honeypot` | 5 | |
| `language` | 12 | es, fr, de, pt, it, nl, ja, zh, ko, ru, ar (rtl), hi |
| `late` | 7 | |
| `card` | 7 | includes hosted fields in cross-origin frames |
| `identity` | 4 | |
| `negative` | 25 | search, newsletter and everything else that must not trigger |

## What the checks cover

`validate.mjs` checks ids, paths, roles, kinds, frame shapes, step structure, category minimums,
that every page defines `__fixture`, and that no page references an external host or a real
company name from a short list.

`smoke.mjs` runs each fixture in Chromium through all its steps. It fails on a page error, a console
error, a failed or external request, a `wait` that never resolves, or an expected field that is
missing, hidden or disabled. It types test values with real key presses and leaves the field, then
checks `state()` agrees. `framework` fixtures also get a bare value set with no event, which must
leave the app state unchanged. It has only been run in Chromium.
