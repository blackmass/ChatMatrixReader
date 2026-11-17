#!/bin/bash
# Makes "ChatMatrix Reader.app" from the program that `cargo build --release` made, and puts it in the project folder (next to the app folder).
# Run it with:   bash tools/mac_make_app.command      (from the project folder)
cd "$(dirname "$0")/.." || exit 1
BIN="src-tauri/target/release/chatmatrix-reader"
APP="ChatMatrix Reader.app"

if [ ! -f "$BIN" ]; then
    echo "The program was not built yet: $BIN is missing."
    echo "먼저 빌드를 해야 합니다 (docs/MAC_BUILD.md 의 4단계)."
    exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/chatmatrix-reader"
chmod +x "$APP/Contents/MacOS/chatmatrix-reader"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ChatMatrix Reader</string>
<key>CFBundleDisplayName</key><string>ChatMatrix Reader</string>
<key>CFBundleIdentifier</key><string>com.chatmatrix.reader</string>
<key>CFBundleExecutable</key><string>chatmatrix-reader</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>3.0</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST

# The signature. With the certificate "ChatMatrixReader Mac" of your own keychain (made once, see docs/MAC_BUILD.md) the identity of the app stays the same
# when it is built again, so the permissions given to it (screen recording ...) stay too. Without it an "ad hoc" signature is used: it changes with every
# build, and the permissions have to be given again (tccutil reset ScreenCapture com.chatmatrix.reader).
# (Apple Silicon Macs refuse to run a program that has no signature at all.)
IDENTITY="ChatMatrixReader Mac"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    codesign --force --deep --identifier com.chatmatrix.reader --sign "$IDENTITY" "$APP" && echo "signed with the certificate: $IDENTITY"
else
    echo "(the certificate \"$IDENTITY\" was not found: ad hoc signature; permissions must be given again after every build)"
    codesign --force --deep --sign - "$APP" && echo "signed (ad hoc)"
fi
echo "Done: $(pwd)/$APP"
echo "완료: 위 경로의 ChatMatrix Reader.app 을 열면 됩니다 (처음에는 우클릭 > 열기)."
