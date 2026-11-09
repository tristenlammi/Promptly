"""Talk: spoken conversations with Promptly (Voice phase 3).

* ``router.py``: ``WS /api/talk/ws``, ``GET /api/talk/config``,
  ``POST /api/talk/ticket`` (WP-T2). The wire protocol is in ``protocol.py``.
* ``session.py``: one conversation's state machine (listening, thinking,
  speaking; speculative start, joined turns, barge-in), transport-agnostic.
* ``links.py``: the live links to the whisper (``/live``) and tts
  (``/tts/stream``) sidecars. ``reply.py``: the chat pipeline. ``speech.py``:
  cutting a streaming reply into pieces to speak. ``words.py``: the self-echo
  filter, backchannels, stop words, goodbyes. ``audio.py``: frames and the
  playhead. ``access.py``: who may talk, voice settings, ``talk_metrics``.
* Doing things by voice (WP-T3): ``tools.py`` (the voice allowlist and the
  gate that holds changes for a yes), ``readback.py`` (the question, from the
  real arguments), ``confirm.py`` (the one strict yes/no matcher, shared with
  ``/api/assistant``), ``fastpath.py`` (your commands, before the model). The
  phone's actions are chat tools in ``chat/tools/device.py``; a yes runs a
  change through ``chat/approvals.py``, the same as the chat's card.
* ``bench.py`` / ``echo_test.html``: WP-T0's measurements.

See ``docs/talking-plan.md``.
"""
