"""Cross-chat memory / personalization (Roadmap v2 — Phase 6).

A small per-user store of durable facts ("I'm a Rust dev", "answer
concisely") that's injected into every chat's system prompt so the
assistant carries context across conversations. Facts are captured
either explicitly ("remember that …") or via a lightweight post-turn
extraction pass, and the user can view / edit / delete them from
account settings.
"""
