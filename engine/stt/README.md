# engine/stt — the voice recognition engine (`cmr-stt.exe`)

This folder is the **source** of the engine program. It is on GitHub, but **not** part of the program a user downloads: the release only holds the
built `cmr-stt.exe` (see "What is released" below). Nothing here is needed to run ChatMatrix Reader.

The engine is a separate program on purpose: the main program (exe) only moves sound; everything about speech recognition (Whisper, GPUs, models)
lives here and in `extensions/stt/` next to the exe, and is installed and removed from the options window.

## What it does
```
the exe (sound capture)  --16 kHz mono PCM on stdin-->  cmr-stt  --one JSON line per message on stdout-->  the exe (options / chat window)
```
1. reads the sound, cuts it into sentences with a simple energy detector (`src/segmenter.cpp`, a port of the 2.x `segmenter.py`),
2. recognises each sentence with Whisper (`src/whisper_engine.cpp`, [whisper.cpp](https://github.com/ggml-org/whisper.cpp), official source, fixed version),
3. throws away what Whisper makes up from noise (`src/filters.cpp`, a port of the 2.x `filters.py`),
4. reports `{"type":"text","text":"...","dur":<s of speech>,"ms":<recognising time>,...}`.

The command line and the messages are described in `src/config.h` and `src/json.h` (the other side is `app/core/voice_proto.js`).
`--bench <file.wav>` runs the speed test used by the options window (`src/bench.h`).

## Build
Needs CMake, Git, and Visual Studio (or its Build Tools, "Desktop development with C++"). On Windows just run **`build.bat`** (CPU engine; `build.bat vulkan` / `build.bat cuda` later):
it fetches the official whisper.cpp at the commit written in `whisper.version`, builds, runs the tests, and leaves `dist\engine-cpu\cmr-stt.exe` and its SHA-256.
`build.bat cpu "D:\path\whisper.cpp-1.9.2"` uses an unpacked copy of the official release zip instead of fetching (its SHA-256 is in `whisper.version`).

On a Mac (Apple silicon, macOS 13 or later): needs CMake, Git and the Xcode command line tools (`xcode-select --install`), then **`./build.sh`**.
One file, `dist/engine-metal/cmr-stt`: Metal (the GPU, its shaders embedded) and the CPU part (Accelerate) together; `device` in the config picks which one computes.

By hand:
```
cmake -S engine/stt -B build -DCMR_WITH_WHISPER=ON            # -DCMR_WHISPER_DIR=<unpacked official source>  -DCMR_GPU=none|vulkan|cuda|metal  -DCMR_CPU=avx2|generic
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
cmr-stt --version                                             # {"type":"version","engine":..,"whisper":"v1.9.2","commit":..,"gpu":..,"cpu":..}
```
Without `-DCMR_WITH_WHISPER=ON` only the pieces and the tests are built (no recogniser; development on any system).
The engine is one program: static libraries, no OpenMP, the Visual C++ runtime linked in, no DLLs. `CMR_CPU=avx2` (default) runs on CPUs from 2013 (Haswell) on; `generic` on every x86-64 CPU, slower.

## Try it
```
cmr-stt --bench ..\bench\jfk.wav --model ..\models\ggml-small.bin --device cpu     # whisper.cpp's samples\jfk.wav (11 s, English): the text should read "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."
```

## Tests
`tests/golden/` holds sounds and the answers the **2.x Python reader** gave for them (`tools/make_golden_stt.py` makes them; it needs the 2.x folder and numpy,
only the maintainer runs it). The C++ code must give the same sentences (`test_golden`) and the same filter decisions. `test_pipeline` runs the whole
stream with a stand-in recogniser, `test_config` the command line, the PCM reader and the WAV reader.

## What is released
GitHub shows everything (this folder is the source). The **engine is not part of the program's zip**: it is a separate download that the program fetches when the
user presses "install" in the options. What is released, per kind (`cpu`, `vulkan`), after `build.bat` / `build.bat vulkan`:

    cmr-stt-<kind>-windows-x64.exe      the engine (the program stores it as extensions/stt/engine-<kind>/cmr-stt.exe)
    LICENSE-whisper.cpp.txt             the MIT license of whisper.cpp / ggml (it must come with every copy of the engine)
    LICENSE-ChatMatrixReader.txt        the MIT license of this project
    BUILD-INFO-engine-<kind>.txt        release tag, whisper.cpp tag + commit, commit of this project, SHA-256 of every file
    SHA256SUMS-engine.txt               all hashes in one list

`build.bat` leaves `dist\engine-<kind>\` with the engine, its SHA-256, the two license files and `version.json` (what `--version` says);
`release_engines.bat` (= `py tools\engine_release.py <tag>`) checks that folder, names the files above in `release-out\<tag>\` (the same folder as the program's zip; upload them to the GitHub release by hand)
and writes the addresses and SHA-256 into `app/core/voice_catalog.js`, so the program downloads the engine, the licenses and the build info next to each other
and checks every file. The whole procedure is in `docs/RELEASE.md`. Models are not released: the program gets them from Hugging Face (`tools/model_hashes.py`).
