[한국어](./README.md) | [English](./README.en.md)

<img width="479" height="417" alt="image" src="https://github.com/user-attachments/assets/6cb0a2e0-7340-4b8d-989f-ef7d1eb729e9" />

# ChatMatrixReader
A real-time automatic translator for World of Warcraft chat.

The WoW addon **ChatMatrix** draws the chat as a small block of colored cells (the "matrix") in a corner of the screen. **ChatMatrixReader** (this program) reads that block from the screen, turns it back into text, translates it and shows it in a transparent window on top of the game. It does not touch game files, game memory, or inject any DLL.

> This program is not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment.

# Design principles
- **Light**: small download. No heavy frameworks, and no AI model bundled.
- **Exact**: no OCR, no AI vision. The addon takes the chat data directly from the game and passes it on as it is, so the text is 100% accurate.
- **Minimal**: no needless design or interface. The goal is that you only see the translated text.
- **Learning**: I will never try to erase English and replace it. Showing the original next to the translation is the default.
- **Reliable**: it is an exe, so here is what I did to make it trustworthy.
  - The whole source is open (MIT). No DLL injection, no memory access.
  - `BUILD-INFO.txt` inside the release zip lists the SHA-256 of every file and the commit it was built from.
  - Voice recognition engines and models are checked against SHA-256 every time they are downloaded.
  - A list of the licenses of every library used (`THIRD-PARTY-NOTICES.txt`) is included.
  - The program is not code-signed (cost), so Windows may show a warning.
- **Self-contained**: no installer. Unzip it into a folder and run it: settings, logs, glossary and fonts all stay in that folder, and nothing is written to the registry. To remove it, delete the folder.

# Features
- Detects only the chat and translates it live. Shows original and translation together, can swap their order, and sets the translation method per channel.
- Several translation windows. Channels, font, size, opacity, background blur and text outline are set per window.
- **Always on top**, or **on top of WoW only** (so the window does not cover your other work when you leave the game).
- **Click-through**: title bar and border disappear, only the translation is visible, and the game is not disturbed. Hold Shift and move the mouse over the window to use it.
- Transparent background, text size, line spacing, font and shadow can be tuned so that it blends into the WoW screen.
- **Glossary**: add terms on the fly. Defaults are set for both Google and the AI prompt.
- String rules (regex): drop a message from translation, or hide it from the window, when it contains certain text (e.g. exclude anything with Korean characters).
- **Send**: press `Shift+Enter` in game, type in your language, and the English translation goes to the clipboard (optional auto-paste; the final Enter is yours).
- Multilingual: it works on text, not images, so every language Google detects can be translated. The interface is Korean and English; to add another language, put a text file in the `locale` folder.
- Voice recognition (STT): turns the voice of Discord, WoW or other programs into text and translates it (Windows).
- Options apply the moment you change them. Open them with the ⚙ on the window, the tray icon, or `Ctrl+Alt+O`.

# Installation
You need both the addon and the program.

**1. The addon (ChatMatrix)**
- Get it from <a href="https://www.curseforge.com/wow/addons/chatmatrix">CurseForge</a> and put it in the WoW AddOns folder (automatic with the CurseForge app).
- If the newest version waits for approval on CurseForge, it is also on <a href="https://drive.google.com/drive/u/0/folders/1vAJJ8w9MMW5qJzxfjg5qSktN5XhH77ow">Google Drive</a>.

**2. The program (ChatMatrixReader): Windows**
1. Download `ChatMatrixReader-v<version>-windows-x64.zip` from the <a href="https://github.com/blackmass/ChatMatrixReader/releases">Releases page</a> (not the source code zip).
2. Unzip it anywhere and run `ChatMatrixReader.exe`. The program is not signed, so if Windows warns you, choose "More info → Run anyway". Keep the `app` folder next to the exe.
3. Needs Windows 10 or 11 and the WebView2 runtime (included in Windows 11; on Windows 10, install Microsoft's WebView2 runtime if the program does not start).
4. Run WoW in **windowed or windowed fullscreen** mode (in exclusive fullscreen other windows cannot be shown on top).

**The program: Mac (experimental)**
- For Apple Silicon (M1 and later), and it needs **macOS 13 or later**. Translation windows, always on top, on top of WoW only, click-through, matrix reading and voice recognition work. On macOS 12 and earlier only the voice recognition is turned off; everything else works as usual.
- I did not register as an Apple developer, so a security warning appears on first run (right-click → Open). If needed, remove the quarantine with `xattr -dr com.apple.quarantine <folder path>` in the Terminal.
- You must allow the **Screen & System Audio Recording** permission yourself. Run WoW in windowed (fullscreen window) mode.
- Tested only on my own MacBook, so expect some rough edges.

# First setup
1. When you enable the addon in WoW, a **green matrix box** appears. Drag it to a place that is easy to see and fix it with `/cm lock`. Other UI must not cover it. To move it again, use `/cm unlock`.
2. Start the program and the chat shows up in the translation window. On the first run, or after moving the matrix, press the ⟳ on the window to find it again.
3. **If your setup changes colors, lower the color levels.** DLSS, HDR, brightness and color filters can distort the matrix colors so that it is not recognized. In the addon settings (ESC → Options → AddOns → ChatMatrix) lower the color levels, or type `/cm levels 16` (default 256). This solves it in most cases. If not, go lower: 8, then 4.
4. On a **Mac with a Retina display**, level 256 is not recognized at the default (x2). Lower it with `/cm levels 16`.
5. Type `/cm` to list all commands. The chat filter is `/cm filter`, the settings page is `/cm config`.

# Translation methods
Choose in the Translation tab of the options.
- **Google Translate (default)**: works without any setup. It does not truly understand context, but it is fine for playing. If you hit a limit (usually it is another problem), you can create your own Google API key (500,000 characters free per month, then $20 per million). The key-less free translation is not an official API and can be blocked at any time.
- **AI server (OpenAI compatible)**: any server that speaks the OpenAI API. A cloud AI works, and so does a local AI on your own PC.
- **Custom server**: you write the request format yourself (e.g. Gemini).
- No translation: when you only want the original.

# Translating with a local AI (LM Studio)
Letting an AI translate makes a big difference compared to machine translation. It knows this is game chat, so it turns `LFM`, `HEAL` and `TANK` into the proper words by itself, and a glossary given as parenthesized references is understood perfectly. Even a small model handles the glossary far better than machine translation.

WoW usually takes about 8 GB of VRAM; giving the AI about 4 GB more is enough for a very good translation. Since it only translates, you can compromise with a small model and a light quantization.

The installation and settings are explained in a guide (in Korean): [Translating with a local AI in LM Studio](docs/LM%20Studio.md)

# Voice recognition (optional)
Turns voice chat (Discord and the like) into text with Whisper and shows it in the translation window. The sound is processed on your PC only and never leaves it.
- "Install" an engine and a model in the **Voice** tab of the options. Everything is installed inside `extensions/stt` in the program folder and can be removed with the delete button.
- The source of the sound can be a single program (Discord, WoW ...), a device, or the whole system.
- **Windows, recommended: the Vulkan engine + the `large-v3-turbo` model.** It runs on most PCs that have a GPU (Nvidia, AMD and Intel).
- If your hardware is struggling, use **the Vulkan engine + the `small` model**.
- Without a GPU (CPU engine) `small` or below is realistic. `turbo` is slower than real time on a CPU. The "Models and speed" list in the Voice tab measures the speed on your own PC.
- A CUDA engine is planned.

**Voice recognition on a Mac**
- Install just the one **Metal** engine. The GPU (Metal) and the CPU are in the same file, and you choose GPU or CPU under "Compute device". Measure both in "Models and speed" and pick the one that suits your Mac. If your hardware is weak, use `small`.
- The first time it is turned on with the GPU (Metal), loading the model takes about 10 seconds (the one-time preparation of the GPU code).
- The sound is received through the **Screen & System Audio Recording** permission. Without it no sound is received (System Settings → Privacy & Security).
- A Mac cannot split the sound inside one program. With Discord as the source, not only the voice chat but everything Discord plays (videos and so on) is turned into text. Watch videos in a browser and they will not be mixed in.

# Updating
- The release zip contains no `config.json`, glossary or fonts, so **you can simply overwrite**. The same goes for the addon.
- When a new version exists, you only get a notice at start (it can be turned off in the options; nothing is installed automatically).
- **Coming from 1.x (the Python version)**: the cleanest way is to unzip into a new folder and copy only `config.json`, the `fonts` folder (and `Glossary.txt`) from the old folder. The settings are carried over (the original stays as `config.1x.json`). Overwriting the old folder also works: on the first start the program recognizes the files of the old version and asks to move them into the `old_version_backup` folder (they are moved, never deleted). If you do not move them, the program does not start.

# Notes
- Limit: since the Midnight expansion, WoW restricts addons more strongly, so some messages (guild management, battlegrounds, boss fights) cannot be collected. There is a safety net, so everything else is collected (check "Other" in the addon options, and it depends on your own chat filter settings). It is not a big problem on NA servers. The recent official API patch notes suggest it may get better.
- WoW Retail (live) and the Forever servers are tested because those are what I play. Classic and others are unknown; it may only need the version added to the toc.
- Both Windows and Mac are tested. The Mac version was only tested on my MacBook, so expect more rough edges.
- If **Smart App Control** of Windows 11 is on, it can block this program because it is not signed (there is no "run anyway"). If it does, turn it off to use the program (Windows Security → App & browser control).
- Post-processing that changes colors (DLSS, HDR) can disturb recognition. Adjusting the color levels as in "First setup" fixes most cases (it is detected even with WoW brightness at 100%).

# What goes out to the internet
- **Translation**: the chat text to be translated goes to the translation service you chose (Google Translate, or the AI server you set). Nothing is sent when translation is off.
- **Checking for a new version**: at start the program reads the GitHub release information once (it can be turned off).
- **Installing voice recognition**: the engine comes from this repository's releases, the models from Hugging Face.
- Nothing else is sent. Settings, logs and the glossary are stored only inside the program folder.

# FAQ
- **Which server do you play?** NA Retail Tichondrius, NA Forever PVP.
- **The matrix is not detected**: first check that it really is not detected. Most of the time the addon was not installed properly. Install the addon, put it where it is clearly visible, press ⟳ on the window, and if it still fails, lower the color level one step and press ⟳ again.
- **Google Translate says I hit a limit**: I ran it for a whole week without any problem. If it were a real limit, Google Translate in a browser on the same IP would be blocked too. If not, it may be a change on Google's side, so please open an issue. I only use legitimate methods, no tricks.
- **Where do I get the official WoW font?** I cannot include it in the release because of copyright, and **the "WoW font" files shared on the internet are almost all different fonts with the same name** (every one I tried was wrong: the Korean may look close but the English looks different, or it is another font altogether). **Always extract it from your own WoW client.**
  1. With a separate WoW file extraction tool (find one yourself), take `2002.TTF` (Korean client) or `ARIALN.TTF` (English client) from the `Fonts` folder of your own WoW installation.
  2. If you do not know which file to take, type `/run print(ChatFrame1:GetFont())` in the WoW chat box. It prints the path of the font file the chat uses (if a chat addon changed the font, it is the font path of that addon).
  3. Put the file in the `fonts` folder and restart the program; you can pick it in Options → Window → Font. The name in the list is **the font name written inside the file**, not the file name.
- **Send (Shift+Enter) does not work**: it fails when only one of the reader and WoW runs as administrator. It may also simply be off in the options, so check Options → Send.
- **Is there a glossary to download?** I will probably not share a glossary myself. I will keep proposing better rules. Share them with each other, or build your own.
- **I only want to see what I want**: there are detailed filters in both the addon and the reader. By default it follows WoW's default chat tab, so at first everything you do not want shows up too.
- **Why is no local AI built in?** Things that keep changing (translation AI, speech recognition models) are not run by this program itself; connecting to an outside program is the basis. Models and ways to run them change every day, only the way to connect does not. I do not know when I will stop updating, so users should be able to follow the times themselves.
- **Something does not work**: link this GitHub page to GPT, Gemini or another AI and ask it for help. The source is completely open, so it will analyze it well.

# Feedback
- Feature requests are welcome, as long as they fit the principles above.
- If the translation window shows something odd, or some messages are not collected, check both debug options in the addon settings and click the minimap icon to copy the log, or copy it from the reader's Options → About → Log (the file is `logs/chatmatrix.log`).

# Building from source
Made with Tauri v2 (Rust + plain JavaScript). The screens and logic are the JavaScript in `app/`; the Rust program in `src-tauri/` is only a thin shell for windows and OS calls.

You need Visual Studio Build Tools (Desktop development with C++) and Rust (`rustup default stable-msvc`). Then run `build.bat` to make `ChatMatrixReader.exe` (run it next to the `app` folder). Tests run with Node.js 18 or newer: `node tests/run.mjs`. The voice engine source is in `engine/stt/` (CMake; see the README there). A plugin guide is in preparation (`docs/`).

# License
This program is under the **MIT License** (`LICENSE`, Copyright (c) 2026 Eternalguard). The licenses of the libraries inside it and of the voice recognition (whisper.cpp, OpenAI Whisper) are in `THIRD-PARTY-NOTICES.txt` and in the options under **About → Technology and licenses used**. Translation services follow their own terms of use.
