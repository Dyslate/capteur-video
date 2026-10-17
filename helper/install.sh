#!/bin/sh
# Installs the Capteur vidéo local helper on macOS / Linux (needs Python 3.9+).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$DIR/install.py" "$@"
