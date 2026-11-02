"""Across apps: the small bridges that make Promptly's apps work together.

* :mod:`.shares` — "Send to…" a room or a person: a Drive file or folder, a
  photo, an album, a task, a recipe or a trip, posted as a card in Rooms.
* :mod:`.trips` — a trip's photo album, and spending in Budget tagged to a
  trip ("Spent so far").
* :mod:`.groceries` — the Meal Planner's grocery list sent to a Tasks list.

All mounted at ``/api/crossapp`` (:mod:`.router`).
"""
