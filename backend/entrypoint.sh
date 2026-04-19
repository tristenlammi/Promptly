#!/bin/sh
set -e

# Run migrations + singleton user provisioning before starting the app.
python -m app.bootstrap

# Hand off to whatever command was passed to the container (CMD in Dockerfile
# or `command:` in docker-compose). Using `exec` ensures signals (SIGTERM from
# docker stop) reach uvicorn directly so graceful shutdown works.
exec "$@"
