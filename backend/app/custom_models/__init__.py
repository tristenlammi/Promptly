"""Custom Models — admin-curated assistants with personality + RAG.

A ``CustomModel`` is a thin wrapper around an existing
``ModelProvider`` + base model id. It adds a *personality* (system
prompt) and a *knowledge library* (a bag of ``UserFile`` rows whose
text content is chunked, embedded, and stored in
``knowledge_chunks`` for retrieval at chat time).

Why a separate module instead of bolting onto ``models_config``?

* The two have different lifecycles. A provider is "you connected
  an API"; a custom model is "you wrote a prompt and pinned some
  files". Mixing them makes the connection-CRUD UI noisier than
  it needs to be.
* RAG plumbing (chunking, embedding, retrieval) is cleanly
  encapsulated here. ``models_config`` knows nothing about
  pgvector and stays portable.

Surfaced into the existing chat picker via
:func:`app.models_config.router.list_available_models_for`, which
appends one synthetic ``AvailableModel`` per custom model with an
``is_custom=True`` discriminator. The chat dispatch in
:mod:`app.chat.router` recognises the synthetic ``custom:<uuid>``
model id and resolves to the underlying base provider/model at
send time.
"""
from __future__ import annotations
