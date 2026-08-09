"""What ``code_interpreter`` tells the model about its input files.

The failure this closes was quiet and blamed the wrong party. Files that
couldn't be read were skipped with a bare ``continue`` (the comment claimed
"the model still sees what loaded via stdout" — nothing ever printed it),
and the sandbox ``break``ed past its total-byte ceiling, dropping that file
*and every remaining one*. The script's ``pd.read_csv('sales.csv')`` then
raised FileNotFoundError, and the model told the user their file didn't
exist — while the attachment chip sat visible in the thread.

A missing file and a typo'd filename produce the identical traceback, so
the only way the model can tell them apart is if we say which files were
actually in the working directory. These tests pin that we do.
"""
from __future__ import annotations

from app.chat.tools.code_interpreter import CodeInterpreterTool

TOOL = CodeInterpreterTool()


def feedback(**kw) -> str:
    base = dict(
        exit_code=0,
        timed_out=False,
        stdout="",
        stderr="",
        produced_names=[],
    )
    base.update(kw)
    return TOOL._build_feedback(**base)


def test_loaded_inputs_are_listed():
    out = feedback(loaded_inputs=["sales.csv", "notes.txt"])
    assert "sales.csv" in out and "notes.txt" in out
    assert "working directory" in out


def test_dropped_inputs_are_reported_with_their_reason():
    out = feedback(
        loaded_inputs=["small.csv"],
        dropped_inputs=["huge.parquet (would exceed the 64 MB total input limit)"],
    )
    assert "huge.parquet" in out
    assert "64 MB" in out
    # The model must be told not to retry, or it burns hops re-reading a
    # file that was never there.
    assert "not retry" in out.lower() or "do not retry" in out.lower()


def test_the_model_is_told_when_nothing_loaded():
    """The worst case: every input dropped. Silence here is what produced
    "your file doesn't exist"."""
    out = feedback(dropped_inputs=["data.csv (File 'data.csv' is missing on disk)"])
    assert "No input files were loaded" in out
    assert "data.csv" in out


def test_no_input_noise_when_there_were_no_inputs():
    """A plain calculation shouldn't gain a manifest section."""
    out = feedback(stdout="42\n")
    assert "working directory" not in out
    assert "could NOT be loaded" not in out


def test_truncated_stdout_is_flagged_as_incomplete():
    """The sandbox computes these flags and they used to be discarded, so a
    clipped ``df.to_string()`` looked like a complete table and the model
    answered from a partial one."""
    out = feedback(stdout="row1\nrow2\n", stdout_truncated=True)
    assert "INCOMPLETE" in out
    assert "truncated by the sandbox" in out


def test_untruncated_stdout_carries_no_warning():
    out = feedback(stdout="row1\nrow2\n", stdout_truncated=False)
    assert "INCOMPLETE" not in out


def test_truncated_stderr_is_flagged():
    out = feedback(stderr="Traceback…\n", stderr_truncated=True)
    assert "stderr was truncated" in out


def test_manifest_precedes_the_output():
    """Ordering matters: the model reads top-down, and a FileNotFoundError
    in stdout is only interpretable once it knows what was present."""
    out = feedback(
        loaded_inputs=["a.csv"],
        stdout="FileNotFoundError: b.csv",
    )
    assert out.index("working directory") < out.index("stdout:")
