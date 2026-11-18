#!/bin/bash
# Builds cmr-stt, the voice recognition engine, on a Mac (Apple silicon, macOS 13 or later). Run it from anywhere; it works in this folder.
#
#   ./build.sh                 the engine with Metal (the GPU) AND the CPU part in ONE file
#   ./build.sh metal "/path/whisper.cpp-1.9.2"   use an unpacked copy of the official whisper.cpp source instead of fetching it with git
#
# Needs: CMake (https://cmake.org/download/ or `brew install cmake`), Git, and the Xcode command line tools (`xcode-select --install`).
# Result: dist/engine-metal/ with cmr-stt, its SHA-256, the licenses (LICENSE-whisper.cpp.txt, LICENSE.txt) and version.json (what --version says).
# The version of whisper.cpp is the one written in whisper.version (fetched from the official repository at that commit).
set -e
cd "$(dirname "$0")"

KIND=metal
SRCARG=()
[ -n "$2" ] && SRCARG=("-DCMR_WHISPER_DIR=$2")

command -v cmake >/dev/null || { echo "CMake was not found. Install it from https://cmake.org/download/ and run this again."; exit 1; }
command -v git >/dev/null || [ -n "$2" ] || { echo "Git was not found (xcode-select --install), or give the folder of an unpacked whisper.cpp as the second argument."; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "This build is for Apple silicon (arm64)."; exit 1; }

echo "== configure ($KIND)"
cmake -S . -B "build-$KIND" -DCMR_WITH_WHISPER=ON -DCMR_GPU=metal "${SRCARG[@]}"
echo "== build"
cmake --build "build-$KIND" --config Release --parallel
echo "== tests"
ctest --test-dir "build-$KIND" -C Release --output-on-failure

OUT="dist/engine-$KIND"
mkdir -p "$OUT"
cp "build-$KIND/cmr-stt" "$OUT/cmr-stt"
(cd "$OUT" && shasum -a 256 cmr-stt > cmr-stt.sha256)
# The engine is downloaded apart from the program, so the licenses travel with it (MIT: the notice must come with every copy)
WLIC="build-$KIND/_deps/whisper-src/LICENSE"
[ -n "$2" ] && WLIC="$2/LICENSE"
[ -f "$WLIC" ] || { echo "The LICENSE file of whisper.cpp was not found: $WLIC"; exit 1; }
cp "$WLIC" "$OUT/LICENSE-whisper.cpp.txt"
[ -f ../../LICENSE ] || { echo "The LICENSE file of this project was not found: ../../LICENSE"; exit 1; }
cp ../../LICENSE "$OUT/LICENSE.txt"
"$OUT/cmr-stt" --version > "$OUT/version.json"
echo "== done: $OUT/cmr-stt"
cat "$OUT/version.json"
cat "$OUT/cmr-stt.sha256"
echo "== size"; ls -l "$OUT/cmr-stt"; otool -L "$OUT/cmr-stt"
