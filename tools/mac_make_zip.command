#!/bin/bash
# Makes the release zip of the Mac program: ChatMatrixReader-v<version>-macos-arm64.zip. The files around the app are the ones of the Windows zip: the list is
# release/files-windows.txt (one list for both; change it there). Left out here: the entries only Windows has (ChatMatrixReader.exe; the notices are made for the Mac
# build by tools/make_notices.py). Added: the app (made by tools/mac_make_app.command) and BUILD-INFO.txt. The program reads app/ and locale/ from the folder next
# to the .app, so they must be in the zip.
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
rm -rf "$OUT"; mkdir -p "$OUT/ChatMatrixReader"

python3 tools/make_notices.py --target aarch64-apple-darwin --out "$OUT/ChatMatrixReader/THIRD-PARTY-NOTICES.txt" || exit 1
ditto "$APP" "$OUT/ChatMatrixReader/$APP"                  # (ditto keeps the signature of the app)
# the files of the list (name/ = a whole folder, name = one file; # = comment). The file may have Windows line ends and no line end at its last line.
LIST="release/files-windows.txt"
[ -f "$LIST" ] || { echo "$LIST was not found."; exit 1; }
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ""|"#"*) continue ;; esac
  case "$line" in ChatMatrixReader.exe|THIRD-PARTY-NOTICES.txt) continue ;; esac     # (Windows only / made above for the Mac)
  name="${line%/}"
  if [ ! -e "$name" ]; then echo "$line: the file is not there (it is in $LIST)."; exit 1; fi
  mkdir -p "$OUT/ChatMatrixReader/$(dirname "$name")"
  if [ "$name" != "$line" ]; then cp -R "$name" "$OUT/ChatMatrixReader/$(dirname "$name")/"; else cp "$name" "$OUT/ChatMatrixReader/$name"; fi
done < "$LIST"
find "$OUT/ChatMatrixReader" -name .DS_Store -type f -delete
find "$OUT/ChatMatrixReader" -name __pycache__ -type d -prune -exec rm -rf {} +

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
shasum -a 256 "$NAME.zip" | tee "$OUT/SHA256SUMS-macos.txt"          # (the same line as in the file of the Windows release: SHA-256, two spaces, the name)
echo "(upload the zip to the release, and with it $(pwd)/$OUT/SHA256SUMS-macos.txt; the SHA-256 above may also go into the notes)"
