# Changelog

All notable changes to Promptly are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How this works

- Work locally against the **[Unreleased]** section — add a line under the
  relevant heading (`Added` / `Changed` / `Fixed` / `Removed`) as you go.
- When a patch is tested and ready, cut a version: run
  `scripts/release.ps1 <version>` (Windows) or `scripts/release.sh <version>`
  (Linux/macOS). That bumps `VERSION` + `frontend/package.json`, stamps today's
  date onto a new release heading, and empties `[Unreleased]` again.
- Then rebuild, do a final local test, and commit/push as that version
  (optionally `git tag v<version>`).

The in-app version tag (bottom of the sidebar) reads the injected
`frontend/package.json` version, so it always reflects the built release.

## [Unreleased]

## [0.8.5] - 2026-08-31

### Changed
- **Picking a device now hides the arguments you no longer need.** Once
  you've chosen a device, the fields that only exist to say *which
  thing* — area, floor, domain, device class — fold away behind "target
  it another way", leaving a single line: "Targeting Kitchen Lamp".
  Arguments that are real parameters of the action, like brightness or
  volume, stay on screen, because no device picker can know what you
  meant by those.

### Fixed
- **Picking a device no longer leaves a contradictory target behind.**
  Choosing a device filled in its name but left any area or floor you'd
  already typed, so Home Assistant received two different ways to find
  the same thing and could only do as it was told. Picking a device now
  replaces the targeting rather than adding to it.

## [0.8.4] - 2026-08-31

### Fixed
- **The device list reads Home Assistant's real response.** HA returns
  its device list as a JSON object whose `result` field is a *string*
  containing the whole list — so every parser walked the JSON correctly
  and found nothing, because the devices aren't structure, they're text
  inside it. Embedded documents are now unwrapped and parsed. Found
  because the picker showed the raw response instead of claiming there
  were no devices, which is the only reason it took one look rather than
  a debugging session.

## [0.8.3] - 2026-08-31

### Added
- **Pick a device, then what to do to it.** Building a Home Assistant
  command no longer means knowing HA's intent vocabulary and typing an
  entity name by hand. Choose the connector and your devices are listed —
  "Kitchen Lamp — Lounge Room (light)" — and picking one offers the
  actions that make sense for it in plain English: Turn on, Turn off, Set
  brightness. Choosing an action fills in the tool and the device for
  you. Home Assistant already publishes this through its own
  `GetLiveContext`, so nothing extra needs enabling.
  - The actions offered are filtered against the intents your Home
    Assistant actually publishes, so the list can never offer something
    that would fail — and it stays a shortcut over the tool picker, not a
    replacement. An unusual device, a connector with no device list, or
    an action we haven't mapped all fall back to choosing the tool by
    hand.
  - If the device list can't be read, it says so and shows what came
    back, because "no devices exposed" and "unreadable response" look
    identical from the outside and need opposite fixes.

## [0.8.2] - 2026-08-31

### Fixed
- **You can now say *which* device a command acts on.** Home Assistant
  exposes intents — `HassTurnOff` — rather than one tool per device, so
  the lamp is an *argument* to the tool, not something you pick from the
  tool list. The editor didn't ask for those arguments, which left you
  able to build a command that says "turn something off" without ever
  saying what. Choosing a tool now shows a field for each argument it
  declares, marks the required ones, and offers a dropdown where the tool
  gives a fixed set of choices. A phrase slot of the same name overrides
  the fixed value when spoken, so one command can cover every room.

## [0.8.1] - 2026-08-31

### Fixed
- **Paste the token, not "Bearer <token>".** Connectors that authenticate
  with an `Authorization` header now add the `Bearer` scheme for you —
  what you copy out of Home Assistant or GitHub is the token, and having
  to know you must type a word in front of it produced a 401 that reads
  exactly like a bad token. The field used to say `Bearer …`, which made
  the app the source of the confusion. A value you supply with its own
  scheme (`Basic …`, `Token …`) is still used as-is, and headers like
  `X-API-KEY` are never touched. It's applied when the request is sent
  rather than when you save, so a connector already saved with a bare
  token starts working without being re-entered.
- **Connector errors say what actually went wrong.** "Couldn't list
  tools: unhandled errors in a task group" was the app reporting the
  wrapper around the real error rather than the error. It now names the
  cause — `404 Not Found`, `401 Unauthorized`, `All connection attempts
  failed` — which is the difference between knowing it's the URL, the
  token, or the server, at the one moment that matters.

## [0.8.0] - 2026-08-31

### Added
- **Command library.** One place for the things you've taught
  Promptly to do, whether you type them or (later) say them out loud. A
  saved prompt and a voice command turn out to be the same object with
  different action types — a prompt inserts text, an automation runs a
  flow, a tool command calls a connector — so they now live in one table
  behind one matcher, rather than two features that would have drifted
  apart. Your existing saved prompts are copied in automatically and keep
  working exactly as they do today; the old table is left untouched so
  nothing is at risk. Find it under **Automations**, which now has
  three tabs: Prompts, Commands, and the Scheduled flows that were
  already there.
  - **The matcher refuses to guess.** Matching is exact after
    normalisation: case, punctuation, accents, and filler like "Promptly,
    please…" are all levelled, so one phrase covers how people actually
    talk — but there's no fuzzy matching, no edit distance, and no "did
    you mean". Two commands claiming the same phrase match *nothing*
    rather than the app picking one. This sits in front of things that
    turn off lights and eventually unlock doors, where being right 95% of
    the time means doing something nobody asked for one time in twenty.
  - **A command never grants new capability.** It's a shortcut to
    something you could already do, so it's checked against the *target*
    every time it runs — you own that automation, that connector is
    switched on — rather than being trusted from when it was created. A
    command whose automation was deleted says so instead of looking like
    it worked, and switching off a connector switches off every command
    that used it without anyone hunting them down.
- **`/` in chat now runs commands, not just inserts prompts.** The same
  menu holds both: a prompt inserts text you then edit, exactly as
  before, while a command *does something* — runs an automation, calls a
  connected tool. Action rows are marked, say what they'll do before you
  pick them, and confirm before anything happens, because the difference
  between the two is a paragraph appearing versus a garage door opening.
  A voice-only library would be invisible — you'd have to remember what
  you set up and phrase it exactly right — so the typed menu is what
  makes it discoverable, and it ships first.
- **Commands you run from a chat land in the transcript.** Running one
  from `/` now records it as an activity card in the thread — the same
  card the assistant's own tool calls use — so the chat shows what
  happened instead of a toast that vanishes. Failures are recorded too,
  with the reason: a command that silently did nothing is the worst
  outcome, because you can't tell whether it fired. Runs from the library
  still just report back, since there's no thread to write to.
- **Home Assistant is now a connector you can add.** Pick it from the
  preset list in Settings → Connectors, paste a Long-Lived Access Token,
  and its devices become tools Promptly can call — which is what makes
  "turn the garage lights off" possible as a command. No bespoke
  integration was needed: Home Assistant already ships an official MCP
  server. What was missing was the **SSE transport** — Promptly only
  spoke streamable-HTTP, and HA (like plenty of other real MCP servers)
  speaks SSE. Both are supported now, picked per connector, with
  streamable-HTTP staying the default so existing connectors are
  untouched. Home Assistant on a LAN address works as-is.
- **Voice runs commands now.** The hands-free voice mode checks your
  command library before it asks a model anything. Say a phrase you've
  saved and it just happens — and because Whisper, the matcher and the
  speech reply all run on your own machine, and the action is a call on
  your own network, a matched command never touches a cloud API at all.
  Only speech that matches nothing falls through to the model, which is
  where any real waiting happens. Failures are spoken, not swallowed:
  across the room you can't see a toast, and a voice turn that goes
  quiet is indistinguishable from one that didn't hear you.
- **Commands that change something ask first, automatically.** Connectors
  tell us which of their tools alter the world rather than just reading
  it, and Promptly now uses that: pick one for a command and "ask before
  running" switches itself on, with the tool marked in the list. You
  shouldn't have to know which of a hundred Home Assistant services is
  the one that opens a door. Turning it back off stays your call, and
  picking a harmless tool afterwards never quietly un-guards a command
  you deliberately guarded. The model still can't call those tools at
  all — a shortcut you wrote and said out loud is a different thing from
  a model deciding on its own.
- **Home Assistant voice satellites can run your commands.** Promptly
  now speaks the Wyoming protocol as an intent handler, so the wall-
  mounted boxes and ESP32 satellites people already own can reach your
  command library — no Promptly hardware, no satellite to install. Home
  Assistant keeps doing the part it's good at (wake word, microphones,
  audio); Promptly does the part only it can (your commands, your
  documents). **Off by default, and it must stay that way unless you've
  read why**: the Wyoming protocol carries no authentication, so anything
  that can reach the port can run the acting user's commands. Keep it on
  a trusted network. It only ever runs commands and never a chat turn,
  so an exposed port can't be used to read documents or spend tokens,
  and speech it doesn't recognise is handed back to Home Assistant
  rather than answered.
- **Commands with numbers in them work when spoken.** Speech-to-text
  writes numbers as digits — "channel four" comes back as "channel 4" —
  so a phrase you'd written in words matched when typed and silently
  never fired when said out loud, which looks like voice being broken
  rather than the phrase being wrong. Number words and digits are now
  levelled to one form on both sides, the same way case and punctuation
  already were.
- **Spoken replies own up to not knowing.** Voice already answered in a
  sentence or two with no markdown; four rules were missing, and each
  only started to matter once answers began coming from your own
  documents. It now says so plainly when something isn't in what it was
  given, rather than filling three seconds with a confident guess — in
  voice there's no screen to check an answer against, so a plausible
  invention costs far more than it does in text. It also stops reading
  citation markers, filenames, paths and ids aloud, and speaks numbers
  and times the way a person does rather than as digits and ISO dates.
- **"Ask before running this one" is now per command, off by default.**
  Every side-effecting command used to confirm, which is the wrong shape
  — a dialog on every light toggle just teaches people to dismiss
  dialogs, so the one that mattered gets dismissed too. Tick the box for
  the garage door and leave it off for the lights. The flag governs both
  the typed and spoken paths, so a command can't be the kind that asks
  in one place and not the other. Spoken confirmations are asked out
  loud (a dialog is no use across the room), and anything that isn't a
  clear "yes" cancels.
- **Pick a tool from a list, not a UUID from an API.** Building a
  tool-calling command used to mean typing `<connector-id>:<tool-name>`
  by hand, which meant digging a UUID out of an admin endpoint first.
  It's now two dropdowns — connector, then tool — with the tool's own
  description underneath and a manual Refresh, since catalogs change
  when an admin adds a connector, not while you're filling in a form.
  The list shows only what you could already call by asking in a chat,
  so building a shortcut never reaches further than you can.
- **The library warns you when two commands share a phrase.** Promptly
  refuses to act on an ambiguous phrase rather than guessing which you
  meant, so a duplicate is a command that silently never fires. Both are
  now flagged in the list, because from the outside a command that does
  nothing looks identical to a broken app.
- **Automations works on a phone.** The page was desktop-only because of
  its flow canvas, but Prompts and Commands are things you reach for on a
  phone. The gate moved down to the canvas itself — everything else,
  including runs and pause/resume, now works on mobile.
- **The assistant can write to your memory itself.** Two new tools —
  `remember` and `forget` — let the model save a durable fact the moment
  you state it, and correct or drop one that's no longer true. Until now
  memory could only be written by a post-turn extraction pass sitting
  behind a phrase-matching gate, and the model itself never touched the
  store. Memory work runs silently — no tool card, no "ran 1 tool call" —
  because it is plumbing, not work worth narrating. Everything saved is
  still listed and editable in Settings → Memory. Advertised only when you
  have both memory and the Tools switch on, and never when memory is off.
  **Self-managed mode keeps its promise**: the tools are available there
  so an explicit "remember that…" works, but the assistant is instructed
  not to save anything you merely mention — automatic capture stays
  exclusive to Auto.

- **Edit your memory by describing the change.** Settings → Memory takes a
  plain-English instruction — "forget everything about my old job at Acme",
  "change my name to Tris" — and shows exactly what it would add, rewrite
  and remove before anything happens. Editing one row at a time is fine
  for a typo and tedious across a store of two hundred. Nothing is written
  until you press Apply, and every id in the plan is re-checked against
  your own memories server-side rather than trusted from the browser.

### Removed
- **The separate saved-prompts store is gone.** Its rows moved into the
  command library in this same release and nothing has read the old table
  since, so the table and its endpoints have been removed. Rolling the
  migration back re-creates them and copies your prompts back, including
  any written after the switch.

### Changed
- **Deep research reads its sources in parallel.** Each research angle
  fetched its two full-page sources one after the other — up to ~25
  seconds of serial waiting per angle on slow or anti-bot-walled pages,
  gating the gap-check phase on the slowest chain. The reads within an
  angle now run concurrently.
- **The assistant can look up what it doesn't have in front of it.** Only
  a handful of your saved facts are injected into any given chat — the
  ones judged relevant to what you just said — but nothing told the model
  that, so "what do you know about me?" was answered confidently from a
  sample of ten out of a possible two hundred. The injected block now says
  how many facts it is a selection of, and a new `recall` tool searches
  the rest. Read-only, and silent like the other memory tools.
- **Saved facts say how they were learned, not just when.** Memory has
  always recorded whether you stated something outright or it was picked
  up from conversation, and the prompt threw that away — so a month-old
  inference arrived with exactly the same authority as something you
  typed, with nothing to break the tie when they disagreed. Each line now
  reads `(stated, Aug 2026)` or `(inferred, Aug 2026)`.
- **Pinned memories no longer crowd out relevant ones.** Pinned facts are
  injected into every chat unconditionally, and they were drawing from the
  same ten slots as relevance — so pinning ten facts silently switched
  semantic retrieval off entirely, and pinning twenty doubled the injected
  block on top of that. Nothing in the UI hinted that "always keep this in
  mind" had a cost. Half the slots are now reserved for relevance, and
  pinning is capped at 12 with an explanation when you hit it.
- **Memory eviction now discards the stalest fact, not the least-injected
  one.** At the 200-fact cap the victim was chosen by an injection
  counter — which is incremented *by* injection and rewarded *by* the
  retrieval ranking, so a fact that kept being injected kept being
  protected whether or not it ever helped, while a genuinely useful fact
  that only fires for a rare topic looked like the cheapest thing to throw
  away. Eviction now goes by least-recently-useful.

### Fixed
- **The assistant no longer gives up on a search because its query was
  "too long".** The search tools declared hard character caps
  (`web_search` 400, `deep_research` / `run_agents` 600) in their
  schemas, and the server rejected any call that exceeded them before
  the tool could run — so a model that pasted your whole question as
  the query got back "exceeds maxLength", told you it went over the
  limit, and often just stopped. Over-long queries and agent tasks are
  now trimmed at a word boundary and searched anyway. Brave's own
  400-character / 50-word API limit is also clamped at the adapter, so
  a long query can't error there either.
- **A broken search provider no longer slows down every search.** A
  provider that timed out or returned zero results (the signature of a
  rate-limited SearXNG) was still tried *first* on every search, so
  every search paid its full 10-second timeout before failover kicked
  in — deep research multiplied that by every angle. After two
  consecutive transient failures a provider is now demoted to the back
  of the failover chain for a few minutes: still available as a last
  resort, no longer a toll booth in front of the providers that work.
- **Searching or fetching a page no longer stalls other people's
  replies.** The SSRF guard resolved DNS synchronously on the event
  loop — on this deliberately single-worker backend, one slow lookup
  froze every open chat stream. Resolution now runs off-loop.
- **"Search: always" works with reasoning models.** The query
  distiller didn't strip `<think>` blocks, so a reasoning model's
  chain-of-thought could get sent to the search engine as the query.
- **The failover chain budgets OpenRouter search at its real cost.**
  OpenRouter's search is a chat completion with a 30s ceiling, but the
  chain budgeted it like a 10s API call and could start a request it
  couldn't afford to finish, turning a recoverable failover into a
  bare "timed out". Its completion is also capped at fewer tokens now
  — the citations arrive early, the essay after them was pure latency.
- **Opening a PDF preview no longer downloads the file and shows a blank
  page.** The preview handed the PDF to the browser's built-in plugin via
  an ``<iframe>``, and a browser that declines to render one inline —
  Chrome's "Download PDFs instead of automatically opening them" setting
  is the common case — *downloads it and leaves the frame empty*. So
  clicking a file to look at it silently dropped a copy in Downloads and
  showed a white rectangle, for a button the user never pressed;
  downloading is what the Download button is for. PDFs are now rendered
  by pdf.js onto a canvas, with page count, zoom and scroll: same result
  in every browser, no plugin involved. The same fix covers the chat
  attachment panel and shared-link pages (a guest had the least context
  for a file appearing in their Downloads). pdf.js is lazy-loaded and
  excluded from the offline precache, so it only downloads for people who
  open a PDF.
- **The assistant can't delete a fact you pinned.** Pinning is the one
  signal that a fact matters more than the rest, so removing it is a
  decision for the person who pinned it — `forget` now refuses and says
  so, rather than quietly dropping it.
- **The per-chat memory pause now applies to the assistant too.** Pausing
  capture stopped the post-turn extraction pass but not the `remember`
  tool, so the assistant could still write to memory in a chat whose
  toggle said capture was off. Self-managed mode and the per-chat pause
  now resolve to the same rule in one place, rather than each path
  deciding for itself. Pausing is a hard off: it refuses even an explicit
  "remember this", which Self-managed mode still honours.
- **Credentials are screened out of memory.** Anything shaped like an API
  key, token, private key, card number or SSN is refused on both write
  paths. Memory is replayed into every relevant future chat, so a secret
  saved once is a secret re-injected indefinitely — and with the assistant
  now able to write memory and read fetched pages in the same turn, "don't
  save secrets" being a prompt instruction alone was the weakest link.
- **Memory can be corrected now, not just added to.** The machinery to
  rewrite and delete stale facts already existed, but the gate deciding
  whether to run it recognised assertions and almost nothing else: "I use
  Vim" was captured while "I don't use Vim any more", "I've switched from
  Python to Go", "stop calling me Tris" and "actually, I no longer work
  there" all passed straight through. So memory accumulated confidently
  wrong facts and had no realistic way to retract them — worse than not
  remembering, since a stale fact is injected into every relevant turn as
  established background. `remember(replaces=…)` is now the direct route,
  and the gate itself recognises corrections, negations and changes of
  state in every language it already covered.

## [0.7.2] - 2026-08-10

### Fixed
- **"Keep" no longer discards the subchat it was asked to save.** The
  window closed and the transcript was purged *before* the promotion was
  sent, so a failed request looked exactly like success — while the chat
  stayed ephemeral and the sweeper deleted it within 24h. Everything else
  about a subchat is meant to be thrown away, which made this the one
  place a silent failure cost anything. It now promotes first and only
  closes on success, and reports the failure instead of logging it to a
  console nobody has open (as do Open and Reset).
- **Subchats can use tools again.** The panel sent no `tools_enabled`, and
  the backend defaults it off — so code execution, page fetching and image
  generation silently didn't work in a subchat while the composer one
  panel over had them. The hook's own documentation claimed the opposite.
- **Escape meant for something else no longer closes a subchat.** The
  handler listened on `document` and nothing in the composer stops
  propagation, so the Escape that dismisses the @-mention popover, the
  slash-command popover or a message action menu also discarded the
  subchat. It now only closes when the keystroke was aimed at the window.
- **A subchat reply is no longer lost when you switch chats mid-answer.**
  The panel is torn down on navigation and dropping the reader tells the
  backend nothing, so the reply finished and was saved while the panel
  never heard — you'd come back to your question with no answer, forever,
  with the answer sitting in the database. It now reattaches to a live
  stream on return, or picks up the finished reply if it landed while you
  were away.
- **A dead connection no longer wedges the subchat on "Thinking…".** The
  panel's SSE reader was copied from the main chat's without its stall
  watchdog, so a half-closed proxy left the composer unusable until the
  subchat was discarded. Same 75s budget as the main chat now.

## [0.7.1] - 2026-08-10

### Fixed
- **Stop actually stops the reply now.** The button only aborted the
  browser's `fetch`, and generation doesn't live on that connection — it
  runs as a background task filling an in-process buffer, which is what
  lets you navigate away mid-reply and reattach. So the model ran to
  completion, the tokens were billed, the *whole* answer was saved, and
  reloading the page produced the finished reply you thought you'd
  stopped (revisiting the chat could even resume it on screen). Stop now
  cancels the generation server-side and saves the text written up to
  that moment as a real message marked `[Stopped.]`, so the reply ends
  where you stopped it. The same fix covers the subchat panel — which
  additionally threw the partial text away — and voice-mode barge-in.
- **The composer no longer freezes after Stop.** Cancelling nulled the
  turn's abort handle, so the turn's own cleanup couldn't recognise
  itself and skipped tearing down the streaming state: `isStreaming`
  stayed true forever, leaving the Stop button showing and the send
  button unreachable until a reload.

## [0.7.0] - 2026-08-10

### Added
- **React artifacts render live.** A `jsx` / `tsx` code block now gets a
  Preview tab in the artifact panel: the component is transformed with
  Sucrase and mounted in the same sandboxed iframe posture as the HTML
  preview (`allow-scripts`, no `allow-same-origin`). React's runtime is
  inlined into the document rather than fetched, so it works under the
  strict CSP and on an install with no internet. Plain `javascript` /
  `typescript` blocks deliberately don't get the tab — most aren't
  components. Imports other than React can't be resolved without a
  bundler, so they're caught up front and named in a readable message
  instead of failing as `require is not defined` at runtime; a component
  that mounts itself with `createRoot` is left to do so. The preview is
  lazy-loaded and excluded from the service-worker precache (~350 kB,
  nearly all of it React), so nobody pays for it until they open one.
  The tool-aware system prompt now steers models to emit one
  self-contained component for React requests.

## [0.6.4] - 2026-08-09

### Changed
- **`echo` is no longer advertised to the model.** A Phase A1 smoke test
  was being sent to every user in the tools payload *and* the tool-aware
  system prompt on every Tools-on turn — the same hazard that got
  `attach_demo` retired, since a model with a no-op tool in scope will
  eventually "demonstrate" it instead of answering. It keeps a `debug`
  category so it stays dispatchable for tests and diagnostics but is
  never offered. Twelve real tools are advertised now.
- **The tools switch says what it does.** It was a bare "AI tools"
  checkbox in the composer's overflow menu with no tooltip and no
  description, so the only way to discover that Promptly can search the
  web, read pages, run Python, generate PDFs and images or fan out to
  research agents was to have it happen by accident. It now names them,
  and the Settings description does too instead of citing one example.

### Removed
- `ToolsToggle.tsx`, which nothing imported. It carried the original
  "Enable AI tools (echo, file generation, more coming)" copy, so the
  most misleading description of the tool system in the codebase was one
  no user could ever see — only the next developer.

## [0.6.3] - 2026-08-09

### Fixed
- **Web search and page fetching are no longer killed mid-recovery.** Both
  tools allowed 30 seconds for work that can legitimately take longer:
  search tries each provider in turn at 10s apiece, so the documented
  four-provider setup needs 40s, and `fetch_url` may spend 12s on the
  direct fetch before its Tavily and Ollama fallbacks (10s each) — the
  steps that exist specifically to rescue a page that blocks crawlers. In
  both cases the dispatcher cancelled the tool right as it was recovering
  and the model got a bare "timed out", losing the reason and the fact
  that the next provider might well have answered. Both budgets now cover
  the real worst case, and the search chain is given an internal deadline
  so it stops *before* starting a provider it can't finish and reports
  what it tried — including the last provider's actual error — instead of
  being cancelled with nothing to show.
- **"Your file doesn't exist" — when it did.** `code_interpreter` dropped
  input files it couldn't read without telling anyone, and the sandbox
  stopped at its 64 MB total-input ceiling by discarding that file *and
  every remaining one*. The script's `read_csv('sales.csv')` then raised
  FileNotFoundError, and the model reported the file was missing while
  the user's attachment chip sat visible in the thread — a missing file
  and a typo'd filename produce the identical traceback, so it had no way
  to tell them apart. The result now opens with what actually loaded and
  what didn't, each with a reason, and the size ceiling no longer
  disqualifies the small files queued behind a large one.
- **Truncated output is no longer presented as complete.** The sandbox
  already computed `stdout_truncated`/`stderr_truncated` and the tool
  discarded them, so a clipped `df.to_string()` reached the model looking
  like a finished table and it answered from a partial one. The
  truncation is now stated explicitly.
- **The AI can read a whole long page again.** `fetch_url` cut every page
  at 6,000 characters and there was no way to see past it: the tool took
  only a `url`, its description told the model the rest was unavailable,
  and calling again replayed the identical prefix from the turn's dedup
  cache. So "summarise this article" quietly answered from the first 15%
  of a long one, with nothing to suggest the answer was partial. Pages
  are now paginated rather than clipped — the truncation notice reports
  the character range shown and the exact `offset` to pass to continue,
  and the model has six fetches per turn to work through it. The
  discovered-links block is only attached to the first chunk (it's
  page-level, and repeating it burned the budget it exists to save), and
  the citation snippet still comes from the top of the page so a
  continuation doesn't retitle the source with mid-article text.

## [0.6.2] - 2026-08-09

### Fixed
- **Code in replies is no longer silently corrupted.** Inline citation
  markers were stripped with a regex run over the whole message, code
  blocks included — and array indexing is indistinguishable from a
  citation. `print(items[0])` rendered as `print(items)` and
  `matrix[1][2];` as `matrix;`. Because Copy strips too, users were
  pasting broken code with no sign anything had changed. Stripping now
  skips fenced blocks and inline code, and leaves Markdown link
  definitions (`[1]: https://…`) intact.
- **Research sub-agents no longer produce citations that point at the
  wrong pages.** Each agent numbered its own sources — and `web_search`
  restarts at `[1]` on every call — so those markers couldn't be mapped
  onto anything, yet the parent model was told to cite "from the merged
  list" and copied them verbatim. Clicking a citation landed on an
  unrelated source. The unresolvable markers are now removed from agent
  briefs and the merged sources are presented numbered once, correctly,
  for the parent to cite against.
- **Boards with custom columns work with the AI again.** The chat tools
  matched a column *id* against the column *name* the model reads from
  the board text, so on any board with custom columns "how many are in
  review?" answered **0 cards** as fact, and "mark the in-progress ones
  done" wrote a status no column owned — the card wasn't actually
  completed and the board put it in the *first* column, so work the user
  asked to finish moved to the backlog under a proposal marked
  "Applied". Both tools now resolve against the board's real column
  registry (by name, id, or alias) and say which columns exist when a
  name doesn't match.
- **A failed Deep Research run says so.** The card previously just
  vanished after 1–3 minutes of visible progress — no message, no
  reason, and any partially-written report discarded — even though the
  failure reason was recorded and simply never rendered. It now shows
  what went wrong and offers the partial report.
- **Tool failures explain themselves.** The backend writes useful
  messages ("this workspace has several boards — pass the board
  argument", "no label named X"), and the UI discarded them one layer
  before rendering, showing only "failed". The reason is now shown on
  the step.

## [0.6.1] - 2026-08-09

### Added
- Tests for the **multi-hop tool path** in chat — a tool is called, its
  result feeds the next model hop, and the final reply persists with the
  per-turn tool log the Tool Activity Card renders. The streaming tests
  added in 0.6.0 all ran with tools disabled, so this half was still
  uncovered. Also pins the property that no database connection is held
  across a tool call, so a future refactor can't quietly reintroduce one.

## [0.6.0] - 2026-08-09

### Added
- **The chat streaming path has tests.** It's the most critical code in
  the app and had none, because it genuinely needs a database and Redis to
  do anything and the suite had no harness for either. There is one now —
  a scratch database built by running the real Alembic chain (so a
  migration that doesn't apply cleanly fails the suite), plus row
  factories and a stubbed model provider. CI gained Postgres and Redis
  service containers to run it, and fails rather than skips if they're
  missing, so a broken service can't produce a green run that proved
  nothing.
- Four end-to-end tests over a real generation, two of which lock in fixes
  previously verified only by hand: the reply is streamed **and persisted**
  with token usage recorded, deleting a chat mid-reply still closes the
  stream cleanly and writes nothing, and — the important one — **no
  database connection is held during the model call**, which is what
  stopped concurrent replies from exhausting the pool and restarting the
  container. That last one is asserted by sampling pool occupancy at the
  moment the provider is called; it confirmed the generation holds zero
  connections while the model is working.

## [0.5.3] - 2026-08-09

### Fixed
- **A crashed worker no longer disables an automation forever.** A run
  moves `pending` → `running` → done, and only the worker moved it out of
  the first two states — so if the worker was killed mid-run (OOM,
  redeploy, `docker compose down`) the row stayed non-terminal
  permanently. That mattered because two things treat a non-terminal run
  as "still in flight": a task set to skip overlapping runs was then
  skipped on **every future tick** (logged once at INFO, so the
  automation just quietly stopped), and webhook triggers counted the
  orphan toward their queue cap and eventually returned a permanent 429.
  A sweeper now fails runs that have outlived any legitimate execution —
  90 minutes for `running`, comfortably past the worker's own 55-minute
  job timeout, and 30 for `pending` — with a message distinguishing "the
  worker died mid-run" from "the worker never picked it up", and a
  warning in the log because a reaped run means work was lost.

## [0.5.2] - 2026-08-09

### Changed
- **Opening a chat no longer downloads the whiteboard and spreadsheet
  editors.** The browser was preloading ~10.6 MB of JavaScript on every
  page load; it now preloads **3.2 MB**. Excalidraw (4.6 MB),
  Fortune-Sheet (2.7 MB) and React Flow (163 kB) are genuinely fetched on
  demand, verified on a cold load with the service worker cleared.
  Cause: DOMPurify and Vite's dynamic-import helper matched no chunking
  rule, so Rollup was free to place those shared modules inside the
  excalidraw chunk — which meant the entry had to statically import 4.6 MB
  of whiteboard editor just to sanitize a message, dragging the other
  editors along behind it. Both are now pinned to their own small chunks.

## [0.5.1] - 2026-08-09

### Changed
- **Pages now load on demand instead of all at once.** Every route was
  imported eagerly, so opening a chat first downloaded the admin console,
  the automations flow editor and the whole Drive surface — a 2.4 MB
  entry chunk to render a text box. Routes are code-split now and the
  entry is **1.2 MB, roughly half**. The heaviest pages became their own
  chunks (admin 222 KB, workspace detail 343 KB) fetched on first visit.
  Login, MFA and the chat page stay eager on purpose: they're the first
  screens you see, and splitting them would only add a spinner to the
  most common path. The pending state lives in the app layout, so
  navigation shows a spinner in the content area rather than blanking the
  sidebar. Uses the existing `lazyWithRetry`, so a redeploy under an open
  tab still recovers instead of failing on a stale chunk name.

## [0.5.0] - 2026-08-08

### Added
- **A Health tab in Admin → Console** showing what the app is actually
  doing right now: database-pool usage against its ceiling, replies in
  flight, background tasks, memory, request counts by status class, and
  p50/p95/p99 response times. Promptly had no metrics of any kind, which
  meant the recent resource-starvation fixes (a pooled connection held
  for a whole generation, large uploads blocking the event loop,
  background tasks being collected mid-flight) were all made blind —
  with no way to confirm a fix held or to spot the next one before users
  did. The pool bar is the one to watch: exhausting it also blocked the
  health check, which got the container restarted mid-reply.
- `GET /api/admin/metrics` (admin-only) backs the panel. Deliberately a
  plain JSON snapshot rather than a Prometheus endpoint — the operator
  here is an admin on a settings page, not an SRE with a scraper. Numbers
  are collected in-process, cost nothing (counters plus a fixed-size
  latency ring), and are fed from the timing the access log already
  computes, so there's no second middleware and no extra clock reads.

## [0.4.2] - 2026-08-08

### Fixed
- **Background work can no longer vanish before it runs.** Nine places
  fired off a task and discarded the handle, but the event loop keeps
  only a *weak* reference to tasks — so Python was free to collect them
  mid-flight. The affected work is all the kind whose disappearance is
  silent: push notifications and inbox rows, workspace-memory refresh,
  chat re-indexing, automation event fan-out, the Redis-unavailable
  fallback for task runs, stream-session eviction, and the write that
  persists captured errors (so the admin error log could drop exactly
  the errors that happen under load). All now go through a shared helper
  that holds a reference until completion **and logs failures** —
  previously a crash in one of these surfaced only as asyncio's "Task
  exception was never retrieved" during garbage collection, attributed
  to nothing in particular.

## [0.4.1] - 2026-08-08

### Fixed
- **Large file operations no longer freeze the whole backend.** Promptly
  runs a single uvicorn worker by design, so a synchronous write in an
  async handler stalls every user at once — no chat tokens, no SSE, not
  even the health check. Uploading a meeting recording (allowed up to
  100 MB) did exactly that, as did downloading a folder as a zip, which
  deflate-compresses up to 1 GB inline. Both now run off the event loop.
  Covered by tests that race a heartbeat against the write, so the
  regression is caught rather than remembered.

## [0.4.0] - 2026-08-08

### Added
- **First-run setup now connects a model provider.** The wizard gained a
  provider step (OpenRouter / Anthropic / OpenAI / local Ollama) right
  after account creation, so a fresh install can actually answer a
  message when setup finishes — previously it configured SMTP, CORS and
  MFA but never the model, and landed on a chat screen that couldn't
  reply. Skipping is still allowed but says plainly that chat won't work.
- A provider set via `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` in the environment is now **seeded automatically on
  first boot**, and the wizard detects it and skips the provider step.
- **An in-flight reply now survives a server restart.** Generation state
  lives only in process memory, so every restart — including a routine
  `docker compose up -d` — silently destroyed replies that were still
  being written: no message row, no billing entry, and the chat left
  showing a question with no answer and no error. Shutdown now persists
  whatever text has accumulated, marked inline as interrupted. Bounded by
  an 8s timeout so a slow save can't hang the shutdown, and covered by
  the first automated tests this path has ever had.
- **Continuous integration** (`.github/workflows/ci.yml`) — the repo's
  first automated gate. Runs the backend test suite, frontend lint, and
  the full production build (which is where PWA precache failures
  surface) on every push and pull request.
- **ESLint is now real.** A `lint` script had existed for a long time
  with no config and no eslint installed, so it could never run; there
  is now a flat config (typescript-eslint + react-hooks + jsx-a11y) that
  passes clean on errors. `npm run lint:strict` also fails on the ~233
  known warnings for burning that debt down.

### Fixed
- **A chat reply no longer holds a database connection for its whole
  generation.** The streaming path kept one pooled connection checked out
  as `idle in transaction` from the first prep query until the reply was
  persisted — across every tool hop and model round-trip. With
  `pool_size=10, max_overflow=20` that capped the instance at roughly 30
  concurrent replies, and once the pool drained even `/api/health`'s
  `SELECT 1` blocked, so the container was marked unhealthy and restarted,
  killing every in-flight stream. The connection is now returned to the
  pool around each model call and re-acquired on demand.
- Tool side-effects (a generated image or PDF, a workspace write) are now
  committed as they happen instead of sitting uncommitted in the reply's
  transaction, where they were rolled back and lost if the generation
  later failed.
- **The setup wizard ended after its first step.** Creating the admin
  account flipped auth status to "authenticated", which swapped the
  router to the signed-in branch — where `/setup` redirects to `/chat`.
  Every step after account creation was therefore unreachable, so no
  install ever got the chance to configure a public URL, an embedder, or
  SMTP. Status now flips when the wizard actually finishes.
- **Two conditional-React-hook bugs**, both caught by the new lint gate:
  `ResearchProgressCard` called `useMemo` after an early `return null`,
  and `WorkspaceDetailPage` called `useState`/`useCallback` after its
  `!id` guard. Either one throws "rendered fewer hooks than expected"
  and blanks the page if the component re-renders across that boundary
  instead of unmounting.
- The zero-provider chat screen is actionable instead of misleading: it
  no longer points at a "Models tab" that no longer exists, gives admins
  a button straight to the right settings tab, and tells non-admins to
  ask an administrator — previously they clicked "Configure a model" and
  were silently bounced back to the same broken screen.
- The backend test suite runs again. It had been broken since the Study
  feature was deleted — two test files still imported the removed
  `app.study` module, so `pytest` failed at collection and every test
  silently stopped running. Also repaired a stale test that patched
  `run_search` after the search-failover work moved callers onto
  `run_search_with_failover`.

### Changed
- The setup wizard's embedding step now says what it's actually asking
  for. It never used the words "embedding model" anywhere prominent, and
  its two tiles looked almost identical to the model-provider tiles a
  couple of steps earlier (both offered "Local (Ollama)"), so it read as
  picking the same thing twice. It now names the thing, explains that it
  powers search, states plainly that it is *not* the chat model, and
  confirms what was configured. The "API provider" tile — which sets up
  nothing and defers to the admin panel — says so.
- `scripts/release.ps1` works on Windows again. Its `[Unreleased]` regex
  didn't tolerate carriage returns, so with `core.autocrlf=true` (the
  Windows default, and this is the Windows-primary script) it refused to
  cut any release at all.
- Ollama Web Search admin hint rewritten to be honest about the free
  tier: it's small (unpublished; ~a dozen searches per cycle in
  practice), so the guidance is now "last in the chain / blocked-page
  rescue", not "great primary".

## [0.3.0] - 2026-07-23

### Added
- **Ollama Web Search** as a web-search provider: Ollama's hosted search
  API (free tier with a free ollama.com account, API key auth). Joins the
  admin-ordered failover chain like any other provider — a zero-cost,
  off-instance alternative to self-hosted SearXNG.
- `fetch_url` gained a second blocked-page rescue: when the direct crawl
  is 403'd/empty and Tavily Extract can't recover it (or isn't
  configured), Ollama's hosted `web_fetch` now takes a turn. The tool
  chip shows "via Ollama" / "via Tavily" for whichever fetcher saved the
  page.

## [0.2.1] - 2026-07-23

### Fixed
- Leaked tool-call markup (e.g. DeepSeek's `<|DSML|…>` blocks) no longer
  lingers on screen: the stream's `done` event now carries the persisted
  (sanitized) reply text and the client prefers it over its raw delta
  accumulation — so backend-side cleanup and synthesis-retry answers
  actually reach the bubble. The live streaming bubble also elides the
  markup client-side while tokens are still arriving.

## [0.2.0] - 2026-07-23

### Added
- Workspace **Discussions**: a new `discussion` item kind giving members a
  threaded place to talk inside a workspace — thread rail, chronological
  messages, composer (Enter to send, Shift+Enter for a newline), and delete
  on your own threads/messages. Available from the navigator's **New** menu.
- Discussions show each author's **profile picture** next to their messages,
  in the thread rail, and on the thread header (initials chip when no
  picture is set).
- Discussions are **realtime**: new threads, messages, and deletions push to
  every open pane over SSE (Redis pub/sub fan-out) instead of the old 6s
  poll. A dropped stream reconnects with backoff and a slow safety-net
  refetch keeps the pane honest.
- Discussions are **opt-in for AI context**: they're created excluded from the
  workspace RAG pool, and the pane says so until a member turns the ⚡ on.
- Discussion RAG indexing: turning a discussion's context toggle ON flattens
  its threads into a backing Markdown file in the workspace's `Discussions/`
  Drive folder and embeds it into the workspace pool (re-indexed on every
  post); turning it OFF purges the chunks and trashes the file.
- Mobile: start a **New chat** or **New discussion** directly from the
  workspace item list on a phone.

### Changed
- Mobile workspaces: **Discussions are now usable on a phone** — the pane
  collapses to a single column (thread list → tap → messages screen with a
  back button and a keyboard-safe composer pinned to the bottom).
- Mobile workspaces no longer lock the interactive kinds: **chats and
  discussions are now fully editable** on a phone (post messages, start
  threads); notes stay read-only and the heavier editors still defer to
  desktop. Stale "read-only" copy updated to match.

### Fixed
- Chat streaming is now fully scoped to its conversation: switching chats
  mid-reply shows the chat you clicked, **browsing back to the streaming
  chat restores its thread with the live reply still ticking**, and a reply
  finishing while you're elsewhere lands in its own chat (visible instantly
  on return, no refetch wait). Sending from the New-chat screen tags its
  turn correctly so another chat's stream can never bleed into it.
- A cancelled/superseded turn can no longer wipe the next turn's live
  streaming state (thinking bubble vanishing, replies popping in all at
  once, sent messages not appearing until the reply finished).
- Dead SSE connections can't freeze chat any more: the backend now sends a
  keepalive ping every 20s while the model is quiet, and the frontend
  aborts a stream after 75s of total silence (the reply keeps generating
  server-side and appears on revisit) instead of leaving the send button
  and chat switching stuck forever.

### Removed
- The **"New from template"** entry in the workspace navigator's New menu
  (and the now-unreachable note-template picker behind it).

## [0.1.0] - 2026-07-12

### Added
- Initial versioned baseline. Establishes the `0.1.0` starting point, the
  `VERSION` file, this changelog, the `scripts/release.*` bump helper, and the
  in-app version indicator in the sidebar footer.
