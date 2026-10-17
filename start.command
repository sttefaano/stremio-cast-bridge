#!/bin/zsh
set -eu
cd "${0:A:h}"
if [[ -x .venv/bin/python ]]; then
  bridge_python=.venv/bin/python
elif [[ -x /Users/stefano/.hermes/cache/scratch/stremio-cast-venv/bin/python ]]; then
  bridge_python=/Users/stefano/.hermes/cache/scratch/stremio-cast-venv/bin/python
else
  print -u2 'Falta un entorno Python con requirements.txt. No se instala nada automáticamente.'
  exit 1
fi
exec "$bridge_python" -B bridge.py "$@"
