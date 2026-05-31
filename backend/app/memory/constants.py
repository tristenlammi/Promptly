"""Shared limits for the cross-chat memory feature (Phase 6).

Kept in their own module so both the schemas and the service can import
them without a circular dependency.
"""
from __future__ import annotations

from typing import Final

# Per-fact length cap. Long enough for a sentence of context, short
# enough that the injected block stays cheap even at the row cap.
MAX_CONTENT_CHARS: Final[int] = 600

# Hard cap on how many facts we keep per user. The injection block and
# the management list both honour this; the manual-create endpoint 409s
# when full so the prompt overhead can't grow unbounded.
MAX_MEMORIES: Final[int] = 200

# Most a single turn's extraction pass may add. Stops a chatty turn from
# flooding the store with near-duplicate trivia.
MAX_NEW_PER_TURN: Final[int] = 4

# How many relevant facts to inject per chat turn under semantic retrieval
# (Memory Overhaul Phase 1.2). Small on purpose: a handful of on-point
# facts beats dumping the whole store, and it keeps prompt overhead tiny.
# Falls back to recency (same K) when embeddings are off.
RETRIEVAL_K: Final[int] = 10

# Cosine-similarity at/above which an auto-captured candidate is treated as
# a semantic duplicate of an existing fact and skipped (Memory Overhaul
# 1.4). A safety net behind the reconciliation prompt — set high so it only
# catches near-identical restatements ("User is a developer" vs "User works
# as a software engineer"), not merely topical overlap. Only applied to the
# auto-capture add path; user-typed manual adds are never blocked this way.
SEMANTIC_DUP_THRESHOLD: Final[float] = 0.90
