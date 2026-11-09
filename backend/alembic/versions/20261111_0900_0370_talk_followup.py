"""Talk phase 2: "Sent to your phone" pushes, and weather for "Read me my day".

* ``push_preferences.talk_followup``: the Account -> Notifications switch for
  the pushes Talk sends when you say "send that to my phone" (or when a car
  answer had to be cut short). On by default.
* ``app_settings.weather_enabled``: the admin's switch for the one line of
  weather in "Read me my day" (Open-Meteo, Home rounded to ~10 km). On by
  default (owner decision 3, 2026-11-09).

Revision ID: 0370_talk_followup
Revises: 0402_scrub_error_routes
"""
import sqlalchemy as sa

from alembic import op

revision = "0370_talk_followup"
down_revision = "0402_scrub_error_routes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("push_preferences", sa.Column("talk_followup", sa.Boolean(), nullable=False, server_default=sa.text("true")))
    op.add_column("app_settings", sa.Column("weather_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")))


def downgrade() -> None:
    op.drop_column("app_settings", "weather_enabled")
    op.drop_column("push_preferences", "talk_followup")
