#!/bin/bash
# ChatMatrix Reader - macOS launcher (double-click, or: bash run.command). Creates .venv on first run and installs
# what is needed (numpy, pyobjc) - only here, never on Windows. Needs Python 3 with Tk (python.org installer is fine).
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
    PY=""
    for c in python3.15 python3.14 python3.13 python3.12 python3.11 python3; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c "import tkinter" >/dev/null 2>&1; then PY="$c"; break; fi
    done
    if [ -z "$PY" ]; then
        echo "Python 3 (with Tk) was not found. Install it from https://www.python.org/downloads/macos/ and run this again."
        read -r -p "Press Enter to close" _; exit 1
    fi
    echo "Creating .venv with $($PY --version) ..."
    "$PY" -m venv .venv || { read -r -p "Press Enter to close" _; exit 1; }
fi

if [ ! -f .venv/.deps_ok ] || [ requirements-mac.txt -nt .venv/.deps_ok ]; then
    echo "Installing requirements (first run only) ..."
    .venv/bin/python -m pip install --upgrade pip >/dev/null 2>&1
    if .venv/bin/python -m pip install -r requirements-mac.txt; then touch .venv/.deps_ok
    else echo "Install failed."; read -r -p "Press Enter to close" _; exit 1; fi
fi

exec .venv/bin/python app/app.py
