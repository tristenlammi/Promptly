"""A deterministic stand-in for an OpenAI-compatible model server.

The end-to-end suite points an "E2E Mock" provider at this so chat flows
(send, stop, regenerate, attach) run the same way every time, cost
nothing, and never touch a real model. Standard library only — it runs
inside the backend image with ``--entrypoint python``.

Replies are driven by markers in the user's message:

    [slow]   stream ~40 words, 250 ms apart (time to press Stop)
    [fail]   stream a few words, then drop the connection
    [tool:NAME {json}]
             call tool NAME with those arguments (once — after the tool's
             result comes back, reply "Tool said: <first line>")
    (none)   "Echo #<n>: <text>" — <n> counts up, so a regenerated
             reply always differs from the one it replaces

Requests the backend makes on its own are recognised by their system
prompt: the chat titler gets "E2E chat", memory capture gets "[]", and
the vision relay gets a fixed caption. The editors' AI (WP-5.5) gets
well-formed answers: Sheet AI fill → "Cat <row>" per row, clean → each
text cell trimmed and Title Cased, build → a small budget with a SUM
formula, PDF → Doc → "# Converted" plus the text.

``prompt_tokens`` is a size estimate of the request (characters / 4), and
``GET /last-request`` returns the last chat request body, so tests can
check what a turn actually sends.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = [
    {"id": "e2e-mock-chat", "name": "E2E Mock Chat", "context_length": 32000},
    {"id": "e2e-mock-vision", "name": "E2E Mock Vision", "context_length": 32000},
    {"id": "e2e-mock-tools", "name": "E2E Mock Tools", "context_length": 32000},
]
_counter = itertools.count(1)
_last_chat: dict = {}


def _prompt_tokens(body: dict) -> int:
    """Roughly what a real tokenizer would count for this request."""
    size = len(json.dumps(body.get("messages") or [])) + len(json.dumps(body.get("tools") or []))
    return max(1, size // 4)


def _text_of(content) -> tuple[str, int]:
    """Plain text of a message's content, and how many images it carries."""
    if isinstance(content, str):
        return content, 0
    text, images = [], 0
    for part in content or []:
        if part.get("type") == "text":
            text.append(part.get("text") or "")
        elif part.get("type") == "image_url":
            images += 1
    return "\n".join(text), images


_TOOL_RE = re.compile(r"\[tool:(\w+)(?:\s+(\{.*\}))?\]", re.S)


def _tool_call_for(body: dict) -> tuple[str, str] | None:
    """(name, arguments) when the turn asks for a tool and hasn't had its
    result yet."""
    messages = body.get("messages") or []
    if messages and messages[-1].get("role") == "tool":
        return None
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    m = _TOOL_RE.search(_text_of(last_user.get("content"))[0])
    if not m:
        return None
    return m.group(1), m.group(2) or "{}"


def _editor_ai_reply(system: str, messages: list) -> str | None:
    prompt = next((_text_of(m.get("content"))[0] for m in reversed(messages) if m.get("role") == "user"), "")
    if system.startswith("You fill one column"):
        rows = []
        for line in prompt.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    rows.append(json.loads(line)["row"])
                except (ValueError, KeyError):
                    pass
        return json.dumps({"values": [{"row": r, "value": f"Cat {r}"} for r in rows]})
    if system.startswith("You clean a range"):
        grid = json.loads(prompt[prompt.index("\n[") + 1:]) if "\n[" in prompt else []
        return json.dumps({"cells": [[c.strip().title() if isinstance(c, str) else c for c in row] for row in grid]})
    if system.startswith("You design a spreadsheet"):
        return json.dumps({"title": "E2E budget", "columns": ["Item", "Cost"],
                           "rows": [["Rent", 900], ["Food", 300], ["Total", "=SUM(B2:B3)"]]})
    if system.startswith("You turn the extracted text of a document into clean Markdown"):
        return "# Converted\n\n" + prompt.strip()
    if system.startswith("You draft a slide deck"):
        # Three slides, the last two citing the first source (Stage 12).
        import re

        first = re.search(r'<source id="(S\d+)" name="([^"]*)">', prompt)
        sid = first.group(1) if first else "S1"
        return json.dumps({"slides": [
            {"title": "E2E deck", "bullets": [], "notes": "Welcome.", "sources": []},
            {"title": "What the file says", "bullets": ["First point", "Second point"], "notes": "Walk through it.", "sources": [sid]},
            {"title": "Thanks", "bullets": ["Questions?"], "notes": "Close.", "sources": [sid]},
        ]})
    return None


def _reply_for(body: dict) -> tuple[list[str], float, bool]:
    """Chunks to stream, the delay between them, and whether to cut off."""
    messages = body.get("messages") or []
    system = next((_text_of(m.get("content"))[0] for m in messages if m.get("role") == "system"), "")
    if system.startswith("You generate ultra-concise chat titles"):
        return ["E2E chat"], 0, False
    if system.startswith("You maintain a long-term memory"):
        return ["[]"], 0, False
    if system.startswith("You describe personal photos"):
        return ['{"caption": "A lighthouse on a rocky headland by the sea.", "tags": ["lighthouse", "sea", "rocks"]}'], 0, False
    if system.startswith("You describe images"):
        return ["A small test image."], 0, False
    editor = _editor_ai_reply(system, messages)
    if editor is not None:
        return [editor], 0, False

    if messages and messages[-1].get("role") == "tool":
        result = _text_of(messages[-1].get("content"))[0]
        first = next((ln for ln in result.splitlines() if ln.strip() and not ln.startswith("<")), "")
        return [w + " " for w in f"Tool said: {first.strip()[:200]}".split(" ")], 0.02, False
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    text, images = _text_of(last_user.get("content"))
    if "[slow]" in text:
        words = [f"word{i} " for i in range(1, 41)]
        return words, 0.25, False
    if "[fail]" in text:
        return ["Partial ", "reply ", "before ", "the ", "drop "], 0.1, True
    n = next(_counter)
    seen = f"I can see {images} image{'s' if images != 1 else ''}. " if images else ""
    reply = f"Echo #{n}: {seen}{text.strip()[:200]}"
    return [w + " " for w in reply.split(" ")], 0.02, False


def _embedding(text: str, dim: int = 768) -> list[float]:
    seed = hashlib.sha256(text.encode()).digest()
    vec = [math.sin(seed[i % len(seed)] + i) for i in range(dim)]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class Handler(BaseHTTPRequestHandler):
    # Chunked streaming (see do_POST) needs HTTP/1.1.
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep container logs quiet
        pass

    def _json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json({"object": "list", "data": [{"object": "model", **m} for m in MODELS]})
        if self.path.rstrip("/").endswith("/last-request"):
            return self._json(_last_chat)
        if self.path.rstrip("/") in ("", "/health"):
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("/embeddings"):
            inputs = body.get("input")
            inputs = [inputs] if isinstance(inputs, str) else list(inputs or [])
            return self._json({
                "object": "list",
                "model": body.get("model"),
                "data": [{"object": "embedding", "index": i, "embedding": _embedding(str(t))}
                         for i, t in enumerate(inputs)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            })
        if not self.path.endswith("/chat/completions"):
            return self._json({"error": "not found"}, 404)

        tool_call = _tool_call_for(body) if body.get("tools") else None
        chunks, delay, cut_off = _reply_for(body) if tool_call is None else ([""], 0, False)
        if delay or chunks[0].startswith("Echo"):
            _last_chat.clear()
            _last_chat.update(body)
        model = body.get("model") or MODELS[0]["id"]
        prompt_tokens = _prompt_tokens(body)
        if not body.get("stream"):
            return self._json({
                "id": "e2e", "object": "chat.completion", "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(chunks).strip()},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": len(chunks), "total_tokens": prompt_tokens + len(chunks)},
            })

        # Chunked, so a [fail] reply can stop mid-body without the final
        # chunk: the client sees a dropped connection ("peer closed
        # connection without sending complete message body"), as with a
        # real upstream that dies. A close-delimited stream would read as a
        # normal end.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send(obj) -> None:
            data = obj if isinstance(obj, str) else json.dumps(obj)
            raw = f"data: {data}\n\n".encode()
            self.wfile.write(f"{len(raw):x}\r\n".encode() + raw + b"\r\n")
            self.wfile.flush()

        base = {"id": "e2e", "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
        try:
            send({**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
            if tool_call is not None:
                name, args = tool_call
                send({**base, "choices": [{"index": 0, "delta": {"tool_calls": [{
                    "index": 0, "id": f"call_{next(_counter)}", "type": "function",
                    "function": {"name": name, "arguments": args},
                }]}, "finish_reason": None}]})
                send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
                send("[DONE]")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                self.close_connection = True
                return
            for chunk in chunks:
                send({**base, "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]})
                if delay:
                    time.sleep(delay)
            if cut_off:
                self.close_connection = True
                return
            send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            if (body.get("stream_options") or {}).get("include_usage"):
                send({**base, "choices": [], "usage": {
                    "prompt_tokens": prompt_tokens, "completion_tokens": len(chunks),
                    "total_tokens": prompt_tokens + len(chunks)}})
            send("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the backend stopped listening — that's what Stop does
        self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
