"""Chat tools — server-side functions the AI can call mid-stream.

The chat router consumes :data:`registry` to build the OpenAI-format
``tools[]`` payload it ships to the model, and to dispatch the tools the
model decides to invoke. Each tool is a ``Tool`` subclass with a stable
``name``, a JSON-schema ``parameters`` block, and an async ``run``
method that returns a :class:`ToolResult`.

Adding a new tool is intentionally a one-place edit:

1. Subclass :class:`app.chat.tools.base.Tool` in a new module.
2. Import it into ``app.chat.tools.registry`` so it's registered at
   import time.

Phase A1 shipped the dispatch spine plus two smoke tools (``echo`` and
``attach_demo_file``). Phase A2 added ``generate_pdf``, the first real
artefact authoring tool: it persists a Markdown source + a rendered PDF
as a linked pair (see :class:`app.files.generated_kinds.GeneratedKind`)
so a future side-panel editor can mutate the source and re-render in
place. Image generation lands later in Phase C.
"""
from __future__ import annotations

from app.chat.tools.base import Tool, ToolContext, ToolResult, ToolError
from app.chat.tools.prompt import build_tools_system_prompt
from app.chat.tools.registry import REGISTRY, get_tool, list_openai_tools, tools_in

__all__ = [
    "Tool",
    "ToolContext",
    "ToolResult",
    "ToolError",
    "REGISTRY",
    "get_tool",
    "list_openai_tools",
    "tools_in",
    "build_tools_system_prompt",
]
