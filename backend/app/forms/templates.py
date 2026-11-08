"""The six built-in form templates (Forms home's "Start a new form" strip,
``POST /api/files/office {kind: "form", form_template}``).

Each is a definition plus the settings that make it work out of the box —
an RSVP lets people change their answer, a sign-up sheet shows the places
left. Quiz templates arrive with quizzes (phase 2).
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
            }
        )
    return out


__all__ = ["KEYS", "built_in", "listing", "template_keys"]
