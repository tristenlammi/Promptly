#!/bin/sh
# Put the connector next to the add-on's Dockerfile (its build context).
set -e
cd "$(dirname "$0")"
cp ../connector/promptly_box.py promptly_box/promptly_box.py
echo "promptly_box/ is ready to publish."
