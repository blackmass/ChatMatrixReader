// cmr-stt: the voice recognition engine of ChatMatrix Reader. Reads 16 kHz mono sound on the standard input, writes one JSON line per message on
// the standard output (see json.h / core/voice_proto.js). Log lines for people go to the standard error. It touches nothing else.
#include <cstdlib>
#include <iostream>

#include "bench.h"
#include "config.h"
#include "json.h"
#include "pipeline.h"
#include "version.h"
#include "whisper_engine.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

int main(int argc, char** argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);             // the sound is bytes: no text translation
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::ios::sync_with_stdio(false);
    cmr::Out out([](const std::string& line) { std::cout << line << '\n'; std::cout.flush(); });
    if (argc == 2 && std::string(argv[1]) == "--version") {
        out.emit(cmr::Msg("version").str("engine", CMR_ENGINE_VERSION).str("whisper", CMR_WHISPER_TAG).str("commit", CMR_WHISPER_COMMIT)
                     .str("gpu", CMR_GPU_NAME).str("cpu", CMR_CPU_NAME));
        return 0;
    }
    cmr::Config cfg; std::string error;
    if (!cmr::parseArgs(std::vector<std::string>(argv + 1, argv + argc), cfg, error)) {
        out.emit(cmr::Msg("status").str("state", "error").str("msg", error));
        return 2;
    }
    auto rec = cmr::makeWhisper(cfg);
    int code;
    if (!cfg.bench.empty()) code = cmr::runBench(cfg, *rec, out);
    else { cmr::Pipeline p(cfg, *rec, out, std::cin); code = p.run(); }
    std::cout.flush();
    if (code != 0) std::_Exit(code);                 // (a reader that waits for input must not hold us back)
    return 0;
}
