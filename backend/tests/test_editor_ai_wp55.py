"""AI in the editors (WP-5.5): the Ask panel, Sheets AI (fill / clean /
build — previews only), and Convert with AI (photo or PDF → Sheet / Doc).
The model is stubbed; what's tested is what Promptly sends and does."""
from __future__ import annotations

import io
import json
import uuid

import pytest

from tests.test_drive_index_wp51 import _auth, _upload, _user, client  # noqa: F401 — fixtures


@pytest.fixture
def model(monkeypatch):
    """A fake model: ``replies`` maps a system-prompt fragment to the answer;
    every call is recorded."""
    from app.models_config.provider import model_router

    calls: list[dict] = []
    replies: dict[str, str] = {}

    async def fake_stream(**kw):
        calls.append(kw)
        system = kw.get("system") or ""
        for key, answer in replies.items():
            if key in system:
                yield answer
                return
        yield "(no reply set)"

    monkeypatch.setattr(model_router, "stream_chat", fake_stream)
    return {"calls": calls, "replies": replies}


def _m(provider):
    return {"provider_id": str(provider.id), "model_id": "test-model"}


def _text_of(msg) -> str:
    c = msg.content
    if isinstance(c, str):
        return c
    return " ".join(getattr(p, "text", "") for p in c)


def test_json_is_found_in_fences_and_prose():
    from app.files.editor_ai import EditorAiError, parse_json

    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('Sure! Here it is: {"a": [1, 2]} hope that helps') == {"a": [1, 2]}
    with pytest.raises(EditorAiError):
        parse_json("no json here")
    with pytest.raises(EditorAiError):
        parse_json('{"a": [1, 2')


# ---------------------------------------------------------------- ask


@pytest.mark.asyncio
async def test_ask_answers_from_the_file_with_the_selection_and_history(client, db, user, provider, model):  # noqa: F811
    model["replies"]["You help someone with a file"] = "The deposit is **two months** rent."
    f = await _upload(client, user, "lease.txt", b"The tenant pays a deposit of two months' rent.")
    r = await client.post(f"/api/files/{f['id']}/ai/ask", headers=_auth(user), json={
        **_m(provider), "question": "How big is the deposit?", "selection": "deposit of two months",
        "history": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"answer": "The deposit is **two months** rent.", "truncated": False}
    sent = model["calls"][0]
    assert "“lease.txt”" in sent["system"]
    texts = [_text_of(m) for m in sent["messages"]]
    assert "deposit of two months' rent" in texts[0] and "<selection>" in texts[0]
    assert texts[-3:] == ["hi", "hello", "How big is the deposit?"]

    stranger = await _user(db, "sam")
    r = await client.post(f"/api/files/{f['id']}/ai/ask", headers=_auth(stranger),
                          json={**_m(provider), "question": "?"})
    assert r.status_code == 404
    r = await client.post(f"/api/files/{f['id']}/ai/ask", headers=_auth(user), json={"question": "?"})
    assert r.status_code == 400  # no model picked


# ---------------------------------------------------------------- sheets


@pytest.mark.asyncio
async def test_fill_a_column_returns_one_value_per_row_in_order(client, db, user, provider, model):  # noqa: F811
    model["replies"]["You fill one column"] = json.dumps({"values": [
        {"row": 3, "value": "Transport"}, {"row": 2, "value": "Food"}, {"row": 9, "value": "stray"},
        {"row": 4, "value": ""},
    ]})
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Spend"}, headers=_auth(user))
    sid = r.json()["id"]
    body = {**_m(provider), "mode": "fill", "instruction": "category", "target": "Category", "rows": [
        {"row": 2, "values": {"Item": "Groceries", "Cost": 54.2}},
        {"row": 3, "values": {"Item": "Train ticket", "Cost": 12}},
        {"row": 4, "values": {"Item": "???", "Cost": 1}},
    ]}
    r = await client.post(f"/api/files/{sid}/ai/sheet", headers=_auth(user), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["values"] == [{"row": 2, "value": "Food"}, {"row": 3, "value": "Transport"}]
    prompt = _text_of(model["calls"][0]["messages"][0])
    assert "Target column: Category" in prompt and '"Item": "Train ticket"' in prompt and '"Cost": "54.2"' in prompt


@pytest.mark.asyncio
async def test_clean_keeps_the_shape_or_refuses(client, db, user, provider, model):  # noqa: F811
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Import"}, headers=_auth(user))
    sid = r.json()["id"]
    cells = [["  alice smith", "2024-1-5"], ["BOB JONES ", "05/01/2024"]]
    model["replies"]["You clean a range"] = json.dumps({"cells": [["Alice Smith", "2024-01-05"], ["Bob Jones", "2024-01-05"]]})
    r = await client.post(f"/api/files/{sid}/ai/sheet", headers=_auth(user),
                          json={**_m(provider), "mode": "clean", "cells": cells})
    assert r.status_code == 200, r.text
    assert r.json()["cells"] == [["Alice Smith", "2024-01-05"], ["Bob Jones", "2024-01-05"]] and r.json()["changed"] == 4
    model["replies"]["You clean a range"] = json.dumps({"cells": [["Alice Smith"]]})
    r = await client.post(f"/api/files/{sid}/ai/sheet", headers=_auth(user),
                          json={**_m(provider), "mode": "clean", "cells": cells})
    assert r.status_code == 422 and "shape" in r.json()["detail"]
    r = await client.post(f"/api/files/{sid}/ai/sheet", headers=_auth(user),
                          json={**_m(provider), "mode": "clean", "cells": [["x"] * 50] * 50})
    assert r.status_code == 422 and "2,000" in r.json()["detail"]


@pytest.mark.asyncio
async def test_build_designs_columns_rows_and_formulas(client, db, user, provider, model):  # noqa: F811
    model["replies"]["You design a spreadsheet"] = "```json\n" + json.dumps({
        "title": "Trip budget", "columns": ["Item", "Cost"],
        "rows": [["Flights", "420"], ["Hotel", 300.5], ["Total", "=SUM(B2:B3)"], ["Extra"]],
    }) + "\n```"
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Trip"}, headers=_auth(user))
    sid = r.json()["id"]
    r = await client.post(f"/api/files/{sid}/ai/sheet", headers=_auth(user),
                          json={**_m(provider), "mode": "build", "instruction": "a trip budget"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["title"] == "Trip budget" and out["columns"] == ["Item", "Cost"]
    assert out["table"] == [["Flights", 420], ["Hotel", 300.5], ["Total", "=SUM(B2:B3)"], ["Extra", ""]]


# ---------------------------------------------------------------- convert


def _text_pdf(lines: list[str]) -> bytes:
    """A one-page PDF with a real text layer."""
    stream = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({ln}) '" for ln in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


def _png() -> bytes:
    from PIL import Image

    import random

    rnd = random.Random(7)
    img = Image.new("RGB", (320, 200))
    img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(320 * 200)])
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_a_photo_of_a_table_becomes_a_sheet_beside_it(client, db, user, provider, model, monkeypatch):  # noqa: F811
    from app.files import editor_ai
    from app.files.models import FileFolder, UserFile
    from app.files.office import content_for_shell

    receipts = FileFolder(user_id=user.id, name="Receipts")
    db.add(receipts)
    await db.commit()
    photo = await _upload(client, user, "receipt-scan.png", _png(), folder_id=receipts.id, mime="image/png")

    # No vision model set up → a clear message, nothing made.
    async def no_relay(db, user):  # noqa: ARG001
        return None

    monkeypatch.setattr(editor_ai, "_relay", no_relay)
    r = await client.post("/api/files/office/convert-ai", headers=_auth(user),
                          json={"source_file_id": photo["id"], "to": "sheet"})
    assert r.status_code == 422 and "Vision relay" in r.json()["detail"]

    async def relay(db, user):  # noqa: ARG001
        return provider, "vision-model"

    monkeypatch.setattr(editor_ai, "_relay", relay)
    model["replies"]["You transcribe documents"] = json.dumps({"tables": [
        {"name": "Items", "rows": [["Item", "Price"], ["Milk", "1.20"], ["Bread", "2"], ["Code", "007"]]},
    ]})
    r = await client.post("/api/files/office/convert-ai", headers=_auth(user),
                          json={"source_file_id": photo["id"], "to": "sheet"})
    assert r.status_code == 201, r.text
    made = r.json()["file"]
    assert made["filename"] == "receipt-scan.sheet" and made["folder_id"] == str(receipts.id)
    sent = model["calls"][-1]
    assert sent["model_id"] == "vision-model" and any(type(p).__name__ == "ImagePart" for p in sent["messages"][0].content)
    row = await db.get(UserFile, uuid.UUID(made["id"]))
    assert str(row.source_file_id) == photo["id"]
    tabs = (await content_for_shell(db, row)).data
    cells = {(c["r"], c["c"]): c["v"] for c in tabs[0]["celldata"]}
    assert tabs[0]["name"] == "Items" and cells[(0, 0)]["bl"] == 1
    assert cells[(1, 1)]["v"] == 1.2 and cells[(2, 1)]["v"] == 2 and cells[(3, 1)]["v"] == "007"  # codes stay text
    assert "Milk" in (row.content_text or "") or "Milk" in json.dumps(tabs)


@pytest.mark.asyncio
async def test_pages_of_one_table_join_and_a_text_pdf_needs_no_vision(client, db, user, provider, model, monkeypatch):  # noqa: F811
    from app.files.editor_ai import _tables_to_tabs

    tabs = _tables_to_tabs([
        {"name": "Ledger", "rows": [["Date", "Amount"], ["1 May", "10"]]},
        {"name": "Ledger (cont.)", "rows": [["Date", "Amount"], ["2 May", "20"]]},
        {"name": "Notes", "rows": [["Note"], ["paid"]]},
    ])
    assert [t["name"] for t in tabs] == ["Ledger", "Notes"]
    assert len([c for c in tabs[0]["celldata"] if c["c"] == 0]) == 3

    from app.files import editor_ai

    async def no_relay(db, user):  # noqa: ARG001
        return None

    monkeypatch.setattr(editor_ai, "_relay", no_relay)
    pdf = await _upload(client, user, "letter.pdf", _text_pdf(["Dear Sam,", "Thank you for the quote of 340 pounds.",
                                                               "Yours sincerely, Alex"]), mime="application/pdf")
    model["replies"]["clean Markdown"] = "```markdown\n# Letter\n\nDear Sam,\n\nThank you for the quote of **340 pounds**.\n\nYours sincerely, Alex\n```"
    r = await client.post("/api/files/office/convert-ai", headers=_auth(user),
                          json={"source_file_id": pdf["id"], "to": "document", **_m(provider)})
    assert r.status_code == 201, r.text
    made = r.json()
    assert made["file"]["filename"] == "letter.html" and "Read from the PDF's text." in made["notes"]
    assert "Thank you for the quote" in _text_of(model["calls"][-1]["messages"][0])
    from app.files.models import UserFile

    doc = await db.get(UserFile, uuid.UUID(made["file"]["id"]))
    assert "340 pounds" in (doc.content_text or "") and "Dear Sam" in doc.content_text

    txt = await _upload(client, user, "notes.txt", b"hello")
    r = await client.post("/api/files/office/convert-ai", headers=_auth(user),
                          json={"source_file_id": txt["id"], "to": "sheet", **_m(provider)})
    assert r.status_code == 422 and "image or a PDF" in r.json()["detail"]
