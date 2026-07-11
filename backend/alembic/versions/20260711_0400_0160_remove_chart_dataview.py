"""Remove the Chart + Data-view workspace items and the data_sources feature.

Drops the ``charts``, ``data_views`` and ``data_sources`` tables, deletes the
``workspace_items`` rows of kind chart/dataview, and cleans up their RAG
footprint (purges backing knowledge_chunks + trashes the generated Drive
files). ``data_sources`` (admin-configured DB connections) is removed too —
data views were its only consumer.

Chains onto 0159 (a concurrent per-user code-exec migration) to keep the
alembic history linear — a sibling of 0159 would create two heads and
crash-loop the boot.

Revision ID: 0160_remove_chart_dataview
"""
from __future__ import annotations

from alembic import op

revision = "0160_remove_chart_dataview"
down_revision = "0159_code_exec_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Purge workspace RAG chunks backing chart/dataview items so their stale
    # flattened text stops surfacing in retrieval.
    op.execute(
        """
        DELETE FROM knowledge_chunks WHERE user_file_id IN (
            SELECT text_file_id FROM charts WHERE text_file_id IS NOT NULL
            UNION
            SELECT text_file_id FROM data_views WHERE text_file_id IS NOT NULL
        )
        """
    )
    # Soft-delete (trash) the generated backing Drive files so they leave the
    # workspace's file list instead of lingering as orphans.
    op.execute(
        """
        UPDATE files SET trashed_at = now() WHERE id IN (
            SELECT text_file_id FROM charts WHERE text_file_id IS NOT NULL
            UNION
            SELECT text_file_id FROM data_views WHERE text_file_id IS NOT NULL
        )
        """
    )
    # Remove the tree items pointing at the (about-to-be-dropped) backing rows.
    op.execute(
        "DELETE FROM workspace_items WHERE kind IN ('chart', 'dataview')"
    )
    # Drop the backing tables + the now-orphaned data_sources feature.
    # data_views.data_source_id → data_sources; CASCADE handles the FK order.
    op.execute("DROP TABLE IF EXISTS charts CASCADE")
    op.execute("DROP TABLE IF EXISTS data_views CASCADE")
    op.execute("DROP TABLE IF EXISTS data_sources CASCADE")


def downgrade() -> None:
    raise NotImplementedError(
        "Chart/Data-view/Data-sources were removed in 0160; the schema can't "
        "be restored without the deleted code. Restore from a pre-0160 backup."
    )
