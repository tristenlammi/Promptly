"""Notes: the admin's choice about transcribing voice notes.

Unset (NULL): on when the server transcribes with its own Whisper
(``STT_BACKEND=local``), off when it would send recordings to a cloud
service, until the admin turns it on (``app/notes/transcription.py``).

Revision ID: 0264_notes_transcribe
Revises: 0261_notes_core
"""
import sqlalchemy as sa
from alembic import op

revision = "0264_notes_transcribe"
down_revision = "0261_notes_core"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("notes_transcribe", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("app_settings", "notes_transcribe")
