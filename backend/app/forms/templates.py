"""The built-in form templates (Forms home's "Start a new form" strip,
``POST /api/files/office {kind: "form", form_template}``).

Each is a definition plus the settings that make it work out of the box —
an RSVP lets people change their answer, a sign-up sheet shows the places
left, and the two quizzes (phase 2, WP-F2.4) come with their answer keys
and points set and scores shown straight after sending.
"""
from __future__ import annotations

from typing import Any

from app.forms.definition import validate_definition


def _q(id_: str, kind: str, title: str, *, required: bool = False, description: str = "", **config: Any) -> dict:
    return {"id": id_, "kind": kind, "title": title, "description": description, "required": required, "config": config}


def _opts(*labels: str, prefix: str = "o", limits: dict[str, int] | None = None, go_to: dict[str, str] | None = None) -> list[dict]:
    out = []
    for n, label in enumerate(labels, start=1):
        o: dict[str, Any] = {"id": f"{prefix}{n}", "label": label}
        if limits and label in limits:
            o["limit"] = limits[label]
        if go_to and label in go_to:
            o["go_to"] = go_to[label]
        out.append(o)
    return out


def _section(id_: str, title: str, description: str = "", after: str = "continue") -> dict:
    return {"id": id_, "kind": "section", "title": title, "description": description, "config": {"after": after}}


def _quizq(id_: str, title: str, labels: tuple[str, ...], right: str, *, points: int = 1,
           right_says: str = "", wrong_says: str = "") -> dict:
    """A multiple-choice quiz question with its key set."""
    opts = _opts(*labels, prefix=f"{id_}o")
    key = [o["id"] for o in opts if o["label"] == right]
    q = _q(id_, "multiple_choice", title, required=True, options=opts)
    q["quiz"] = {"points": points, "key": {"options": key}, "feedback_right": right_says, "feedback_wrong": wrong_says}
    return q


_QUIZ_SETTINGS = {"release": "now", "show_score": True, "show_right_wrong": True, "show_answers": True, "show_points": False}


_TEMPLATES: dict[str, dict[str, Any]] = {
    "rsvp": {
        "title": "RSVP",
        "blurb": "Who's coming, and how many.",
        "definition": {
            "title": "RSVP",
            "description": "Let us know if you can make it.",
            "theme": {"accent": "terracotta"},
            "items": [
                _q("name", "short_text", "Your name", required=True),
                _q(
                    "coming", "multiple_choice", "Can you come?", required=True, branching=True,
                    options=_opts("Yes", "Maybe", "No", go_to={"No": "submit"}),
                ),
                _section("details", "A few details"),
                _q(
                    "guests", "short_text", "How many people are coming, including you?", required=True,
                    validation={"kind": "number", "min": 1, "max": 50, "integer": True},
                ),
                _q("notes", "paragraph", "Anything we should know?", max_length=2000),
            ],
        },
        "settings": {"one_per_person": True, "allow_edit": True, "confirmation": "Thanks! We've got your answer."},
    },
    "signup": {
        "title": "Sign-up sheet",
        "blurb": "Places that fill up and disappear.",
        "definition": {
            "title": "Sign-up sheet",
            "description": "Pick what you'll bring. When something's full, it disappears from the list.",
            "theme": {"accent": "green"},
            "items": [
                _q("name", "short_text", "Your name", required=True),
                _q(
                    "bring", "multiple_choice", "What will you bring?", required=True,
                    options=_opts(
                        "Salad", "Dessert", "Drinks", "Bread",
                        limits={"Salad": 2, "Dessert": 2, "Drinks": 3, "Bread": 1},
                    ),
                ),
                _q("note", "short_text", "Anything to add? (what kind, how much)"),
            ],
        },
        "settings": {"allow_edit": True, "show_remaining": True, "confirmation": "Thanks for signing up!"},
    },
    "feedback": {
        "title": "Feedback",
        "blurb": "How did it go, and what could be better.",
        "definition": {
            "title": "Feedback",
            "description": "Tell us how it went. It takes a minute.",
            "theme": {"accent": "violet"},
            "items": [
                _q("overall", "rating", "Overall, how was it?", required=True, max=5, icon="star"),
                _q(
                    "enjoyed", "multiple_choice", "Did you enjoy it?", required=True, branching=True,
                    options=_opts("Yes", "No", go_to={"Yes": "submit", "No": "better"}),
                ),
                _section("better", "What could be better?", after="submit"),
                _q("improve", "paragraph", "What could we do better next time?", required=True),
            ],
        },
        "settings": {"confirmation": "Thanks for your feedback."},
    },
    "contact": {
        "title": "Contact details",
        "blurb": "Names, emails, phone numbers.",
        "definition": {
            "title": "Contact details",
            "description": "Please fill in your details so we can keep in touch.",
            "theme": {"accent": "blue"},
            "items": [
                _q("name", "short_text", "Full name", required=True),
                _q("email", "short_text", "Email", required=True, validation={"kind": "email"}),
                _q("phone", "short_text", "Phone number"),
                _q("address", "paragraph", "Postal address", max_length=500),
                _q(
                    "reach", "multiple_choice", "Best way to reach you",
                    options=_opts("Email", "Phone call", "Text message"),
                ),
            ],
        },
        "settings": {"allow_edit": True, "confirmation": "Thanks! Your details are saved."},
    },
    "registration": {
        "title": "Event registration",
        "blurb": "Sessions, dietary needs, access.",
        "definition": {
            "title": "Event registration",
            "description": "Register for the event. You'll get the details closer to the day.",
            "theme": {"accent": "indigo"},
            "items": [
                _q("name", "short_text", "Full name", required=True),
                _q("email", "short_text", "Email", required=True, validation={"kind": "email"}),
                _q(
                    "sessions", "checkboxes", "Which sessions will you come to?", required=True,
                    options=_opts("Morning", "Afternoon", "Evening"), min_selected=1,
                ),
                _q(
                    "diet", "checkboxes", "Dietary needs",
                    options=_opts("None", "Vegetarian", "Vegan", "Gluten free", prefix="d"), other=True,
                ),
                _q("access", "paragraph", "Anything that would make it easier for you to take part?", max_length=2000),
            ],
        },
        "settings": {"allow_edit": True, "confirmation": "You're registered. See you there!"},
    },
    "order": {
        "title": "Order form",
        "blurb": "What, how many, pick-up or delivery.",
        "definition": {
            "title": "Order form",
            "description": "Place your order below.",
            "theme": {"accent": "teal"},
            "after": "continue",
            "items": [
                _q("name", "short_text", "Your name", required=True),
                _q("contact", "short_text", "Phone or email", required=True),
                _q(
                    "item", "dropdown", "What would you like?", required=True,
                    options=_opts("T-shirt", "Hoodie", "Cap", "Mug"),
                ),
                _q(
                    "size", "dropdown", "Size (clothing only)",
                    options=_opts("XS", "S", "M", "L", "XL", "XXL", prefix="s"),
                ),
                _q(
                    "qty", "short_text", "How many?", required=True,
                    validation={"kind": "number", "min": 1, "max": 100, "integer": True},
                ),
                _q(
                    "handover", "multiple_choice", "Pick-up or delivery?", required=True, branching=True,
                    options=_opts("Pick-up", "Delivery", prefix="h", go_to={"Pick-up": "submit", "Delivery": "address"}),
                ),
                _section("address", "Delivery", after="submit"),
                _q("street", "paragraph", "Delivery address", required=True, max_length=500),
            ],
        },
        "settings": {"allow_edit": True, "confirmation": "Thanks for your order!"},
    },
}

# Phase 2 (WP-F2.4): quizzes. Built-in templates can't carry pictures (a
# form's pictures are its own files), so these are plain words.
_TEMPLATES["quiz"] = {
    "title": "Quiz",
    "blurb": "Points, an answer key and scores.",
    "definition": {
        "title": "Quiz",
        "description": "Answer the questions, then see how you did.",
        "theme": {"accent": "violet"},
        "items": [
            _q("name", "short_text", "Your name", required=True),
            _quizq("q1", "How many days are in a leap year?", ("365", "366", "364"), "366",
                   right_says="Right: February gets a 29th.", wrong_says="It's 366: February gets a 29th."),
            {**_q("q2", "short_text", "What is 7 × 8?", required=True,
                  validation={"kind": "number", "min": None, "max": None, "integer": False}),
             "quiz": {"points": 1, "key": {"accept": ["56"]}, "feedback_right": "", "feedback_wrong": "7 × 8 = 56."}},
            {**_q("q3", "checkboxes", "Which of these are planets?", required=True,
                  options=_opts("Mars", "The Moon", "Venus", "The Sun", prefix="q3o")),
             "quiz": {"points": 2, "key": {"options": ["q3o1", "q3o3"]}, "feedback_right": "",
                      "feedback_wrong": "Mars and Venus are planets; the Moon and the Sun aren't."}},
            {**_q("q4", "paragraph", "In a sentence or two: why do we have seasons?", max_length=1000),
             "quiz": {"points": 2, "key": None, "feedback_right": "", "feedback_wrong": ""}},
        ],
    },
    "settings": {"one_per_person": True, "confirmation": "Thanks for taking the quiz!", "quiz": dict(_QUIZ_SETTINGS)},
}
_TEMPLATES["family_trivia"] = {
    "title": "Family trivia",
    "blurb": "Ten questions, answers and points set.",
    "definition": {
        "title": "Family trivia",
        "description": "Ten questions for the whole family. No looking things up!",
        "theme": {"accent": "teal"},
        "items": [
            _q("name", "short_text", "Your name", required=True),
            _quizq("t1", "Which animal is known as the king of the jungle?", ("Tiger", "Lion", "Elephant", "Gorilla"), "Lion"),
            _quizq("t2", "How many legs does a spider have?", ("6", "8", "10", "12"), "8"),
            _quizq("t3", "What colour do you get when you mix blue and yellow?", ("Green", "Purple", "Orange", "Brown"), "Green"),
            _quizq("t4", "Which planet is closest to the Sun?", ("Venus", "Earth", "Mercury", "Mars"), "Mercury"),
            _quizq("t5", "How many minutes are in an hour?", ("50", "60", "100", "30"), "60"),
            _quizq("t6", "What do bees make?", ("Milk", "Honey", "Silk", "Wax paper"), "Honey"),
            _quizq("t7", "Which is the largest ocean?", ("Atlantic", "Indian", "Arctic", "Pacific"), "Pacific"),
            _quizq("t8", "How many sides does a hexagon have?", ("5", "6", "7", "8"), "6"),
            _quizq("t9", "What is frozen water called?", ("Steam", "Ice", "Fog", "Dew"), "Ice"),
            _quizq("t10", "Which of these is a mammal?", ("Shark", "Dolphin", "Octopus", "Trout"), "Dolphin",
                   right_says="Yes: dolphins breathe air and feed their young milk."),
        ],
    },
    "settings": {"confirmation": "Thanks for playing!", "quiz": dict(_QUIZ_SETTINGS)},
}

KEYS = tuple(_TEMPLATES)


def template_keys() -> tuple[str, ...]:
    return KEYS


def built_in(key: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """(validated definition, settings) for a built-in template, or None."""
    t = _TEMPLATES.get(key)
    if t is None:
        return None
    return validate_definition(t["definition"]), dict(t["settings"])


def listing() -> list[dict[str, Any]]:
    out = []
    for key, t in _TEMPLATES.items():
        d = t["definition"]
        out.append(
            {
                "key": key,
                "title": t["title"],
                "description": t["blurb"],
                "accent": d["theme"]["accent"],
                "questions": sum(1 for i in d["items"] if i["kind"] != "section"),
                "quiz": "quiz" in t["settings"],
            }
        )
    return out


__all__ = ["KEYS", "built_in", "listing", "template_keys"]
