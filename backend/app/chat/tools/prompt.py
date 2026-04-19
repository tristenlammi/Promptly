"""Tool-aware system prompt builder.

Some providers — Gemini being the loudest offender today — flatly refuse
to admit they can produce binary artefacts even when we ship a perfectly
valid ``tools[]`` payload, because their training tells them "I'm a
text-only model." The fix is a small system prompt that *explicitly*
tells the model:

* yes, these tools exist this turn,
* here's roughly when to call each one, and
* it should never apologise for "not being able to" produce something a
  registered tool can produce — it should call the tool instead.

The block is built from :data:`app.chat.tools.registry.REGISTRY`, but
filtered to just the *categories* the chat router exposed this turn
(Phase D1). That way a search-only conversation doesn't see a "you can
generate PDFs" bullet that would be a lie because the tool isn't in
the wire payload, and an artefacts-only conversation isn't told it can
search.

Each :class:`Tool` exposes a ``prompt_hint`` (defaulting to its
``description``) so we can keep the function-calling schema terse for
the wire format while the system prompt carries a more conversational
explanation.
"""
from __future__ import annotations

from app.chat.tools.registry import tools_in


def build_tools_system_prompt(categories: set[str]) -> str:
    """Return a system message that primes the model to use tools.

    ``categories`` selects which tools appear in the bullet list and
    which behavioural guidelines we render — a search-only turn doesn't
    need the "if the user asks for a PDF, call generate_pdf" guideline,
    and vice versa. An empty set returns an empty string (caller skips
    injection entirely).
    """
    if not categories:
        return ""

    tools = tools_in(categories)
    if not tools:
        return ""

    bullets = "\n".join(
        f"- `{t.name}`: {(getattr(t, 'prompt_hint', None) or t.description).strip()}"
        for t in tools
    )

    guidelines: list[str] = []
    if "artefact" in categories:
        guidelines.append(
            "- If the user asks for a PDF, report, document, brief, or "
            "printable file, call `generate_pdf` with the full Markdown "
            "body. Don't ask permission first — just produce the file."
        )
        guidelines.append(
            "- If the user asks for an image, illustration, picture, "
            "diagram, or wants to edit an attached image, call "
            "`generate_image`. Don't say you can't generate images."
        )
    if "search" in categories:
        guidelines.append(
            "- If the user asks about anything that may have changed "
            "since your training cutoff (news, prices, sports, software "
            "versions, current events, current job titles, etc.) or "
            "explicitly asks you to look something up, call `web_search` "
            "first, then answer with inline [1], [2], ... citations."
        )
        guidelines.append(
            "- After a `web_search`, if a result looks relevant but the "
            "snippet is too short to answer confidently, call `fetch_url` "
            "on its URL to read the page in full before replying."
        )
    guidelines.append(
        "- Briefly summarise what you produced after the tool returns "
        "(one or two sentences); don't paste the full content back."
    )
    guidelines.append(
        "- If a tool errors, surface the error message verbatim and "
        "suggest a fix. Don't pretend the tool didn't exist."
    )

    return (
        "You have access to the following server-side tools this turn. "
        "When the user's request can be satisfied by one of them, CALL "
        "the tool — do NOT reply that you can't generate a file, image, "
        "search the web, or read a page. The host application has wired "
        "the tool's output directly into the chat UI for the user, so "
        "calling the tool is always the right move when the request fits.\n\n"
        "Available tools:\n"
        f"{bullets}\n\n"
        "Guidelines:\n" + "\n".join(guidelines)
    )


__all__ = ["build_tools_system_prompt"]
