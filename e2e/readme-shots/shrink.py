"""Shrink the README screenshots that came out heavy (the ones full of
photographs). Runs where Pillow is: the stack's backend container.

    docker cp docs/screenshots PromptlyShots-Backend:/tmp/shots
    docker exec -i PromptlyShots-Backend python - < e2e/readme-shots/shrink.py
    docker cp PromptlyShots-Backend:/tmp/shots/. docs/screenshots/

Anything over 400 KB is cut to 256 colours, and, if that isn't enough,
scaled down to 1600 px wide first. Flat interface shots are left alone.
"""
from pathlib import Path

from PIL import Image

LIMIT = 400_000
for path in sorted(Path("/tmp/shots").glob("*.png")):
    if path.stat().st_size <= LIMIT or path.name == "readme-banner.png":
        continue
    before = path.stat().st_size
    image = Image.open(path).convert("RGB")
    for width in (image.width, 1600, 1280):
        shot = image if width >= image.width else image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
        shot.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(path, optimize=True)
        if path.stat().st_size <= LIMIT:
            break
    print(f"{path.name}: {before // 1000} KB -> {path.stat().st_size // 1000} KB at {shot.width}px")
