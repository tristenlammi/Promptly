"""Curated manifest of Ollama models surfaced in the Local Models tab.

The goal is a *broad, opinionated* catalog — not a full scrape of
ollama.com/library. We cover every popular family across multiple
sizes so the admin can see hardware-aware recommendations without
having to memorise model tags, and we pair this list with a
"pull-by-name" escape hatch in the UI for anything we don't list.

Each entry declares the approximate VRAM required at the default
quantisation, so the UI can colour a "will this run?" badge:

- green  → VRAM available ≥ required + 2 GB headroom
- amber  → VRAM available ≥ required (tight but will swap)
- red    → VRAM available < required; CPU fallback is possible
           but painfully slow

VRAM numbers are the upstream recommended minimums for Q4 quants,
cross-referenced against ollama.com and the huggingface model
cards. Update them when you bump a tag.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

SizeClass = Literal["tiny", "small", "medium", "large"]
Modality = Literal["text", "vision", "code"]


class LibraryEntry(BaseModel):
    """One curated model in the Local Models library view."""

    name: str  # "llama3.1:8b"
    display_name: str
    family: str
    description: str
    size_class: SizeClass
    parameter_size: str
    context_window: int
    modality: Modality
    # Download size on disk, approximate.
    disk_bytes: int
    # Suggested minimum VRAM (GPU) to run at interactive speed.
    recommended_vram_bytes: int
    # Suggested minimum system RAM for CPU fallback. ``None`` means
    # CPU fallback isn't really usable (e.g. 70B class).
    recommended_ram_bytes: int | None = None
    supports_vision: bool = False
    license: str | None = None


GB = 1024 * 1024 * 1024
MB = 1024 * 1024


LIBRARY: list[LibraryEntry] = [
    # ================================================================
    # Llama 3.x — Meta's flagship open-weights family.
    # ================================================================
    LibraryEntry(
        name="llama3.2:1b",
        display_name="Llama 3.2 1B",
        family="llama",
        description=(
            "Ultra-compact general chat model. Runs comfortably on CPU; "
            "perfect for testing the Local Models pipeline or very small "
            "assistants where speed matters more than raw quality."
        ),
        size_class="tiny",
        parameter_size="1B",
        context_window=128_000,
        modality="text",
        disk_bytes=1 * GB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="Llama 3.2 Community",
    ),
    LibraryEntry(
        name="llama3.2:3b",
        display_name="Llama 3.2 3B",
        family="llama",
        description=(
            "Solid default for mid-range laptops without a discrete GPU. "
            "Noticeably smarter than 1B while still CPU-runnable."
        ),
        size_class="small",
        parameter_size="3B",
        context_window=128_000,
        modality="text",
        disk_bytes=2 * GB,
        recommended_vram_bytes=4 * GB,
        recommended_ram_bytes=8 * GB,
        license="Llama 3.2 Community",
    ),
    LibraryEntry(
        name="llama3.1:8b",
        display_name="Llama 3.1 8B",
        family="llama",
        description=(
            "Recommended starting point for most GPU users. Good general "
            "chat, instruction following, and a 128k context window."
        ),
        size_class="medium",
        parameter_size="8B",
        context_window=128_000,
        modality="text",
        disk_bytes=5 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="Llama 3.1 Community",
    ),
    LibraryEntry(
        name="llama3.3:70b",
        display_name="Llama 3.3 70B",
        family="llama",
        description=(
            "Latest 70B — Meta's current frontier open model. Matches "
            "many paid APIs on reasoning and writing. Workstation GPU "
            "(48 GB VRAM) or multi-GPU host required."
        ),
        size_class="large",
        parameter_size="70B",
        context_window=128_000,
        modality="text",
        disk_bytes=43 * GB,
        recommended_vram_bytes=48 * GB,
        recommended_ram_bytes=None,
        license="Llama 3.3 Community",
    ),
    # ================================================================
    # Qwen 2.5 — Alibaba's strong multilingual family.
    # ================================================================
    LibraryEntry(
        name="qwen2.5:0.5b",
        display_name="Qwen 2.5 0.5B",
        family="qwen",
        description=(
            "Tiny instruct model — useful for embedding-style tasks, "
            "toy demos, or stress-testing the local pipeline."
        ),
        size_class="tiny",
        parameter_size="0.5B",
        context_window=32_000,
        modality="text",
        disk_bytes=400 * MB,
        recommended_vram_bytes=1 * GB,
        recommended_ram_bytes=2 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:1.5b",
        display_name="Qwen 2.5 1.5B",
        family="qwen",
        description=(
            "Small, capable chat model. Runs on laptops; good balance of "
            "quality and speed for low-resource hardware."
        ),
        size_class="tiny",
        parameter_size="1.5B",
        context_window=32_000,
        modality="text",
        disk_bytes=1 * GB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:3b",
        display_name="Qwen 2.5 3B",
        family="qwen",
        description=(
            "Compact, strong multilingual chat. Feels noticeably "
            "smarter than other 3B-class models."
        ),
        size_class="small",
        parameter_size="3B",
        context_window=32_000,
        modality="text",
        disk_bytes=2 * GB,
        recommended_vram_bytes=4 * GB,
        recommended_ram_bytes=8 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:7b",
        display_name="Qwen 2.5 7B",
        family="qwen",
        description=(
            "Strong multilingual chat with good reasoning. Pairs well "
            "with the coder variant for engineering workflows."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=128_000,
        modality="text",
        disk_bytes=5 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:14b",
        display_name="Qwen 2.5 14B",
        family="qwen",
        description=(
            "Sweet spot between 7B speed and 32B quality. Requires a "
            "GPU with ≥16 GB VRAM for comfortable interactive speed."
        ),
        size_class="medium",
        parameter_size="14B",
        context_window=128_000,
        modality="text",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:32b",
        display_name="Qwen 2.5 32B",
        family="qwen",
        description=(
            "Near-frontier open model, half the VRAM of 70B-class. "
            "Excellent reasoning; comfortable on a 24 GB GPU."
        ),
        size_class="large",
        parameter_size="32B",
        context_window=128_000,
        modality="text",
        disk_bytes=20 * GB,
        recommended_vram_bytes=24 * GB,
        recommended_ram_bytes=64 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5:72b",
        display_name="Qwen 2.5 72B",
        family="qwen",
        description=(
            "Top of the Qwen line — competitive with Llama 3.x 70B. "
            "Needs 48 GB+ VRAM for smooth interactive use."
        ),
        size_class="large",
        parameter_size="72B",
        context_window=128_000,
        modality="text",
        disk_bytes=45 * GB,
        recommended_vram_bytes=48 * GB,
        recommended_ram_bytes=None,
        license="Qwen License",
    ),
    # ================================================================
    # Gemma 2 — Google's open family.
    # ================================================================
    LibraryEntry(
        name="gemma2:2b",
        display_name="Gemma 2 2B",
        family="gemma",
        description=(
            "Google's compact instruct model. Punches above its weight "
            "on short-form tasks; great CPU-runnable option."
        ),
        size_class="tiny",
        parameter_size="2B",
        context_window=8192,
        modality="text",
        disk_bytes=2 * GB,
        recommended_vram_bytes=3 * GB,
        recommended_ram_bytes=6 * GB,
        license="Gemma Terms",
    ),
    LibraryEntry(
        name="gemma2:9b",
        display_name="Gemma 2 9B",
        family="gemma",
        description=(
            "Strong general chat with distinct, concise style. Good "
            "alternative voice to Llama/Qwen in the same size tier."
        ),
        size_class="medium",
        parameter_size="9B",
        context_window=8192,
        modality="text",
        disk_bytes=6 * GB,
        recommended_vram_bytes=10 * GB,
        recommended_ram_bytes=16 * GB,
        license="Gemma Terms",
    ),
    LibraryEntry(
        name="gemma2:27b",
        display_name="Gemma 2 27B",
        family="gemma",
        description=(
            "High-quality 27B — strong writing and reasoning. Fits "
            "comfortably on a 24 GB GPU at Q4."
        ),
        size_class="large",
        parameter_size="27B",
        context_window=8192,
        modality="text",
        disk_bytes=16 * GB,
        recommended_vram_bytes=24 * GB,
        recommended_ram_bytes=48 * GB,
        license="Gemma Terms",
    ),
    # ================================================================
    # Mistral / Mixtral — open weights from Mistral AI.
    # ================================================================
    LibraryEntry(
        name="mistral:7b",
        display_name="Mistral 7B",
        family="mistral",
        description=(
            "The original open-weights workhorse. Fast, reliable, broadly "
            "compatible with the rest of the Mistral toolchain."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=32_000,
        modality="text",
        disk_bytes=4 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="mistral-nemo:12b",
        display_name="Mistral Nemo 12B",
        family="mistral",
        description=(
            "Mistral × NVIDIA collab — 128k context and strong multi-"
            "lingual performance. Good step-up from 7B."
        ),
        size_class="medium",
        parameter_size="12B",
        context_window=128_000,
        modality="text",
        disk_bytes=7 * GB,
        recommended_vram_bytes=12 * GB,
        recommended_ram_bytes=24 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="mixtral:8x7b",
        display_name="Mixtral 8x7B",
        family="mistral",
        description=(
            "Sparse mixture-of-experts — 47B total but only ~13B active "
            "per token. High quality at moderate latency on 24 GB GPUs."
        ),
        size_class="large",
        parameter_size="47B (MoE)",
        context_window=32_000,
        modality="text",
        disk_bytes=26 * GB,
        recommended_vram_bytes=28 * GB,
        recommended_ram_bytes=64 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="mixtral:8x22b",
        display_name="Mixtral 8x22B",
        family="mistral",
        description=(
            "Much larger MoE — 141B total, ~39B active. Requires a very "
            "large GPU or multi-GPU host."
        ),
        size_class="large",
        parameter_size="141B (MoE)",
        context_window=64_000,
        modality="text",
        disk_bytes=80 * GB,
        recommended_vram_bytes=96 * GB,
        recommended_ram_bytes=None,
        license="Apache 2.0",
    ),
    # ================================================================
    # Phi — Microsoft's small-but-strong series.
    # ================================================================
    LibraryEntry(
        name="phi3:mini",
        display_name="Phi 3 Mini 3.8B",
        family="phi",
        description=(
            "Microsoft's compact instruct model. Excellent quality at "
            "its size; a great CPU-runnable default."
        ),
        size_class="small",
        parameter_size="3.8B",
        context_window=128_000,
        modality="text",
        disk_bytes=2 * GB,
        recommended_vram_bytes=4 * GB,
        recommended_ram_bytes=8 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="phi3:medium",
        display_name="Phi 3 Medium 14B",
        family="phi",
        description=(
            "Larger Phi 3 — competitive reasoning for its size. Needs "
            "a 16 GB GPU for comfortable interactive speed."
        ),
        size_class="medium",
        parameter_size="14B",
        context_window=128_000,
        modality="text",
        disk_bytes=8 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="phi4:14b",
        display_name="Phi 4 14B",
        family="phi",
        description=(
            "Newest Phi release — strong STEM reasoning. Fits on a "
            "16 GB GPU and punches well above its parameter count."
        ),
        size_class="medium",
        parameter_size="14B",
        context_window=16_000,
        modality="text",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="MIT",
    ),
    # ================================================================
    # DeepSeek — strong reasoning + coding.
    # ================================================================
    LibraryEntry(
        name="deepseek-r1:1.5b",
        display_name="DeepSeek R1 1.5B",
        family="deepseek",
        description=(
            "Distilled reasoning model — emits explicit thinking steps. "
            "Tiny enough for CPU; good intro to reasoning workflows."
        ),
        size_class="tiny",
        parameter_size="1.5B",
        context_window=128_000,
        modality="text",
        disk_bytes=1 * GB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="deepseek-r1:7b",
        display_name="DeepSeek R1 7B",
        family="deepseek",
        description=(
            "Distilled reasoning model based on Qwen. Strong math and "
            "coding at 7B size."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=128_000,
        modality="text",
        disk_bytes=5 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="deepseek-r1:14b",
        display_name="DeepSeek R1 14B",
        family="deepseek",
        description=(
            "Mid-size distilled reasoning model. Noticeable quality "
            "bump over 7B for multi-step reasoning."
        ),
        size_class="medium",
        parameter_size="14B",
        context_window=128_000,
        modality="text",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="deepseek-r1:32b",
        display_name="DeepSeek R1 32B",
        family="deepseek",
        description=(
            "Near-frontier reasoning at 32B. Fits on a 24 GB GPU; "
            "excellent for research-style, multi-step tasks."
        ),
        size_class="large",
        parameter_size="32B",
        context_window=128_000,
        modality="text",
        disk_bytes=20 * GB,
        recommended_vram_bytes=24 * GB,
        recommended_ram_bytes=64 * GB,
        license="MIT",
    ),
    LibraryEntry(
        name="deepseek-r1:70b",
        display_name="DeepSeek R1 70B",
        family="deepseek",
        description=(
            "Largest distilled R1 variant. Competitive with closed "
            "reasoning models; needs 48 GB+ VRAM."
        ),
        size_class="large",
        parameter_size="70B",
        context_window=128_000,
        modality="text",
        disk_bytes=43 * GB,
        recommended_vram_bytes=48 * GB,
        recommended_ram_bytes=None,
        license="MIT",
    ),
    # ================================================================
    # Code-specialist models.
    # ================================================================
    LibraryEntry(
        name="qwen2.5-coder:1.5b",
        display_name="Qwen 2.5 Coder 1.5B",
        family="qwen",
        description=(
            "Tiny code-specialist — fill-in-middle, code explanation. "
            "Useful as a fast tab-complete model."
        ),
        size_class="tiny",
        parameter_size="1.5B",
        context_window=32_000,
        modality="code",
        disk_bytes=1 * GB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5-coder:7b",
        display_name="Qwen 2.5 Coder 7B",
        family="qwen",
        description=(
            "Strong code model — fill-in-middle, refactoring, code "
            "explanation. Preferred for engineering-focused assistants."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=128_000,
        modality="code",
        disk_bytes=5 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5-coder:14b",
        display_name="Qwen 2.5 Coder 14B",
        family="qwen",
        description=(
            "Larger Qwen coder — best-in-class open code completion "
            "for its size. 16 GB GPU recommended."
        ),
        size_class="medium",
        parameter_size="14B",
        context_window=128_000,
        modality="code",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="qwen2.5-coder:32b",
        display_name="Qwen 2.5 Coder 32B",
        family="qwen",
        description=(
            "Frontier-class open code model. Rivals paid coding assistants. "
            "Needs a 24 GB GPU."
        ),
        size_class="large",
        parameter_size="32B",
        context_window=128_000,
        modality="code",
        disk_bytes=20 * GB,
        recommended_vram_bytes=24 * GB,
        recommended_ram_bytes=64 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="deepseek-coder-v2:16b",
        display_name="DeepSeek Coder V2 16B",
        family="deepseek",
        description=(
            "MoE code model — 16B total, 2.4B active per token, so "
            "inference is surprisingly fast. Excellent code quality."
        ),
        size_class="medium",
        parameter_size="16B (MoE)",
        context_window=128_000,
        modality="code",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="DeepSeek License",
    ),
    LibraryEntry(
        name="codellama:7b",
        display_name="Code Llama 7B",
        family="codellama",
        description=(
            "Meta's original code model. Older but stable and widely "
            "tested — a solid fallback if newer models misbehave."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=16_000,
        modality="code",
        disk_bytes=4 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        license="Llama 2 Community",
    ),
    LibraryEntry(
        name="starcoder2:3b",
        display_name="StarCoder 2 3B",
        family="starcoder",
        description=(
            "BigCode's permissively licensed code model. Compact "
            "enough for CPU-only workflows."
        ),
        size_class="small",
        parameter_size="3B",
        context_window=16_000,
        modality="code",
        disk_bytes=2 * GB,
        recommended_vram_bytes=4 * GB,
        recommended_ram_bytes=8 * GB,
        license="BigCode OpenRAIL-M",
    ),
    LibraryEntry(
        name="starcoder2:15b",
        display_name="StarCoder 2 15B",
        family="starcoder",
        description=(
            "Largest StarCoder 2 — trained on permissively-licensed "
            "code only, making it attractive for commercial use."
        ),
        size_class="medium",
        parameter_size="15B",
        context_window=16_000,
        modality="code",
        disk_bytes=9 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        license="BigCode OpenRAIL-M",
    ),
    # ================================================================
    # Vision (multimodal) models.
    # ================================================================
    LibraryEntry(
        name="moondream:1.8b",
        display_name="Moondream 2 1.8B",
        family="moondream",
        description=(
            "Tiny vision-language model. Runs on CPU/low-end GPUs; "
            "great for lightweight image Q&A."
        ),
        size_class="tiny",
        parameter_size="1.8B",
        context_window=2048,
        modality="vision",
        disk_bytes=2 * GB,
        recommended_vram_bytes=3 * GB,
        recommended_ram_bytes=6 * GB,
        supports_vision=True,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="llava:7b",
        display_name="LLaVA 7B",
        family="llava",
        description=(
            "Classic open vision-language model. Good balance of "
            "quality and speed for image understanding tasks."
        ),
        size_class="medium",
        parameter_size="7B",
        context_window=4096,
        modality="vision",
        disk_bytes=5 * GB,
        recommended_vram_bytes=8 * GB,
        recommended_ram_bytes=16 * GB,
        supports_vision=True,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="llava:13b",
        display_name="LLaVA 13B",
        family="llava",
        description=(
            "Larger LLaVA — noticeably better scene understanding "
            "and OCR. Needs a 16 GB GPU."
        ),
        size_class="medium",
        parameter_size="13B",
        context_window=4096,
        modality="vision",
        disk_bytes=8 * GB,
        recommended_vram_bytes=16 * GB,
        recommended_ram_bytes=32 * GB,
        supports_vision=True,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="llama3.2-vision:11b",
        display_name="Llama 3.2 Vision 11B",
        family="llama",
        description=(
            "Meta's multimodal Llama. Strong at reading screenshots, "
            "charts, and photos."
        ),
        size_class="medium",
        parameter_size="11B",
        context_window=128_000,
        modality="vision",
        disk_bytes=8 * GB,
        recommended_vram_bytes=12 * GB,
        recommended_ram_bytes=24 * GB,
        supports_vision=True,
        license="Llama 3.2 Community",
    ),
    LibraryEntry(
        name="llama3.2-vision:90b",
        display_name="Llama 3.2 Vision 90B",
        family="llama",
        description=(
            "Largest open multimodal model from Meta. State-of-the-art "
            "vision reasoning; requires a workstation GPU."
        ),
        size_class="large",
        parameter_size="90B",
        context_window=128_000,
        modality="vision",
        disk_bytes=55 * GB,
        recommended_vram_bytes=64 * GB,
        recommended_ram_bytes=None,
        supports_vision=True,
        license="Llama 3.2 Community",
    ),
    # ================================================================
    # Small / tiny experiments.
    # ================================================================
    LibraryEntry(
        name="tinyllama:1.1b",
        display_name="TinyLlama 1.1B",
        family="tinyllama",
        description=(
            "Lightweight Llama-architecture chat model. Useful as a "
            "load-test target or ultra-low-latency autocomplete."
        ),
        size_class="tiny",
        parameter_size="1.1B",
        context_window=2048,
        modality="text",
        disk_bytes=700 * MB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="orca-mini:3b",
        display_name="Orca Mini 3B",
        family="orca",
        description=(
            "Small instruct-tuned model. Friendly tone, good for "
            "general Q&A on modest hardware."
        ),
        size_class="small",
        parameter_size="3B",
        context_window=4096,
        modality="text",
        disk_bytes=2 * GB,
        recommended_vram_bytes=4 * GB,
        recommended_ram_bytes=8 * GB,
        license="Llama 2 Community",
    ),
    LibraryEntry(
        name="dolphin-mixtral:8x7b",
        display_name="Dolphin Mixtral 8x7B",
        family="dolphin",
        description=(
            "Uncensored fine-tune of Mixtral. Useful when you want "
            "the MoE quality without built-in refusals."
        ),
        size_class="large",
        parameter_size="47B (MoE)",
        context_window=32_000,
        modality="text",
        disk_bytes=26 * GB,
        recommended_vram_bytes=28 * GB,
        recommended_ram_bytes=64 * GB,
        license="Apache 2.0",
    ),
    # ================================================================
    # Embeddings — called out so admins can reinstall if nuked.
    # ================================================================
    LibraryEntry(
        name="nomic-embed-text",
        display_name="Nomic Embed Text",
        family="nomic",
        description=(
            "768-dim text embedding model used by Custom Models' RAG "
            "pipeline. Auto-pulled on first boot; listed here so you "
            "can reinstall it if it gets deleted."
        ),
        size_class="tiny",
        parameter_size="137M",
        context_window=8192,
        modality="text",
        disk_bytes=270 * MB,
        recommended_vram_bytes=1 * GB,
        recommended_ram_bytes=2 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="mxbai-embed-large",
        display_name="MixedBread Embed Large",
        family="mixedbread",
        description=(
            "1024-dim embedding model — strong retrieval quality. "
            "Alternative to Nomic if you want a bigger embedding space."
        ),
        size_class="tiny",
        parameter_size="335M",
        context_window=512,
        modality="text",
        disk_bytes=670 * MB,
        recommended_vram_bytes=1 * GB,
        recommended_ram_bytes=2 * GB,
        license="Apache 2.0",
    ),
    LibraryEntry(
        name="bge-m3",
        display_name="BGE M3",
        family="bge",
        description=(
            "Multilingual embedding model (1024-dim). Supports 100+ "
            "languages, useful for multilingual RAG libraries."
        ),
        size_class="tiny",
        parameter_size="567M",
        context_window=8192,
        modality="text",
        disk_bytes=1200 * MB,
        recommended_vram_bytes=2 * GB,
        recommended_ram_bytes=4 * GB,
        license="MIT",
    ),
]
