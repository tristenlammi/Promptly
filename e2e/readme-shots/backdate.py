"""Demo data for the README screenshots, last step: spread out the times.

Rooms messages and Porch posts are written through the API in a few
seconds, so they'd all say "just now". This gives them believable times.
Run it after tools-readme-seed.mjs, on the throwaway stack only:

    docker exec -i PromptlyShots-Backend python - < e2e/readme-shots/backdate.py
"""
import asyncio

from sqlalchemy import text

from app.database import SessionLocal

STATEMENTS = [
    # Each room's conversation: 4 to 11 minutes between messages, ending a few minutes ago.
    """
    WITH ordered AS (
        SELECT id, row_number() OVER (PARTITION BY room_id ORDER BY seq DESC) AS back,
               ('x' || substr(md5(id::text), 1, 4))::bit(16)::int % 7 AS jitter
        FROM room_messages
    )
    UPDATE room_messages m SET created_at = now() - make_interval(mins => (o.back * 7 + o.jitter - 4)::int)
    FROM ordered o WHERE o.id = m.id
    """,
    "UPDATE room_reactions r SET created_at = m.created_at + interval '1 minute' FROM room_messages m WHERE m.id = r.message_id",
    # Porch: one post every day or so, comments a little after their post.
    """
    WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at DESC, id) AS back FROM porch_posts)
    UPDATE porch_posts p SET created_at = now() - make_interval(hours => (o.back * 19 - 16)::int)
    FROM ordered o WHERE o.id = p.id
    """,
    """
    WITH ordered AS (SELECT c.id, c.post_id, row_number() OVER (PARTITION BY c.post_id ORDER BY c.created_at, c.id) AS n FROM porch_comments c)
    UPDATE porch_comments c SET created_at = p.created_at + make_interval(mins => (o.n * 23)::int)
    FROM ordered o JOIN porch_posts p ON p.id = o.post_id WHERE o.id = c.id
    """,
    # Files: not everything was made this minute.
    """
    UPDATE files SET created_at = now() - make_interval(days => (('x' || substr(md5(id::text), 1, 4))::bit(16)::int % 40)::int, hours => (('x' || substr(md5(id::text), 5, 2))::bit(8)::int % 20)::int),
                     updated_at = now() - make_interval(days => (('x' || substr(md5(id::text), 1, 4))::bit(16)::int % 12)::int, hours => (('x' || substr(md5(id::text), 5, 2))::bit(8)::int % 20)::int)
    WHERE mime_type NOT LIKE 'image/%'
    """,
    "UPDATE files SET modified_at = now() - make_interval(days => (('x' || substr(md5(id::text), 1, 4))::bit(16)::int % 12)::int, hours => (('x' || substr(md5(id::text), 5, 2))::bit(8)::int % 20 + 2)::int) WHERE mime_type NOT LIKE 'image/%'",
    "UPDATE document_comments SET created_at = now() - make_interval(hours => (26 - 3 * (('x' || substr(md5(id::text), 1, 2))::bit(8)::int % 4))::int)",
    # Chats keep the day they were written (saving the thread moved it to now).
    "UPDATE conversations SET updated_at = created_at",
    "UPDATE file_folders SET created_at = now() - interval '200 days', updated_at = now() - make_interval(days => (('x' || substr(md5(id::text), 1, 4))::bit(16)::int % 9)::int + 1)",
]


async def main() -> None:
    for statement in STATEMENTS:
        async with SessionLocal() as db:
            try:
                # Without this the tables' own triggers stamp "now" straight back on.
                await db.execute(text("SET LOCAL session_replication_role = replica"))
                result = await db.execute(text(statement))
                await db.commit()
                print("ok", result.rowcount)
            except Exception as exc:  # noqa: BLE001  (a missed tidy-up is only cosmetic)
                print("skipped:", str(exc).splitlines()[0][:160])


asyncio.run(main())
