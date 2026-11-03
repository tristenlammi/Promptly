"""Tags: one shared set per person, used by every app (#tags).

A tag made in Tasks, Files, Calendar, Contacts, Recipes, Budget or a photo
album is the same tag everywhere, and "everything tagged X" lists them
together (only what the viewer can still open).

* Native things (files, calendar events, albums) are tagged in
  ``tag_assignments`` directly.
* Item Store apps keep their tags as strings in their own JSON file — that
  stays the source of truth. :mod:`app.tags.items_sync` mirrors them into
  the shared set on every save, and writes renames / merges / deletes back
  into the files.
"""
