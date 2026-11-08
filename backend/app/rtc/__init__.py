"""Real-time media (LiveKit), shared by Calls and Talking to Promptly.

* ``names``    LiveKit room-name prefixes: who owns which rooms.
* ``config``   the key pair and where LiveKit is.
* ``tokens``   access tokens for a browser or the Android service.
* ``service``  the LiveKit RoomService API (list, remove, mute, send data).
* ``webhooks`` LiveKit's signed webhooks, routed to the feature by prefix.
* ``stun``     this server's public address, the way LiveKit finds it.
* ``metrics``  LiveKit's own counters, for the admin usage card.

Nothing here knows about Rooms or voice channels; those live in
``app.calls``. Talking to Promptly registers its own prefix in ``names``.
"""
