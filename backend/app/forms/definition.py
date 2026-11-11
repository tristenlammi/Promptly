"""A form's definition: what the builder saves and the answer page shows.

Every save is validated and normalised here (the way ``items/spec.py``
validates an item's data), so a bad write — from the builder, a template,
a copy or, later, the AI — can never store a form the answer page or the
path walk can't trust.

Shape::

    {
      "version": 1,
      "title": "BBQ RSVP", "description": "…",
      "theme": {"accent": "terracotta", "header_asset_id": null,
                "header_builtin": null, "font": "default"},
      "after": "continue",            # where section 1 goes when it ends
      "items": [
        {"id": "q1", "kind": "multiple_choice", "title": "Coming?",
         "description": "", "image_asset_id": null, "required": true,
         "config": {...}, "deleted": false},
        {"id": "s2", "kind": "section", "title": "Food", ...,
         "config": {"after": "continue"}},
        …
      ]
    }

Items keep **stable ids**: answers are keyed by them. Sections are items
of kind ``section`` (a page break); the part before the first one is
section 1. Branching lives on sections (``after``: ``continue`` /
``submit`` / a section id) and on choice options (``go_to``), and the
server re-walks it on every submit.

A question that already has answers is never removed: :func:`keep_answered`
puts it back, marked ``deleted``, so its answers still show.

Limits: 200 items (not counting deleted ones; 500 with them), 50
sections, 100 options per question, 256 KB of JSON.
"""
from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

VERSION = 1
MAX_ITEMS = 200
MAX_ITEMS_WITH_DELETED = 500
MAX_SECTIONS = 50
MAX_OPTIONS = 100
MAX_JSON_BYTES = 256 * 1024

SHORT_TEXT_MAX = 1000
PARAGRAPH_DEFAULT = 5000
PARAGRAPH_MAX = 10000
OPTION_LIMIT_MAX = 100_000

# Theme presets (the builder maps each to colours checked for AA contrast in
# light and dark; there's no free colour picker). Terracotta first.
ACCENTS = (
    "terracotta",
    "rose",
    "plum",
    "violet",
    "indigo",
    "blue",
    "teal",
    "green",
    "olive",
    "slate",
)
Accent = Literal[
    "terracotta", "rose", "plum", "violet", "indigo", "blue", "teal", "green", "olive", "slate"
]

QUESTION_KINDS = (
    "short_text",
    "paragraph",
    "multiple_choice",
    "checkboxes",
    "dropdown",
    "linear_scale",
    "rating",
    "date",
    "time",
    "file_upload",
    # Phase 2 (WP-F2.1): a grid of rows × columns.
    "choice_grid",
    "checkbox_grid",
    # WP-F2.2: a place someone picks or types (never a GPS fix).
    "location",
)
BLOCK_KINDS = ("text", "image", "section")
ItemKind = Literal[
    "short_text",
    "paragraph",
    "multiple_choice",
    "checkboxes",
    "dropdown",
    "linear_scale",
    "rating",
    "date",
    "time",
    "file_upload",
    "choice_grid",
    "checkbox_grid",
    "location",
    "text",
    "image",
    "section",
]
CHOICE_KINDS = ("multiple_choice", "checkboxes", "dropdown")
GRID_KINDS = ("choice_grid", "checkbox_grid")
# Grids stay usable on a phone (one small group of chips per row).
GRID_MAX_ROWS = 20
GRID_MAX_COLUMNS = 8
GRID_COLUMN_CHARS = 40
# Choice questions whose answer can send people to another section.
BRANCHING_KINDS = ("multiple_choice", "dropdown")

UPLOAD_GROUPS = ("images", "pdf", "documents", "spreadsheets", "audio", "video")
# Respondents without an account may only send these (owner decision 2).
LINK_UPLOAD_GROUPS = ("images", "pdf")

_ID_RE = r"^[A-Za-z0-9_-]{1,40}$"
Id = Annotated[str, StringConstraints(pattern=_ID_RE)]
AssetId = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F-]{36}$")]
Text300 = Annotated[str, StringConstraints(max_length=300)]
Text100 = Annotated[str, StringConstraints(max_length=100)]
Text500 = Annotated[str, StringConstraints(max_length=500)]
Text1000 = Annotated[str, StringConstraints(max_length=1000)]
Text5000 = Annotated[str, StringConstraints(max_length=5000)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


# --------------------------------------------------------------------
# Per-kind config
# --------------------------------------------------------------------
class ShortTextValidation(_Strict):
    kind: Literal["any", "number", "email", "url"] = "any"
    # Numbers only.
    min: float | None = None
    max: float | None = None
    integer: bool = False

    @model_validator(mode="after")
    def _check(self) -> ShortTextValidation:
        if self.kind != "number" and (self.min is not None or self.max is not None or self.integer):
            raise ValueError("Only a number answer can have a smallest or largest value.")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("The smallest number can't be bigger than the largest.")
        return self


class ShortTextConfig(_Strict):
    validation: ShortTextValidation = Field(default_factory=ShortTextValidation)
    min_length: int | None = Field(default=None, ge=1, le=SHORT_TEXT_MAX)
    max_length: int | None = Field(default=None, ge=1, le=SHORT_TEXT_MAX)

    @model_validator(mode="after")
    def _check(self) -> ShortTextConfig:
        if self.min_length and self.max_length and self.min_length > self.max_length:
            raise ValueError("The shortest length can't be more than the longest.")
        return self


class ParagraphConfig(_Strict):
    min_length: int | None = Field(default=None, ge=1, le=PARAGRAPH_MAX)
    max_length: int = Field(default=PARAGRAPH_DEFAULT, ge=1, le=PARAGRAPH_MAX)

    @model_validator(mode="after")
    def _check(self) -> ParagraphConfig:
        if self.min_length and self.min_length > self.max_length:
            raise ValueError("The shortest length can't be more than the longest.")
        return self


class Option(_Strict):
    id: Id
    label: Text500 = ""
    # Multiple choice / dropdown with branching on: a section id, "submit",
    # or None (carry on as the section says).
    go_to: str | None = None
    # "Limit per option" — what makes a sign-up sheet.
    limit: int | None = Field(default=None, ge=1, le=OPTION_LIMIT_MAX)
    image_asset_id: AssetId | None = None


class _ChoiceBase(_Strict):
    options: list[Option] = Field(default_factory=list, max_length=MAX_OPTIONS)

    @model_validator(mode="after")
    def _unique(self) -> _ChoiceBase:
        ids = [o.id for o in self.options]
        if len(ids) != len(set(ids)):
            raise ValueError("Two options have the same id.")
        return self


class MultipleChoiceConfig(_ChoiceBase):
    other: bool = False
    shuffle: bool = False
    branching: bool = False


class CheckboxesConfig(_ChoiceBase):
    other: bool = False
    shuffle: bool = False
    min_selected: int | None = Field(default=None, ge=1, le=MAX_OPTIONS)
    max_selected: int | None = Field(default=None, ge=1, le=MAX_OPTIONS)

    @model_validator(mode="after")
    def _check(self) -> CheckboxesConfig:
        if any(o.go_to for o in self.options):
            raise ValueError("Checkboxes can't send people to another section.")
        if self.min_selected and self.max_selected and self.min_selected > self.max_selected:
            raise ValueError("“At least” can't be more than “at most”.")
        n = len(self.options) + (1 if self.other else 0)
        if self.min_selected and n and self.min_selected > n:
            raise ValueError("“At least” is more than the number of options.")
        return self


class DropdownConfig(_ChoiceBase):
    branching: bool = False


class LinearScaleConfig(_Strict):
    min: Literal[0, 1] = 1
    max: int = Field(default=5, ge=2, le=10)
    min_label: Text100 = ""
    max_label: Text100 = ""


class RatingConfig(_Strict):
    max: int = Field(default=5, ge=3, le=10)
    icon: Literal["star", "heart", "thumb"] = "star"


class DateConfig(_Strict):
    include_time: bool = False
    include_year: bool = True


class TimeConfig(_Strict):
    mode: Literal["time", "duration"] = "time"


class FileUploadConfig(_Strict):
    kinds: list[Literal["images", "pdf", "documents", "spreadsheets", "audio", "video"]] = Field(
        default_factory=lambda: ["images", "pdf"], min_length=1, max_length=6
    )
    max_files: int = Field(default=1, ge=1, le=10)
    max_size_mb: int = Field(default=10, ge=1, le=100)

    @model_validator(mode="after")
    def _dedupe(self) -> FileUploadConfig:
        self.kinds = list(dict.fromkeys(self.kinds))
        return self


class GridRow(_Strict):
    id: Id
    label: Text300 = ""


class GridColumn(_Strict):
    id: Id
    label: Annotated[str, StringConstraints(max_length=GRID_COLUMN_CHARS)] = ""


class _GridBase(_Strict):
    """Rows and columns keep stable ids (like options), so a renamed row
    keeps its answers. ``each_row``: every row needs an answer (``required``
    alone means at least one row)."""

    rows: list[GridRow] = Field(default_factory=list, max_length=GRID_MAX_ROWS)
    columns: list[GridColumn] = Field(default_factory=list, max_length=GRID_MAX_COLUMNS)
    each_row: bool = False
    # Rows only: a scale's columns must stay in order.
    shuffle_rows: bool = False

    @model_validator(mode="after")
    def _unique(self) -> _GridBase:
        rows = [r.id for r in self.rows]
        cols = [c.id for c in self.columns]
        if len(rows) != len(set(rows)):
            raise ValueError("Two rows have the same id.")
        if len(cols) != len(set(cols)):
            raise ValueError("Two columns have the same id.")
        return self


class ChoiceGridConfig(_GridBase):
    # "Rank these": each column can be picked in one row only.
    one_per_column: bool = False

    @model_validator(mode="after")
    def _check(self) -> ChoiceGridConfig:
        if self.one_per_column and self.each_row and len(self.rows) > len(self.columns):
            raise ValueError(
                "With one answer per column, every row can only be answered if there are at least as many columns as rows."
            )
        return self


class CheckboxGridConfig(_GridBase):
    pass


class LocationConfig(_Strict):
    # What to ask for: a street address, a suburb or town (no street
    # needed), or any place at all. Suggestions follow it.
    ask: Literal["address", "town", "any"] = "address"


class TextConfig(_Strict):
    pass


class ImageConfig(_Strict):
    alt: Text500 = ""


class SectionConfig(_Strict):
    # Where this section goes when it ends: "continue", "submit" or a
    # section id.
    after: str = "continue"


_FIELD_WORDS = {
    "title": "The title",
    "description": "The description",
    "label": "An option",
    "min_label": "A scale label",
    "max_label": "A scale label",
    "alt": "The picture's description",
}


def _config_message(exc: ValidationError) -> str:
    """A question's settings error, in the words the builder shows."""
    err = exc.errors()[0]
    loc = [p for p in err.get("loc") or () if isinstance(p, str)]
    etype = err.get("type") or ""
    if etype == "value_error":
        return re.sub(r"^Value error, ", "", str(err.get("msg") or ""))
    if etype == "too_long" and "options" in loc:
        return f"A question can have at most {MAX_OPTIONS} options."
    if etype == "too_long" and "rows" in loc:
        return f"A grid can have at most {GRID_MAX_ROWS} rows."
    if etype == "too_long" and "columns" in loc:
        return f"A grid can have at most {GRID_MAX_COLUMNS} columns."
    if etype == "string_too_long" and "columns" in loc:
        return f"A column's words are too long (at most {GRID_COLUMN_CHARS} characters). Keep columns short."
    if etype == "string_too_long" and "rows" in loc:
        limit = (err.get("ctx") or {}).get("max_length")
        return f"A row's words are too long (at most {limit} characters)."
    if etype == "string_too_long":
        limit = (err.get("ctx") or {}).get("max_length")
        return f"{_FIELD_WORDS.get(loc[-1] if loc else '', 'This text')} is too long (at most {limit} characters)."
    if etype == "string_pattern_mismatch":
        return "Something in this question has an id the server can't use."
    if etype == "extra_forbidden":
        return f"This question has a setting a form doesn't know ({'.'.join(loc)})."
    if etype in ("too_short",) and "kinds" in loc:
        return "Pick at least one kind of file people can send."
    return f"One of this question's settings isn't allowed ({'.'.join(loc) or 'settings'})."


CONFIGS: dict[str, type[_Strict]] = {
    "short_text": ShortTextConfig,
    "paragraph": ParagraphConfig,
    "multiple_choice": MultipleChoiceConfig,
    "checkboxes": CheckboxesConfig,
    "dropdown": DropdownConfig,
    "linear_scale": LinearScaleConfig,
    "rating": RatingConfig,
    "date": DateConfig,
    "time": TimeConfig,
    "file_upload": FileUploadConfig,
    "choice_grid": ChoiceGridConfig,
    "checkbox_grid": CheckboxGridConfig,
    "location": LocationConfig,
    "text": TextConfig,
    "image": ImageConfig,
    "section": SectionConfig,
}


# --------------------------------------------------------------------
# Items and the form
# --------------------------------------------------------------------
class Item(_Strict):
    id: Id
    kind: ItemKind
    title: Text1000 = ""
    description: Text5000 = ""
    image_asset_id: AssetId | None = None
    required: bool = False
    config: dict[str, Any] = Field(default_factory=dict)
    deleted: bool = False
    # Quizzes (WP-F2.3): ``{points, key, feedback_right, feedback_wrong,
    # suggested?}`` or null. Never sent to the answer page
    # (``answering.respondent_definition`` drops it).
    quiz: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _config(self) -> Item:
        model = CONFIGS[self.kind]
        try:
            self.config = model.model_validate(self.config or {}).model_dump(mode="json")
        except ValidationError as exc:
            raise ValueError(_config_message(exc)) from None
        if self.kind in BLOCK_KINDS:
            # Blocks aren't questions: nothing to answer, so nothing to require.
            self.required = False
        if self.quiz is not None:
            from app.forms.quiz import clean_item_quiz

            self.quiz = clean_item_quiz(self.kind, self.config, self.quiz)
        return self

    @property
    def is_question(self) -> bool:
        return self.kind in QUESTION_KINDS


class Theme(_Strict):
    accent: Accent = "terracotta"
    header_asset_id: AssetId | None = None
    # One of the built-in header pictures (the builder owns the set).
    header_builtin: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,40}$")] | None = None
    font: Literal["default", "serif", "rounded"] = "default"


class Definition(_Strict):
    version: int = VERSION
    title: Text300 = "Untitled form"
    description: Text5000 = ""
    theme: Theme = Field(default_factory=Theme)
    after: str = "continue"
    items: list[Item] = Field(default_factory=list, max_length=MAX_ITEMS_WITH_DELETED)

    @model_validator(mode="after")
    def _check(self) -> Definition:
        if self.version != VERSION:
            raise ValueError(f"Unknown form version {self.version}.")
        ids = [i.id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("Two items have the same id.")
        live = [i for i in self.items if not i.deleted]
        if len(live) > MAX_ITEMS:
            raise ValueError(f"A form can have at most {MAX_ITEMS} questions and blocks.")
        sections = [i.id for i in live if i.kind == "section"]
        if len(sections) + 1 > MAX_SECTIONS:
            raise ValueError(f"A form can have at most {MAX_SECTIONS} sections.")
        targets = set(sections)

        def check_target(value: str | None, where: str, *, allow_continue: bool) -> None:
            if value is None:
                return
            if value == "submit" or (allow_continue and value == "continue"):
                return
            if value not in targets:
                raise ValueError(f"{where} goes to a section that isn't in the form.")

        check_target(self.after, "Section 1", allow_continue=True)
        for it in live:
            label = f"“{(it.title or 'Untitled')[:60]}”"
            if it.kind == "section":
                check_target(it.config.get("after"), label, allow_continue=True)
                if it.config.get("after") == it.id:
                    raise ValueError(f"Section {label} can't go to itself.")
            if it.kind in CHOICE_KINDS:
                # With branching off, stored go_to's are kept for when it's
                # turned back on (the path walk ignores them), but must
                # still point somewhere real.
                for o in it.config.get("options") or []:
                    check_target(o.get("go_to"), label, allow_continue=True)
        return self


# --------------------------------------------------------------------
# Validation entry points
# --------------------------------------------------------------------
class DefinitionError(ValueError):
    """A definition that can't be saved; ``str()`` is the reason, in words
    the builder shows inline. ``item_id`` points at the item, if known."""

    def __init__(self, message: str, *, item_id: str | None = None) -> None:
        super().__init__(message)
        self.item_id = item_id


def _friendly(exc: ValidationError, raw: dict[str, Any]) -> DefinitionError:
    err = exc.errors()[0]
    loc = list(err.get("loc") or ())
    item_id = None
    if len(loc) >= 2 and loc[0] == "items" and isinstance(loc[1], int):
        try:
            item_id = str((raw.get("items") or [])[loc[1]].get("id") or "") or None
        except (AttributeError, IndexError, TypeError):
            item_id = None
    msg = str(err.get("msg") or "This form can't be saved.")
    msg = re.sub(r"^(Value error|Assertion failed), ", "", msg)
    etype = err.get("type") or ""
    if etype == "string_too_long":
        field = next((str(p) for p in reversed(loc) if isinstance(p, str)), "")
        limit = (err.get("ctx") or {}).get("max_length")
        msg = f"{_FIELD_WORDS.get(field, 'This text')} is too long (at most {limit} characters)."
    elif etype == "too_long" and "options" in loc:
        msg = f"A question can have at most {MAX_OPTIONS} options."
    elif etype == "too_long" and loc[:1] == ["items"]:
        msg = f"A form can have at most {MAX_ITEMS} questions and blocks."
    elif etype == "string_pattern_mismatch":
        msg = "Something in this form has an id the server can't use."
    elif etype in ("literal_error", "enum") and "kind" in loc:
        msg = "That question type isn't one a form can have."
    return DefinitionError(msg, item_id=item_id)


def json_size(data: Any) -> int:
    return len(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def validate_definition(raw: Any) -> dict[str, Any]:
    """The normalised definition, or :class:`DefinitionError`."""
    if not isinstance(raw, dict):
        raise DefinitionError("A form's definition must be an object.")
    if json_size(raw) > MAX_JSON_BYTES:
        raise DefinitionError("This form is too big to save (256 KB at most). Remove some questions or text.")
    try:
        model = Definition.model_validate(raw)
    except ValidationError as exc:
        raise _friendly(exc, raw) from None
    except ValueError as exc:  # pragma: no cover — validators raise inside ValidationError
        raise DefinitionError(str(exc)) from None
    out = model.model_dump(mode="json")
    for it in out.get("items") or []:
        # Only quiz questions carry a ``quiz`` (a plain form's JSON is as it was).
        if it.get("quiz") is None:
            it.pop("quiz", None)
    if json_size(out) > MAX_JSON_BYTES:
        raise DefinitionError("This form is too big to save (256 KB at most). Remove some questions or text.")
    return out


def keep_answered(new: dict[str, Any], old: dict[str, Any], answered: set[str]) -> dict[str, Any]:
    """``new`` with every answered question of ``old`` that it dropped put
    back, marked ``deleted`` (answers outlive their question). An answered
    question can't be resurrected under another kind by id reuse either:
    if ``new`` reuses an answered id for a different kind, that's kept —
    the Responses tab shows old answers as text."""
    if not answered:
        return new
    present = {i["id"] for i in new.get("items") or []}
    missing = [
        dict(i, deleted=True)
        for i in old.get("items") or []
        if i.get("id") in answered and i.get("id") not in present
    ]
    if not missing:
        return new
    out = dict(new)
    out["items"] = list(new.get("items") or []) + missing
    return out


def blank(title: str = "Untitled form") -> dict[str, Any]:
    return validate_definition({"title": title, "items": []})


def questions(defn: dict[str, Any], *, include_deleted: bool = False) -> list[dict[str, Any]]:
    """The definition's questions (not blocks or sections), in order."""
    return [
        i
        for i in defn.get("items") or []
        if i.get("kind") in QUESTION_KINDS and (include_deleted or not i.get("deleted"))
    ]


def search_text(defn: dict[str, Any]) -> str:
    """The shell's ``content_text``: the title, description and the
    questions' words — **never answers**, so Drive search and chat file
    tools can't surface strangers' words through the form."""
    parts = [defn.get("title") or "", defn.get("description") or ""]
    for i in defn.get("items") or []:
        if i.get("deleted"):
            continue
        parts.append(i.get("title") or "")
        if i.get("description"):
            parts.append(i["description"])
        for o in (i.get("config") or {}).get("options") or []:
            if o.get("label"):
                parts.append(o["label"])
        cfg = i.get("config") or {}
        for part in ("rows", "columns"):
            for r in cfg.get(part) or []:
                if r.get("label"):
                    parts.append(r["label"])
        for k in ("min_label", "max_label"):
            if cfg.get(k):
                parts.append(cfg[k])
    return "\n".join(p.strip() for p in parts if p and p.strip())[:200_000]


def asset_ids(defn: dict[str, Any]) -> set[str]:
    """Every image the definition points at (header, items, options)."""
    out: set[str] = set()
    theme = defn.get("theme") or {}
    if theme.get("header_asset_id"):
        out.add(str(theme["header_asset_id"]).lower())
    for i in defn.get("items") or []:
        if i.get("image_asset_id"):
            out.add(str(i["image_asset_id"]).lower())
        for o in (i.get("config") or {}).get("options") or []:
            if o.get("image_asset_id"):
                out.add(str(o["image_asset_id"]).lower())
    return out


def remap_assets(defn: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """``defn`` with asset ids swapped through ``mapping`` (a copy's own
    images); ids not in the mapping are dropped."""
    out = json.loads(json.dumps(defn))

    def swap(v: str | None) -> str | None:
        return mapping.get(str(v).lower()) if v else None

    theme = out.get("theme") or {}
    if theme.get("header_asset_id"):
        theme["header_asset_id"] = swap(theme["header_asset_id"])
    for i in out.get("items") or []:
        if i.get("image_asset_id"):
            i["image_asset_id"] = swap(i["image_asset_id"])
        for o in (i.get("config") or {}).get("options") or []:
            if o.get("image_asset_id"):
                o["image_asset_id"] = swap(o["image_asset_id"])
    return out


__all__ = [
    "ACCENTS",
    "BLOCK_KINDS",
    "CHOICE_KINDS",
    "GRID_KINDS",
    "LINK_UPLOAD_GROUPS",
    "MAX_ITEMS",
    "MAX_JSON_BYTES",
    "MAX_OPTIONS",
    "MAX_SECTIONS",
    "QUESTION_KINDS",
    "UPLOAD_GROUPS",
    "Definition",
    "DefinitionError",
    "asset_ids",
    "blank",
    "keep_answered",
    "questions",
    "remap_assets",
    "search_text",
    "validate_definition",
]
