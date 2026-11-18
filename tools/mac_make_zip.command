#!/bin/bash
# Makes the release zip of the Mac program: ChatMatrixReader-v<version>-macos-arm64.zip, with the same files as the Windows zip (release/files-windows.txt)
# around the app: the app (made by tools/mac_make_app.command), app/, locale/, Glossary.sample.txt, fonts/README.txt, README.md, LICENSE, the notices of the
# libraries and BUILD-INFO.txt. The program reads app/ and locale/ from the folder next to the .app, so they must be in the zip.
# Run it with:   bash tools/mac_make_zip.command      (from the project folder, after the build and tools/mac_make_app.command)
cd "$(dirname "$0")/.." || exit 1
APP="ChatMatrix Reader.app"
[ -d "$APP" ] || { echo "$APP was not found: run  bash tools/mac_make_app.command  first (after cargo build --release)."; exit 1; }

VERSION=$(sed -n "s/^export const VERSION = '\([^']*\)'.*/\1/p" app/core/version.js)
PRE=$(sed -n "s/^export const PRERELEASE = '\([^']*\)'.*/\1/p" app/core/version.js)
[ -n "$VERSION" ] || { echo "The version was not found in app/core/version.js"; exit 1; }
[ -z "$PRE" ] || { echo "app/core/version.js says PRERELEASE = '$PRE': a release needs ''. (git pull the released commit)"; exit 1; }
NAME="ChatMatrixReader-v$VERSION-macos-arm64"
OUT="release-mac"
rm -rf "$OUT"; mkdir -p "$OUT/ChatMatrixReader/fonts"

python3 tools/make_notices.py --target aarch64-apple-darwin --out "$OUT/ChatMatrixReader/THIRD-PARTY-NOTICES.txt" || exit 1
ditto "$APP" "$OUT/ChatMatrixReader/$APP"                  # (ditto keeps the signature of the app)
cp -R app locale "$OUT/ChatMatrixReader/"
cp Glossary.sample.txt README.md LICENSE "$OUT/ChatMatrixReader/"
cp fonts/README.txt "$OUT/ChatMatrixReader/fonts/"

COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
DIRTY=""; [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] && DIRTY=" + changes that are not committed"
{
  echo "ChatMatrix Reader $VERSION for macOS (Apple silicon, macOS 13 or later)"
  echo "source : https://github.com/blackmass/ChatMatrixReader  commit $COMMIT$DIRTY"
  echo "made   : $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "tools  : $(rustc --version 2>/dev/null) / $(sw_vers -productVersion 2>/dev/null)"
  echo "The app is signed with a certificate of its own (not Apple's): the first start shows a warning (right-click > Open)."
} > "$OUT/ChatMatrixReader/BUILD-INFO.txt"

ditto -c -k --keepParent "$OUT/ChatMatrixReader" "$NAME.zip" || exit 1
echo
echo "Done: $(pwd)/$NAME.zip"
shasum -a 256 "$NAME.zip"
echo "(upload this file to the release; the SHA-256 above goes into the notes)"
