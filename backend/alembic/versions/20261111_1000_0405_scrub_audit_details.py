"""The audit log keeps ids, not titles or names (admin privacy, AP6).

Admin → Audit showed other people's workspace and item titles (``note
"Biopsy results" in "Family"``), file names, device and credential names,
a row for every chat tool call (which told the admin what someone was
doing, and when), and whatever someone typed in the sign-in box when it
matched no account (sometimes their password). Audit G9-G11.

The app now writes ids, kinds and counts only. This rewrites what's
already stored in ``auth_events``:

* workspace events: ``"Title" (ws=<id>)…`` → ``ws=<id>…``; an item delete
  keeps its kind and nested count. Anything left in double quotes becomes
  ``[title]``.
* ``filename='…'`` (a refused upload, an imported chat file) → ``ext='.pdf'``.
* app passwords: ``device='…'`` → ``device=[name]``; credentials:
  ``credential <name>`` → ``credential [name]``.
* ``tool_invoked`` / ``tool_failed`` rows for read-only native tools are
  deleted. Rows for connector (``mcp__…``) tools, approved calls and the
  native tools that change something are kept. The list is frozen here.
* ``login_fail`` / ``app_password_failed`` rows that matched no account:
  the identifier becomes its first two characters and length (``jo… (12)``).

Only counts are logged.

Revision ID: 0405_scrub_audit_details
Revises: 0404_admin_action_notice
"""
import logging
import re

from alembic import op
from sqlalchemy import text

revision = "0405_scrub_audit_details"
down_revision = "0404_admin_action_notice"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Frozen copy of app.auth.audit.AUDITED_TOOLS at this release.
_AUDITED_TOOLS = frozenset(
    {
        "calendar_add_event", "calendar_change_event", "post_to_room", "dial", "message",
        "use_item", "remember", "forget", "create_note", "add_to_note", "tick_note_items",
        "draft_form", "mail_reply", "mail_draft_reply", "generate_pdf", "generate_image",
        "code_interpreter",
    }
)

_WS = re.compile(r"\(ws=([0-9a-fA-F-]{36})\)")
_NESTED = re.compile(r"\(\+\d+ nested item\(s\)\)")
_QUOTED = re.compile(r'"[^"]*"')
_FILENAME = re.compile(r"""filename=(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|None)""")
_DEVICE = re.compile(r"""device=(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""")
_TOOL = re.compile(r"tool='([^']*)'")
_MASKED = re.compile(r"^.{0,2}… \(\d+\)$")


def _ext(quoted: str) -> str:
    name = quoted[1:-1] if len(quoted) >= 2 and quoted[0] in "'\"" else ""
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem.strip():
        return "''"
    ext = ext.lower()
    return f"'.{ext}'" if 0 < len(ext) <= 11 and ext.isalnum() else "''"


def scrub_workspace(event_type: str, detail: str) -> str:
    m = _WS.search(detail)
    if m:
        prefix, ws, suffix = detail[: m.start()], m.group(1), detail[m.end():]
        if event_type == "workspace_item_deleted":
            kind = prefix.strip().split(" ", 1)[0] if prefix.strip() else "item"
            if kind.startswith('"'):
                kind = "item"
            nested = _NESTED.search(prefix)
            detail = f"{kind}{(' ' + nested.group(0)) if nested else ''} in ws={ws}{suffix}"
        else:
            detail = f"ws={ws}{suffix}"
    return _QUOTED.sub("[title]", detail)


def scrub_detail(event_type: str, detail: str) -> str:
    if event_type.startswith("workspace_"):
        detail = scrub_workspace(event_type, detail)
    if "filename=" in detail:
        detail = _FILENAME.sub(lambda m: "ext=" + _ext(m.group(0)[len("filename="):]), detail)
    if event_type.startswith("app_password_") and "device=" in detail:
        detail = _DEVICE.sub("device=[name]", detail)
    if event_type.startswith("secret_") and detail.startswith("credential ") and "id=" not in detail:
        detail = "credential [name]"
    return detail


def mask(typed: str) -> str:
    typed = (typed or "").strip()
    if not typed or _MASKED.match(typed):
        return typed
    return f"{typed[:2]}… ({len(typed)})"


def tool_row_kept(detail: str) -> bool:
    d = detail or ""
    m = _TOOL.search(d)
    name = m.group(1) if m else ""
    return (
        name.startswith("mcp__")
        or name in _AUDITED_TOOLS
        or "mcp=True" in d
        or "approved_by_user=True" in d
    )


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Titles, names and file names in details.
    rows = conn.execute(
        text(
            "SELECT id, event_type, detail FROM auth_events WHERE detail IS NOT NULL AND ("
            " event_type LIKE 'workspace\\_%' OR event_type LIKE 'app\\_password\\_%'"
            " OR event_type LIKE 'secret\\_%' OR detail LIKE '%filename=%')"
        )
    ).all()
    changed = 0
    for rid, et, detail in rows:
        new = scrub_detail(et, detail)
        if new != detail:
            conn.execute(text("UPDATE auth_events SET detail = :d WHERE id = :i"), {"d": new[:512], "i": rid})
            changed += 1

    # 2. Tool rows for read-only native tools.
    tool_rows = conn.execute(
        text("SELECT id, detail FROM auth_events WHERE event_type IN ('tool_invoked', 'tool_failed')")
    ).all()
    doomed = [rid for rid, detail in tool_rows if not tool_row_kept(detail)]
    for i in range(0, len(doomed), 1000):
        conn.execute(text("DELETE FROM auth_events WHERE id = ANY(:ids)"), {"ids": doomed[i : i + 1000]})

    # 3. Sign-in identifiers that matched no account.
    unknown = conn.execute(
        text(
            "SELECT id, identifier FROM auth_events"
            " WHERE event_type IN ('login_fail', 'app_password_failed') AND user_id IS NULL AND identifier <> ''"
        )
    ).all()
    masked = 0
    for rid, ident in unknown:
        new = mask(ident)
        if new != ident:
            conn.execute(text("UPDATE auth_events SET identifier = :v WHERE id = :i"), {"v": new, "i": rid})
            masked += 1

    log.info(
        "0405_scrub_audit_details: %d details rewritten, %d tool rows removed, %d identifiers masked",
        changed, len(doomed), masked,
    )


def downgrade() -> None:
    # What was removed isn't kept anywhere, by design.
    pass
