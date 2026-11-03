"""Links between things across apps: "Mentioned in" and "Linked".

* :mod:`.refs` — what a thing is (``kind`` + ``id``) and how it looks to a
  viewer, reusing each app's own access checks (None = they can't see it).
* :mod:`.service` — the ``entity_links`` table: mentions kept in step with
  the text of a doc, a room message, a chat message or a journal entry;
  hand-made two-way links; and the "Mentioned in" / "Linked" lists.
* :mod:`.search` — the picker: things across apps matching a query.

Mounted at ``/api/connections`` (:mod:`.router`).
"""
