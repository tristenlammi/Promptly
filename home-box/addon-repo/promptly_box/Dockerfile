ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.20
FROM ${BUILD_FROM}
RUN pip install --no-cache-dir "aiohttp>=3.9,<4"
# Copied in from ../../connector when the add-on is packaged (package.sh).
COPY promptly_box.py /app/promptly_box.py
# Options arrive in /data/options.json; DATA_DIR defaults to /data.
CMD ["python3", "-u", "/app/promptly_box.py"]
