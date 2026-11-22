"""A deterministic stand-in for an OpenAI-compatible model server.

The end-to-end suite points an "E2E Mock" provider at this so chat flows
(send, stop, regenerate, attach) run the same way every time, cost
nothing, and never touch a real model. Standard library only — it runs
inside the backend image with ``--entrypoint python``.

Replies are driven by markers in the user's message:

    [slow]   stream ~40 words, 250 ms apart (time to press Stop)
    [fail]   stream a few words, then drop the connection
    [tool:NAME {json}]
             call tool NAME with those arguments (once — after the tool's
             result comes back, reply "Tool said: <first line>")
    (none)   "Echo #<n>: <text>" — <n> counts up, so a regenerated
             reply always differs from the one it replaces

Spoken turns (Talk, WP-T4) can't carry markers, so plain words do:

    "long story"       a long reply of real sentences (time to talk over it)
    "dentist" + tools  call calendar_add_event for "Dentist" next week at 9
    "timer" + tools    call set_timer for 10 minutes (the phone, WP-T5)
    "alarm" + tools    call set_alarm for 6:30 (held for a yes)
    "phone" + tools    call send_to_phone for the latest thing (Talk phase 2)
    "cosy" + tools     call home_control: the lounge lights at 20%, warm white (Home)
    "unlock" + tools   call home_control on the front door (it refuses: Home page only)
    "miles davis" + tools   call home_music: Miles Davis in the Lounge (Home, music by name)
    "play blue" + tools     call home_music for "Blue" (two albums have that name: it asks which)
    "joni" + tools          call home_music again with the Joni Mitchell album's uri
    "some jazz" + tools     call home_music with mix: a kind of music, no speaker said (it just plays)
    "just play music" + tools  call home_music with mix and nothing else
    "movie time" + tools    call home_automation: run the home's "movie time" automation
    "what automations" + tools  call home_automation with no name (it lists them)
    "pausecheck" + tools
             read something from outside (the person's files), then open
             example.com at an address they never wrote: the reply stops
             at an approval card (chat/holds.py)
    "plaincheck" + tools
             the same, but the address is made only of the message's own
             words (example.com/search?q=plaincheck): no card

Requests the backend makes on its own are recognised by their system
prompt: the chat titler gets "E2E chat", memory capture gets "[]", and
the vision relay gets a fixed caption. The editors' AI (WP-5.5) gets
well-formed answers: Sheet AI fill → "Cat <row>" per row, clean → each
text cell trimmed and Title Cased, build → a small budget with a SUM
formula, PDF → Doc → "# Converted" plus the text.

The Study app's teacher gets a small course about tides in the JSON shapes
it asks for; see the Study section below for how answers are marked.

``prompt_tokens`` is a size estimate of the request (characters / 4), and
``GET /last-request`` returns the last chat request body, so tests can
check what a turn actually sends.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = [
    {"id": "e2e-mock-chat", "name": "E2E Mock Chat", "context_length": 32000},
    {"id": "e2e-mock-vision", "name": "E2E Mock Vision", "context_length": 32000},
    {"id": "e2e-mock-tools", "name": "E2E Mock Tools", "context_length": 32000},
]
_counter = itertools.count(1)
_last_chat: dict = {}


def _prompt_tokens(body: dict) -> int:
    """Roughly what a real tokenizer would count for this request."""
    size = len(json.dumps(body.get("messages") or [])) + len(json.dumps(body.get("tools") or []))
    return max(1, size // 4)


def _text_of(content) -> tuple[str, int]:
    """Plain text of a message's content, and how many images it carries."""
    if isinstance(content, str):
        return content, 0
    text, images = [], 0
    for part in content or []:
        if part.get("type") == "text":
            text.append(part.get("text") or "")
        elif part.get("type") == "image_url":
            images += 1
    return "\n".join(text), images


_TOOL_RE = re.compile(r"\[tool:(\w+)(?:\s+(\{.*\}))?\]", re.S)

LONG_STORY = [
    "Once upon a time there was a lighthouse keeper who loved the sea.",
    "Every evening she climbed the winding stairs to light the lamp.",
    "The ships far out on the water would blink their lights in thanks.",
    "One winter a storm rolled in from the west and the waves grew tall.",
    "She kept the lamp burning all night while the wind howled outside.",
    "In the morning a small fishing boat came safely into the harbour.",
    "The fishermen walked up the hill to thank her with a basket of bread.",
    "She made a pot of tea and they told stories until the sun went down.",
    "After that, the village rang the harbour bell for her every new year.",
    "And the lighthouse keeper never once let the lamp go out again.",
]


_OUTSIDE_READS = (("list_my_files", "{}"), ("search_past_chats", '{"query": "pineapple"}'))


def _chain_for(body: dict) -> tuple[str, str] | None:
    """Two calls, one after the other: an outside read, then a page-open."""
    messages = body.get("messages") or []
    last_user_at = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    if last_user_at < 0:
        return None
    text = _text_of(messages[last_user_at].get("content"))[0]
    held, plain = "pausecheck" in text, "plaincheck" in text
    if not (held or plain):
        return None
    offered = {(t.get("function") or {}).get("name") for t in body.get("tools") or []}
    done = sum(1 for m in messages[last_user_at:] if m.get("role") == "tool")
    if done == 0:
        return next(((n, a) for n, a in _OUTSIDE_READS if n in offered), None)
    if done == 1 and "fetch_url" in offered:
        url = "https://example.com/search?q=plaincheck" if plain else "https://example.com/?ref=held-open"
        return "fetch_url", json.dumps({"url": url})
    return None


def _tool_call_for(body: dict) -> tuple[str, str] | None:
    """(name, arguments) when the turn asks for a tool and hasn't had its
    result yet."""
    messages = body.get("messages") or []
    chained = _chain_for(body)
    if chained is not None:
        return chained
    if messages and messages[-1].get("role") == "tool":
        return None
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    text = _text_of(last_user.get("content"))[0]
    m = _TOOL_RE.search(text)
    if not m:
        offered = {(t.get("function") or {}).get("name") for t in body.get("tools") or []}
        if re.search(r"dentist", text, re.I) and "calendar_add_event" in offered:
            day = time.strftime("%Y-%m-%d", time.localtime(time.time() + 7 * 86400))
            return "calendar_add_event", json.dumps({"title": "Dentist", "start": f"{day}T09:00"})
        # The phone's device actions (WP-T5): only offered when hello.caps lists them.
        if re.search(r"\btimer\b", text, re.I) and "set_timer" in offered:
            return "set_timer", json.dumps({"seconds": 600, "label": "Tea"})
        if re.search(r"\balarm\b", text, re.I) and "set_alarm" in offered:
            return "set_alarm", json.dumps({"hour": 6, "minute": 30})
        # Promptly Home: "make the lounge cosy" is one for the model (a plain
        # "lounge lights off" never gets here: app/home/quick.py).
        if re.search(r"\bcosy\b", text, re.I) and "home_control" in offered:
            return "home_control", json.dumps({"action": "set_light", "target": "Lounge", "brightness": 20, "colour": "warm white"})
        if re.search(r"\bunlock\b", text, re.I) and "home_control" in offered:
            return "home_control", json.dumps({"action": "turn_off", "target": "Front door"})
        # Music by name: one plain request, one that needs a question back, and the answer to it.
        if re.search(r"\bsome jazz\b", text, re.I) and "home_music" in offered:
            return "home_music", json.dumps({"query": "jazz", "mix": True})
        if re.search(r"\bjust play music\b", text, re.I) and "home_music" in offered:
            return "home_music", json.dumps({"mix": True})
        if re.search(r"\bmiles davis\b", text, re.I) and "home_music" in offered:
            return "home_music", json.dumps({"query": "Miles Davis", "target": "Lounge"})
        if re.search(r"\bplay blue\b", text, re.I) and "home_music" in offered:
            return "home_music", json.dumps({"query": "Blue", "target": "Lounge"})
        if re.search(r"\bjoni\b", text, re.I) and "home_music" in offered:
            return "home_music", json.dumps({"query": "Blue by Joni Mitchell", "uri": "tidal://album/300", "target": "Lounge"})
        # A home automation by its phrase, typed (said out loud, an exact
        # phrase never gets here: app/home/automations.py).
        if re.search(r"\bmovie time\b", text, re.I) and "home_automation" in offered:
            return "home_automation", json.dumps({"name": "movie time"})
        if re.search(r"\bwhat automations\b", text, re.I) and "home_automation" in offered:
            return "home_automation", json.dumps({})
        # Talk phase 2: "send that to my phone" (the latest thing it found).
        if re.search(r"\bphone\b", text, re.I) and "send_to_phone" in offered:
            return "send_to_phone", json.dumps({"item": 1})
        return None
    return m.group(1), m.group(2) or "{}"


def _editor_ai_reply(system: str, messages: list) -> str | None:
    prompt = next((_text_of(m.get("content"))[0] for m in reversed(messages) if m.get("role") == "user"), "")
    if system.startswith("You fill one column"):
        rows = []
        for line in prompt.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    rows.append(json.loads(line)["row"])
                except (ValueError, KeyError):
                    pass
        return json.dumps({"values": [{"row": r, "value": f"Cat {r}"} for r in rows]})
    if system.startswith("You clean a range"):
        grid = json.loads(prompt[prompt.index("\n[") + 1:]) if "\n[" in prompt else []
        return json.dumps({"cells": [[c.strip().title() if isinstance(c, str) else c for c in row] for row in grid]})
    if system.startswith("You design a spreadsheet"):
        return json.dumps({"title": "E2E budget", "columns": ["Item", "Cost"],
                           "rows": [["Rent", 900], ["Food", 300], ["Total", "=SUM(B2:B3)"]]})
    if system.startswith("You turn the extracted text of a document into clean Markdown"):
        return "# Converted\n\n" + prompt.strip()
    # Notes (N1.5): AI proposals on one note, read from between <note> tags.
    if system.startswith(("You tidy up a note", "You turn a note into a checklist", "You suggest a title for a note",
                          "You pick the to-dos in a note", "You make a calendar event from a note")):
        import datetime as _dt
        import re as _re

        inner = prompt.split("<note>", 1)[-1].split("</note>", 1)[0]
        lines = [ln.strip() for ln in inner.splitlines() if ln.strip() and not ln.startswith(("Title:", "Recorded and transcribed:"))]
        if system.startswith("You tidy up a note"):
            out = []
            for ln in lines:
                words = [w for w in ln.split() if w.lower().strip(",.") not in ("um", "uh", "like", "so")]
                s = " ".join(words).strip(" ,")
                if s:
                    out.append(s[0].upper() + s[1:] + ("" if s.endswith((".", "!", "?")) else "."))
            return json.dumps({"text": "\n\n".join(out)})
        if system.startswith("You turn a note into a checklist"):
            return json.dumps({"items": lines})
        if system.startswith("You suggest a title for a note"):
            return json.dumps({"title": "E2E title"})
        if system.startswith("You pick the to-dos in a note"):
            return json.dumps({"tasks": [{"title": ln.lstrip("[ ]x").strip(), "due": None, "time": None} for ln in lines]})
        today = _re.search(r"Today is \w+ (\d{4}-\d{2}-\d{2})", prompt)
        day = (_dt.date.fromisoformat(today.group(1)) if today else _dt.date.today()) + _dt.timedelta(days=1)
        return json.dumps({"title": "E2E event", "date": day.isoformat(), "start": "10:00", "end": "11:30", "all_day": False,
                           "location": "The workshop", "description": ""})
    if system.startswith("You draft a slide deck"):
        # Three slides, the last two citing the first source (Stage 12).
        import re

        first = re.search(r'<source id="(S\d+)" name="([^"]*)">', prompt)
        sid = first.group(1) if first else "S1"
        return json.dumps({"slides": [
            {"title": "E2E deck", "bullets": [], "notes": "Welcome.", "sources": []},
            {"title": "What the file says", "bullets": ["First point", "Second point"], "notes": "Walk through it.", "sources": [sid]},
            {"title": "Thanks", "bullets": ["Questions?"], "notes": "Close.", "sources": [sid]},
        ]})
    if system.startswith("You design forms"):
        # Make with AI (Forms WP-F1.7): two questions, whatever was asked.
        return json.dumps({"title": "E2E picnic", "description": "Who's coming and what they'll bring", "items": [
            {"kind": "multiple_choice", "title": "Are you coming?", "required": True, "options": ["Yes", "Maybe", "No"]},
            {"kind": "paragraph", "title": "Anything we should know?"},
        ]})
    if system.startswith("You suggest the options"):
        return json.dumps({"options": ["Small", "Medium", "Large"]})
    if system.startswith("You summarise the answers"):
        # One theme, quoting the newest answer exactly.
        import re

        m = re.search(r"\[#(\d+)\] (.+)", prompt)
        quotes = [{"number": int(m.group(1)), "text": m.group(2)[:60]}] if m else []
        return json.dumps({"themes": [{"title": "E2E theme", "count": len(re.findall(r"\[#\d+\]", prompt)),
                                       "summary": "What people said.", "quotes": quotes}]})
    return None


# ------------------------------------------------------------------ Study
# The Study app's teacher (backend/app/study/ai.py) asks for JSON in a stated
# shape. Which shape is being asked for is read from the prompt; the answers
# are a small course about tides, the same every time:
#
#   - every choice step has one right option: the text in STUDY_RIGHT
#   - a written answer is marked by its words: "pull" or GOOD correct, HALF
#     partial, "push" or MISC wrong with the same misconception each time
#     (twice on one concept adds a gap concept), anything else wrong
#   - the confused student is put right by a reply with "pull" or GOOD in it
#   - a subject called "… failcheck" gets unusable answers (the build fails);
#     "… kidcheck" is refused as unsuitable for a child or a teenager;
#     "… slowcheck" takes eight seconds to plan (so the build screen can be seen)
#   - a capstone (a unit's task, or the final one) has three rubric points; an
#     answer with "pull" or GOOD meets all three, HALF one, anything else none
#   - "what next" after a finished subject is always the same two subjects
#   - a subject called "… figcheck" marks its first four concepts for a figure
#     (parts, plot, table, scale): each explanation carries one to play with
#     and the first check on it is an explore step with a known answer
#     (STUDY_FIGURE_ANSWERS)
#   - "… codecheck" is a JavaScript course whose first concept is proved by
#     writing highWater(mean, range); "… faultcheck" is the same with checks
#     the task's own answer fails (the step must count for nothing)

_STUDY_TOOLS = {1: "parts", 2: "plot", 3: "table", 4: "scale"}
_STUDY_FIGURES = {
    "parts": {"type": "parts", "title": "The Earth and its two bulges", "layout": "row", "parts": [
        {"label": "Moon", "note": "Does the pulling."},
        {"label": "Near-side bulge", "note": "Pulled hardest: the water heaps up towards the moon."},
        {"label": "Earth", "note": "Pulled a middling amount, so it sits between the two bulges."},
        {"label": "Far-side bulge", "note": "Pulled least: it is left behind, and heaps up too."},
    ]},
    "plot": {"type": "plot", "title": "Height of the tide through the day", "expr": "m + (r / 2) * cos(2 * pi * x / 12.4)",
             "x": {"min": 0, "max": 24, "label": "hours after high water"}, "y": {"label": "height (m)"},
             "params": [{"name": "m", "label": "Mean sea level", "unit": "m", "min": 1, "max": 4, "step": 0.5, "value": 2},
                        {"name": "r", "label": "Tidal range", "unit": "m", "min": 0, "max": 6, "step": 0.5, "value": 2}]},
    "table": {"type": "table", "title": "High and low water", "inputs": [
        {"name": "m", "label": "Mean sea level", "unit": "m", "min": 1, "max": 5, "step": 0.5, "value": 3},
        {"name": "r", "label": "Tidal range", "unit": "m", "min": 0, "max": 8, "step": 0.5, "value": 2}],
        "outputs": [{"label": "High water", "expr": "m + r / 2", "unit": "m", "decimals": 2}, {"label": "Low water", "expr": "m - r / 2", "unit": "m", "decimals": 2}]},
    "scale": {"type": "scale", "title": "Hours after high water", "min": 0, "max": 12.5, "step": 0.25, "value": 0, "unit": "h",
              "marks": [{"value": 0, "label": "high water"}, {"value": 12.5, "label": "next high"}],
              "readout": {"label": "Part of the cycle", "expr": "100 * v / 12.4", "unit": "%", "decimals": 0}},
}
_STUDY_GOALS = {
    "parts": ("Tap the part of the picture that is pulled **least** by the moon.", {"part": 3}),
    "plot": ("High water must reach **5 m**. Set the sliders so the curve passes through the dot.", {"points": [{"x": 0, "y": 5}], "tolerance": 0.2}),
    "table": ("The harbour dries when low water falls to **1 m**. Set the numbers so that low water is exactly 1 m.", {"output": 1, "target": 1, "tolerance": 0.05}),
    "scale": ("Drag the point to when **low water** comes.", {"target": 6.2, "tolerance": 0.5}),
}
# One right answer per figure, for the tests that drive them.
STUDY_FIGURE_ANSWERS = {"parts": "Far-side bulge", "plot": {"m": 2, "r": 6}, "table": {"m": 3, "r": 4}, "scale": 6.25}

STUDY_RIGHT = "The moon's gravity pulls the sea towards it"
STUDY_MISC = "thinks the sea pushes the moon"
_STUDY_UNITS = [
    ("Why the sea moves", "What makes a tide in the first place.", [
        ("Gravity reaches across space", "Every mass pulls on every other; the moon is close enough for its pull on the sea to show.", "fact"),
        ("The bulge towards the moon", "Water on the side facing the moon is pulled a little harder, so it heaps up.", "principle"),
        ("The bulge on the far side", "The far side is pulled least, so it is left behind and heaps up too.", "principle"),
    ]),
    ("The rhythm of the tides", "Why high water comes when it does.", [
        ("Two tides a day", "The Earth turns under both bulges, so most coasts get two highs and two lows a day.", "process"),
        ("Why tides run late each day", "The moon moves on while the Earth turns, so the cycle takes about 24 hours 50 minutes.", "process"),
    ]),
    ("Big tides and small tides", "The sun joins in.", [
        ("Spring tides", "Sun and moon in line pull together: the biggest range, at new and full moon.", "principle"),
        ("Neap tides", "Sun and moon at right angles pull against each other: the smallest range.", "principle"),
    ]),
    ("Tides where you are", "Using it on a real coast.", [
        ("Reading a tide table", "Times and heights of high and low water for one place.", "skill"),
        ("The rule of twelfths", "How fast the water rises between low and high.", "skill"),
        ("Tidal streams", "The sideways flow of water that the rise and fall drives.", "process"),
        ("Local shape matters", "Bays and channels can double a tide or cancel it.", "principle"),
        ("Planning around the tide", "Choosing when to go, with a margin.", "skill"),
    ]),
]
_STUDY_DIAGRAMS = [
    {"type": "flow", "title": "From the moon to high water", "nodes": [
        {"id": "a", "label": "The moon's gravity", "note": "Weaker with distance."},
        {"id": "b", "label": "Near side pulled hardest", "note": "It is closest to the moon."},
        {"id": "c", "label": "Far side pulled least", "note": "So it is left behind."},
        {"id": "d", "label": "Two bulges of water", "note": "One each side of the Earth."}],
     "edges": [{"from": "a", "to": "b", "label": ""}, {"from": "a", "to": "c", "label": ""}, {"from": "b", "to": "d", "label": "heaps up"}, {"from": "c", "to": "d", "label": ""}]},
    {"type": "cycle", "title": "One tidal day", "nodes": [
        {"id": "a", "label": "High water", "note": "Under a bulge."}, {"id": "b", "label": "Ebb", "note": "The water falls."},
        {"id": "c", "label": "Low water", "note": "Between the bulges."}, {"id": "d", "label": "Flood", "note": "The water rises."}],
     "edges": [{"from": "a", "to": "b", "label": ""}, {"from": "b", "to": "c", "label": ""}, {"from": "c", "to": "d", "label": ""}, {"from": "d", "to": "a", "label": ""}]},
    {"type": "compare", "title": "Spring and neap", "columns": ["Spring tide", "Neap tide"], "rows": [
        {"label": "Sun and moon", "cells": ["In line", "At right angles"]},
        {"label": "Range", "cells": ["Biggest", "Smallest"]},
        {"label": "When", "cells": ["New and full moon", "Half moon"]}]},
    {"type": "timeline", "title": "A day on the coast", "items": [
        {"label": "High water", "when": "06:10", "note": "4.6 m"}, {"label": "Low water", "when": "12:25", "note": "0.9 m"},
        {"label": "High water", "when": "18:35", "note": "4.4 m"}]},
    {"type": "bars", "title": "Tidal range through the month", "unit": "m", "bars": [
        {"label": "New moon", "value": 4.8}, {"label": "First quarter", "value": 2.1}, {"label": "Full moon", "value": 4.6}, {"label": "Last quarter", "value": 2.3}]},
    {"type": "tree", "title": "What shapes a tide", "nodes": [
        {"id": "t", "label": "The tide here", "note": "", "parent": None},
        {"id": "a", "label": "The moon", "note": "The main pull.", "parent": "t"}, {"id": "b", "label": "The sun", "note": "About half as strong.", "parent": "t"},
        {"id": "c", "label": "The coast", "note": "Bays and channels.", "parent": "t"}]},
]


def _study_opts() -> list[dict]:
    return [
        {"text": STUDY_RIGHT, "why": "Yes. Gravity gets weaker with distance, so the near side is pulled hardest."},
        {"text": "The sea pushes the moon away", "why": "It is the other way round: the moon does the pulling.", "misconception": STUDY_MISC},
        {"text": "The wind piles the water up", "why": "Wind makes waves and surges, not the twice-daily tide.", "misconception": "thinks wind makes tides"},
        {"text": "The sun heats the water so it swells", "why": "Warm water does expand, but far too little and too slowly for this."},
    ]


def _study_step(kind: str, concept: str, prompt: str) -> dict:
    hints = [] if "TEST OUT" in prompt else ["Think about which way the pull goes.", "The moon pulls; the sea follows."]
    if kind == "explain":
        angle = next((a for a, mark in (("analogy", "everyday analogy"), ("example", "fully concrete example"), ("step_by_step", "smallest steps"), ("contrast", "by contrast")) if mark in prompt), "plain")
        pick = (sum(map(ord, concept)) + {"plain": 0, "analogy": 1, "example": 2, "step_by_step": 3, "contrast": 4}[angle]) % len(_STUDY_DIAGRAMS)
        opening = {
            "plain": "Start with what you know: things with mass pull on each other.",
            "analogy": "Picture a tablecloth with a magnet under one edge: the cloth nearest the magnet lifts first.",
            "example": "Take one beach at six in the morning, with the moon overhead.",
            "step_by_step": "One step at a time.",
            "contrast": "It helps to see what this is **not**: it is not wind, and it is not heat.",
        }[angle]
        return {"title": concept, "body": f"{opening}\n\n**{concept}.** The moon's gravity pulls on the whole Earth, but not evenly: it is strongest on the side nearest the moon. "
                "The sea there is pulled a little more than the rock beneath it, so the water heaps up. For example, if the pull on the near side is $1.03$ and at the centre $1.00$, "
                "that small difference is the whole tide.\n\n- The pull gets weaker with distance\n- The difference in pull, not the pull itself, makes the bulge",
                "key_points": ["The moon pulls; the sea follows", "It is the difference in pull across the Earth that matters"],
                "diagram": _STUDY_DIAGRAMS[pick], "sources": [1]}
    if kind == "predict":
        return {"setup": f"It is evening and the moon is directly overhead at your beach. ({concept})", "question": "What is the sea doing here, and why?",
                "options": _study_opts(), "correct": 0, "reveal": "The water under the moon is pulled hardest, so it heaps up: high water. The same is happening on the far side of the Earth.",
                "hints": hints, "sources": [1]}
    if kind == "mcq":
        return {"question": f"{concept}: what makes the water heap up on the side of the Earth that faces the moon?", "options": _study_opts(), "correct": 0,
                "reveal": "The moon's gravity is strongest on the near side.", "hints": hints, "sources": [1]}
    if kind == "order_steps":
        return {"prompt": f"{concept}: put what happens in order, starting at low water.",
                "steps": ["1. Low water: the beach is wide", "2. The flood: the water starts to rise", "3. High water: the bulge is overhead", "4. The ebb: the water falls again"],
                "explain": "The Earth turns the beach into the bulge, then out of it.", "hints": hints, "sources": [1]}
    if kind == "match_pairs":
        return {"prompt": f"{concept}: match each word to what it means.", "pairs": [
            {"left": "Flood", "right": "The water rising"}, {"left": "Ebb", "right": "The water falling"},
            {"left": "Spring tide", "right": "The biggest range"}, {"left": "Neap tide", "right": "The smallest range"}],
            "explain": "Flood and ebb are the two halves of every tide; spring and neap are the two ends of the month.", "hints": hints, "sources": [1]}
    if kind == "spot_error":
        return {"intro": f"A classmate wrote this about {concept.lower()}. One line is wrong.",
                "lines": ["The moon's gravity reaches the Earth.", "It pulls hardest on the side nearest the moon.", "So the sea pushes the moon away and heaps up.", "The Earth turns, so the high water moves round."],
                "error": 2, "explain": "The sea does not push anything: it is pulled, and it follows.", "correction": "So the sea is pulled towards the moon and heaps up.",
                "misconception": STUDY_MISC, "hints": hints, "sources": [1]}
    if kind == "worked_example":
        def blank(q: str) -> dict:
            return {"blank": True, "question": q, "options": [STUDY_RIGHT, "The sea pushes the moon away", "The wind piles the water up"], "correct": 0,
                    "why": "The pull is strongest on the near side, so the water heaps up there."}
        steps = [{"text": "High water was at 06:10. Half a tidal day is about 12 h 25 min.", "blank": False},
                 {"text": "So the next high water is 06:10 + 12:25 = **18:35**.", "blank": False}]
        steps.append(blank("Why is there a high water at all at 18:35?"))
        if "last TWO steps" in prompt or "every step after the first" in prompt:
            steps.insert(1, blank("What sets the time of high water?"))
        return {"problem": f"{concept}: high water was at 06:10. When is the next, and why is there one?", "steps": steps, "hints": hints, "sources": [1]}
    if kind == "explain_back":
        return {"prompt": f"A friend asks why the sea comes in and goes out. Explain {concept.lower()} to them in your own words.",
                "rubric": ["the moon's gravity pulls on the sea", "the pull is strongest on the near side", "so the water heaps up there"],
                "model_answer": "The moon's gravity pulls on the sea. It pulls hardest on the side nearest the moon, so the water there heaps up into a bulge, and that bulge is high tide.",
                "hints": hints, "sources": [1]}
    if kind == "scenario":
        return {"scenario": f"You are on a beach at dusk with the moon straight overhead and the water right up at the sea wall. A child asks you why the sea is so high. ({concept})",
                "question": "What is going on, and what will the beach look like in about six hours?",
                "rubric": ["the moon's pull has heaped the water up here", "in about six hours it will be low water"],
                "model_answer": "The moon is overhead, so its pull has heaped the water up here: high water. In about six hours the Earth will have turned the beach out of the bulge and it will be low water.",
                "hints": hints, "sources": [1]}
    if kind == "teach_student":
        return {"student_name": "Sam", "opening": "I think I get tides. The sea is heavy, so it pushes the moon away, and when it pushes hard the water goes up. Right?",
                "misconception": STUDY_MISC, "rubric": ["the moon pulls on the sea, not the other way round", "the pull is strongest on the near side"],
                "model_answer": "It is the other way round, Sam. The moon's gravity pulls on the sea, hardest on the side nearest the moon, so the water there is drawn up into a bulge.",
                "sources": [1]}
    if kind == "explore":
        tool = re.search(r'\{"type": "(plot|scale|parts|table)"', prompt.rsplit("Reply in exactly this shape:", 1)[-1]).group(1)
        task, goal = _STUDY_GOALS[tool]
        return {"prompt": task, "figure": _STUDY_FIGURES[tool], "goal": goal,
                "explain": "The moon's pull is strongest on the near side and weakest on the far side; the height of the tide swings by half the range either side of the mean.",
                "hints": hints, "sources": [1]}
    if kind == "write_code":
        fault = "faultcheck" in prompt
        return {"prompt": "Write `highWater(mean, range)`: it returns the height of high water, which is the mean level plus **half** the range.\n\nFor example `highWater(3, 4)` is `5`.",
                "starter": "function highWater(mean, range) {\n  // your code here\n}",
                "solution": "function highWater(mean, range) {\n  return mean + range / 2;\n}",
                "checks": [{"call": "highWater(3, 4)", "expect": 50 if fault else 5, "label": "a 4 m range on a 3 m mean gives 5 m"},
                           {"call": "highWater(2, 0)", "expect": 2, "label": "no range: high water is the mean"},
                           {"call": "highWater(1.5, 1)", "expect": 2, "label": "works with halves"}],
                "explain": "High water sits half the range above the mean level.", "hints": hints, "sources": [1]}
    return {}


_STUDY_KINDS = (
    ("explore", '"goal": <the goal>'), ("write_code", '"starter"'),
    ("teach_student", '"student_name"'), ("explain", '"key_points"'), ("predict", '"setup"'), ("mcq", "Test understanding, not wording"),
    ("order_steps", "IN THE CORRECT ORDER"), ("match_pairs", '"pairs": [{"left"'), ("spot_error", "exactly ONE mistake"),
    ("worked_example", '"problem": "a concrete problem"'), ("explain_back", "in their own words, to a named audience"), ("scenario", '"scenario": "a realistic'),
)


def _study_reply(system: str, messages: list) -> str | None:
    if "teacher inside Promptly's Study app" not in system:
        return None
    users = [_text_of(m.get("content"))[0] for m in messages if m.get("role") == "user"]
    prompt = users[0] if users else ""
    if "answering the learner's side question" in system:
        asked = users[-1] if users else ""
        if "more simply" in asked:
            return "Put simply: **the moon pulls the sea towards it**, and the water heaps up where the pull is strongest."
        if "analogy" in asked:
            return "Think of a magnet under a tablecloth: the cloth nearest the magnet lifts first. The analogy stops working because gravity pulls on everything, not just metal."
        if "example" in asked:
            return "At a beach with the moon overhead at 18:00, the water is at its highest. By about midnight it will be low."
        if "deeper" in asked:
            return "The tide comes from the *difference* in the moon's pull across the Earth, which falls off roughly as $1/d^3$."
        return "Good question. Think about **which way the pull goes**: what is doing the pulling, and what follows?"
    found = re.search(r"^Subject: (.*)$", prompt, re.M)
    title = found.group(1) if found else ""
    if "failcheck" in title:
        return "Sure! Here is a lovely course for you."
    if '{"next": [{"title"' in prompt:
        return json.dumps({"next": [
            {"title": "Ocean currents", "why": "They move the same water the tides lift, and they matter just as much on a passage."},
            {"title": "Reading a nautical chart", "why": "It puts what you know about tides to work where you sail."},
        ]})
    if '"rubric": [{"point"' in prompt:
        n = max(1, len(re.findall(r"^\d+\. ", prompt.split("Reply in exactly this shape:")[0], re.M)))
        points = ["Says the moon's gravity pulls the sea towards it", "Uses that to say when the water will be high", "Leaves a margin for what the coast does to it"]
        return json.dumps({
            "task": "You're taking a small boat out tomorrow from a harbour that dries at low water. **Plan the day around the tide**: say when you would leave and be back, and why the water will be where you say it is.",
            "rubric": [{"point": p, "concept": (i % n) + 1} for i, p in enumerate(points)],
            "model_answer": "The moon's gravity pulls the sea towards it, so high water comes as the harbour passes under a bulge. Leave on the rising tide and be back before it has fallen far, with an hour in hand because bays and channels shift the times.",
            "sources": [1],
        })
    if '"suitable": true' in prompt:
        if "slowcheck" in title:
            time.sleep(8)
        if "kidcheck" in title and "The learner is an adult" not in system:
            return json.dumps({"suitable": False, "unsuitable_reason": "This subject isn't a good fit for this age. Try it on the adult setting."})
        found = re.search(r"^Depth wanted: (\w+)", prompt, re.M)
        depth = found.group(1) if found else "solid"
        wanted = _STUDY_UNITS[:3] if depth == "overview" else _STUDY_UNITS
        units, n = [], 0
        for u_title, u_sum, cs in wanted:
            concepts = []
            for c_title, c_sum, nature in cs:
                n += 1
                # Concept 6 builds on two earlier ones, so the map has a fork.
                prereqs = ["c2", "c3"] if n == 6 else [f"c{n - 1}"] if n > 1 else []
                tool = _STUDY_TOOLS.get(n, "none") if "figcheck" in title else "code" if n == 1 and ("codecheck" in title or "faultcheck" in title) else "none"
                concepts.append({"key": f"c{n}", "title": c_title, "summary": c_sum, "objectives": [f"can explain {c_title.lower()}", "can use it on a real coast"],
                                 "nature": nature, "prereqs": prereqs, "sources": [1], "tool": tool})
            units.append({"title": u_title, "summary": u_sum, "concepts": concepts})
        if depth == "deep":
            extra = [{"key": f"c{n + i}", "title": f"Going further {i}", "summary": "A harder case.", "objectives": ["can handle a harder case"], "nature": "skill",
                      "prereqs": [f"c{n + i - 1}"], "sources": [1]} for i in range(1, 10)]
            units.append({"title": "The hard parts", "summary": "Edge cases.", "concepts": extra})
        return json.dumps({"suitable": True, "title": title.replace(" kidcheck", "") or "How tides work",
                           "programming_language": "javascript" if ("codecheck" in title or "faultcheck" in title) else None,
                           "summary": "You'll be able to say why the sea rises and falls, and work out when it will. You'll read a tide table with confidence.", "units": units})
    if '{"questions": [{"key"' in prompt:
        keys = re.findall(r'key "([^"]+)"', prompt)
        return json.dumps({"questions": [{"key": k, "question": "What makes the water heap up on the side of the Earth facing the moon?",
                                          "options": [{"text": o["text"]} for o in _study_opts()], "correct": 0} for k in keys]})
    if '"met" lists the positions' in prompt:
        text = prompt.split("<learner_answer>")[1].split("</learner_answer>")[0]
        low = text.lower()
        if "GOOD" in text or "pull" in low:
            return json.dumps({"outcome": "correct", "met": [0, 1, 2], "feedback": "Yes. You have the cause the right way round: **the moon pulls, the sea follows**.", "misconception": None})
        if "HALF" in text:
            return json.dumps({"outcome": "partial", "met": [0], "feedback": "You have the moon in there, which is right. What is missing is *where* the pull is strongest.", "misconception": None})
        if "MISC" in text or "push" in low:
            return json.dumps({"outcome": "wrong", "met": [], "feedback": "Not quite: it is the other way round. The sea does not push the moon.",
                               "misconception": {"label": STUDY_MISC, "detail": "Has the cause and the effect the wrong way round."}})
        return json.dumps({"outcome": "wrong", "met": [], "feedback": "That does not get at the idea yet. Think about what is doing the pulling.", "misconception": None})
    if "one sentence TO the learner" in prompt:
        return json.dumps({"title": "Which way gravity pulls", "summary": "A bigger mass pulls a smaller one towards it; the pull is never a push.",
                           "objectives": ["can say which way a pull goes", "can tell a pull from a push"], "nature": "principle",
                           "reason": "Your answers had the sea pushing the moon, so we'll sort out which way gravity pulls first."})
    if "Stay in character as the student" in prompt:
        said = prompt.split("<conversation>")[1].split("</conversation>")[0]
        last = [ln for ln in said.splitlines() if ln.startswith("TEACHER:")][-1]
        ok = "GOOD" in last or "pull" in last.lower()
        return json.dumps({"reply": "Oh! So the moon pulls the water towards it, and that makes the bulge. I had it backwards." if ok else "But the sea is so heavy. How can it not be pushing?", "resolved": ok})
    found = re.search(r"^Concept being taught now: (.*)$", prompt, re.M)
    concept = found.group(1) if found else "Tides"
    shape = prompt.rsplit("Reply in exactly this shape:", 1)[-1]
    for kind, mark in _STUDY_KINDS:
        if mark in shape:
            out = _study_step(kind, concept, prompt)
            if kind == "explain" and 'You may ALSO add "figure"' in shape:
                out["figure"] = _STUDY_FIGURES[re.search(r'\{"type": "(plot|scale|parts|table)"', shape).group(1)]
            return json.dumps(out)
    return "{}"


def _reply_for(body: dict) -> tuple[list[str], float, bool]:
    """Chunks to stream, the delay between them, and whether to cut off."""
    messages = body.get("messages") or []
    system = next((_text_of(m.get("content"))[0] for m in messages if m.get("role") == "system"), "")
    if system.startswith("You generate ultra-concise chat titles"):
        return ["E2E chat"], 0, False
    if system.startswith("You maintain a long-term memory"):
        return ["[]"], 0, False
    if system.startswith("You describe personal photos"):
        return ['{"caption": "A lighthouse on a rocky headland by the sea.", "tags": ["lighthouse", "sea", "rocks"]}'], 0, False
    if system.startswith("You describe images"):
        return ["A small test image."], 0, False
    editor = _editor_ai_reply(system, messages)
    if editor is not None:
        return [editor], 0, False
    study = _study_reply(system, messages)
    if study is not None:
        return [study], 0, False

    if messages and messages[-1].get("role") == "tool":
        result = _text_of(messages[-1].get("content"))[0]
        first = next((ln for ln in result.splitlines() if ln.strip() and not ln.startswith("<")), "")
        if first.startswith("Nothing is playing yet"):
            # home_music handed back a list: ask which, by name, as a model would.
            names = [re.sub(r"\s+\(uri: [^)]*\)$", "", ln[2:].strip()) for ln in result.splitlines() if ln.startswith("- ")]
            return [w + " " for w in ("Which one did you mean: " + " or ".join(names) + "?").split(" ")], 0.02, False
        return [w + " " for w in f"Tool said: {first.strip()[:200]}".split(" ")], 0.02, False
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    text, images = _text_of(last_user.get("content"))
    if "[slow]" in text:
        words = [f"word{i} " for i in range(1, 41)]
        return words, 0.25, False
    if "[fail]" in text:
        return ["Partial ", "reply ", "before ", "the ", "drop "], 0.1, True
    if re.search(r"long story", text, re.I):
        return [w + " " for w in " ".join(LONG_STORY).split(" ")], 0.03, False
    n = next(_counter)
    seen = f"I can see {images} image{'s' if images != 1 else ''}. " if images else ""
    reply = f"Echo #{n}: {seen}{text.strip()[:200]}"
    return [w + " " for w in reply.split(" ")], 0.02, False


def _embedding(text: str, dim: int = 768) -> list[float]:
    seed = hashlib.sha256(text.encode()).digest()
    vec = [math.sin(seed[i % len(seed)] + i) for i in range(dim)]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class Handler(BaseHTTPRequestHandler):
    # Chunked streaming (see do_POST) needs HTTP/1.1.
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep container logs quiet
        pass

    def _json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json({"object": "list", "data": [{"object": "model", **m} for m in MODELS]})
        if self.path.rstrip("/").endswith("/last-request"):
            return self._json(_last_chat)
        if self.path.rstrip("/") in ("", "/health"):
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("/embeddings"):
            inputs = body.get("input")
            inputs = [inputs] if isinstance(inputs, str) else list(inputs or [])
            return self._json({
                "object": "list",
                "model": body.get("model"),
                "data": [{"object": "embedding", "index": i, "embedding": _embedding(str(t))}
                         for i, t in enumerate(inputs)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            })
        if not self.path.endswith("/chat/completions"):
            return self._json({"error": "not found"}, 404)

        tool_call = _tool_call_for(body) if body.get("tools") else None
        chunks, delay, cut_off = _reply_for(body) if tool_call is None else ([""], 0, False)
        if delay or chunks[0].startswith("Echo"):
            _last_chat.clear()
            _last_chat.update(body)
        model = body.get("model") or MODELS[0]["id"]
        prompt_tokens = _prompt_tokens(body)
        if not body.get("stream"):
            return self._json({
                "id": "e2e", "object": "chat.completion", "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(chunks).strip()},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": len(chunks), "total_tokens": prompt_tokens + len(chunks)},
            })

        # Chunked, so a [fail] reply can stop mid-body without the final
        # chunk: the client sees a dropped connection ("peer closed
        # connection without sending complete message body"), as with a
        # real upstream that dies. A close-delimited stream would read as a
        # normal end.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send(obj) -> None:
            data = obj if isinstance(obj, str) else json.dumps(obj)
            raw = f"data: {data}\n\n".encode()
            self.wfile.write(f"{len(raw):x}\r\n".encode() + raw + b"\r\n")
            self.wfile.flush()

        base = {"id": "e2e", "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
        try:
            send({**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
            if tool_call is not None:
                name, args = tool_call
                send({**base, "choices": [{"index": 0, "delta": {"tool_calls": [{
                    "index": 0, "id": f"call_{next(_counter)}", "type": "function",
                    "function": {"name": name, "arguments": args},
                }]}, "finish_reason": None}]})
                send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                self.close_connection = True
                return
            for chunk in chunks:
                send({**base, "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]})
                if delay:
                    time.sleep(delay)
            if cut_off:
                self.close_connection = True
                return
            send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            if (body.get("stream_options") or {}).get("include_usage"):
                send({**base, "choices": [], "usage": {
                    "prompt_tokens": prompt_tokens, "completion_tokens": len(chunks),
                    "total_tokens": prompt_tokens + len(chunks)}})
            send("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the backend stopped listening — that's what Stop does
        self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
