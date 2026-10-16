"""Spreadsheets and whiteboards become Drive files (WP-3.2, Part C §3.2).

Each ``spreadsheets`` / ``workspace_canvas`` row gets a shell in ``files``
(``source_kind`` ``sheet`` / ``whiteboard``) and points at it through a new
``file_id`` — ``NOT NULL UNIQUE``, with an FK that does not cascade: a stray
delete of a shell fails rather than taking the content with it. (NO ACTION,
not RESTRICT: RESTRICT is checked immediately, which would also block the
legitimate one-statement cascade when a user and their workspaces go.)

``workspace_id`` becomes nullable on both, for personal sheets and
whiteboards made from Files.

Backfill: one shell per existing row, owned by the workspace owner, in the
folder its ``.md`` mirror lives in (or the workspace folder), sized by the
real state bytes, trashed if its workspace item is. Idempotent: rows that
already have a shell are skipped. Ends by checking every row has exactly
one shell and failing the upgrade otherwise.

Also records when sheets and whiteboards start counting against quota
(``app_settings.office_quota_from``, 30 days out): usage shows them at once,
enforcement waits so nobody is suddenly over their cap.

Revision ID: 0189_office_file_shells
Revises: 0188_files_modified_trash
"""
import json
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0189_office_file_shells"
down_revision = "0188_files_modified_trash"
branch_labels = None
depends_on = None

_KINDS = (
    # table, item kind, shell kind, MIME, suffix, mirror folder
    ("spreadsheets", "sheet", "sheet", "application/vnd.promptly.sheet+json", ".sheet", "Sheets"),
    ("workspace_canvas", "canvas", "whiteboard", "application/vnd.promptly.whiteboard+json", ".whiteboard", "Canvases"),
)


def _filename(title: str, suffix: str) -> str:
    bad = set('<>:"/\\|?*\x00')
    clean = "".join(c for c in (title or "") if c not in bad and ord(c) >= 32).strip()[:240]
    return f"{clean or 'Untitled'}{suffix}"


def upgrade() -> None:
    bind = op.get_bind()
    for table, *_ in _KINDS:
        op.alter_column(table, "workspace_id", nullable=True)
        op.add_column(table, sa.Column("file_id", sa.Uuid(), nullable=True))

    for table, item_kind, shell_kind, mime, suffix, folder_name in _KINDS:
        data_col = "t.data::text" if table == "spreadsheets" else "NULL"
        rows = bind.execute(
            sa.text(
                f"""
                SELECT t.id, t.title, t.created_at, t.updated_at, t.content_text,
                       octet_length(t.yjs_update) AS ylen, {data_col} AS data_text,
                       w.user_id AS owner_id, w.root_folder_id,
                       mirror.folder_id AS mirror_folder,
                       (SELECT i.trashed_at FROM workspace_items i
                         WHERE i.ref_id = t.id AND i.kind = :item_kind
                         ORDER BY i.created_at LIMIT 1) AS item_trashed
                  FROM {table} t
                  JOIN workspaces w ON w.id = t.workspace_id
                  LEFT JOIN files mirror ON mirror.id = t.text_file_id
                 WHERE t.file_id IS NULL
                """
            ),
            {"item_kind": item_kind},
        ).mappings().all()
        for r in rows:
            folder_id = r["mirror_folder"]
            if folder_id is None and r["root_folder_id"] is not None:
                folder_id = bind.execute(
                    sa.text(
                        "SELECT id FROM file_folders WHERE user_id = :u AND parent_id = :p "
                        "AND name = :n AND trashed_at IS NULL LIMIT 1"
                    ),
                    {"u": r["owner_id"], "p": r["root_folder_id"], "n": folder_name},
                ).scalar() or r["root_folder_id"]
            shell_id = uuid.uuid4()
            size = int(r["ylen"] or 0) + (
                len(json.dumps(json.loads(r["data_text"]), separators=(",", ":")).encode("utf-8"))
                if r["data_text"]
                else 0
            )
            name = _filename(r["title"], suffix)
            bind.execute(
                sa.text(
                    """
                    INSERT INTO files (id, user_id, folder_id, filename, original_filename,
                                       mime_type, size_bytes, storage_path, source_kind,
                                       content_text, created_at, updated_at, modified_at,
                                       trashed_at)
                    VALUES (:id, :u, :f, :name, :name, :mime, :size, :path, :kind,
                            :text, :created, :updated, :updated, :trashed)
                    """
                ),
                {
                    "id": shell_id,
                    "u": r["owner_id"],
                    "f": folder_id,
                    "name": name,
                    "mime": mime,
                    "size": size,
                    "path": f"u_{r['owner_id']}/{shell_id}{suffix}.export",
                    "kind": shell_kind,
                    "text": r["content_text"],
                    "created": r["created_at"],
                    "updated": r["updated_at"],
                    "trashed": r["item_trashed"],
                },
            )
            bind.execute(
                sa.text(f"UPDATE {table} SET file_id = :s WHERE id = :id"),
                {"s": shell_id, "id": r["id"]},
            )

        # Every row has exactly one live shell — or the upgrade stops here.
        missing = bind.execute(sa.text(f"SELECT count(*) FROM {table} WHERE file_id IS NULL")).scalar()
        if missing:
            raise RuntimeError(
                f"{missing} {table} row(s) have no workspace to own their shell; fix them and re-run"
            )
        dupes = bind.execute(
            sa.text(f"SELECT count(*) FROM (SELECT file_id FROM {table} GROUP BY file_id HAVING count(*) > 1) d")
        ).scalar()
        if dupes:
            raise RuntimeError(f"{table}: {dupes} shell(s) are shared by more than one row")

        op.alter_column(table, "file_id", nullable=False)
        op.create_unique_constraint(f"uq_{table}_file_id", table, ["file_id"])
        op.create_foreign_key(f"fk_{table}_file_id", table, "files", ["file_id"], ["id"])

    op.add_column(
        "app_settings",
        sa.Column("office_quota_from", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE app_settings SET office_quota_from = now() + interval '30 days'")


def downgrade() -> None:
    op.drop_column("app_settings", "office_quota_from")
    for table, _ik, shell_kind, *_ in _KINDS:
        op.drop_constraint(f"fk_{table}_file_id", table, type_="foreignkey")
        op.drop_constraint(f"uq_{table}_file_id", table, type_="unique")
        op.execute(f"UPDATE {table} SET file_id = NULL")
        op.drop_column(table, "file_id")
        op.execute(f"DELETE FROM files WHERE source_kind = '{shell_kind}'")
        # Personal rows (no workspace) can't survive the downgrade.
        op.execute(f"DELETE FROM {table} WHERE workspace_id IS NULL")
        op.alter_column(table, "workspace_id", nullable=False)
