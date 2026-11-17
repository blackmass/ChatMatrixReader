// The command line of the engine (core/voice_proto.js engineArgs writes it):
//   --model <path> --device cpu|gpu --lang <code|auto> --end-ms N --max-s N --mode sentence|live [--partial-ms N] --pcm s16|f32 --rate 16000 [--prompt text]
//   --min-db N                    the quietest sound that can be speech, in dB (default about -44)
//   --framed                      the input is in frames (protocol.h): sound and control messages (language, hint ... while it runs)
//   --no-level                    no {"type":"level"} lines
//   --bench <wav file> --model <path> --device cpu|gpu       the speed test (bench.cpp)
#pragma once
#include <cmath>
#include <string>
#include <vector>

#include "pcm.h"
#include "segmenter.h"

namespace cmr {

struct Config {
    std::string model, device = "cpu", lang, prompt, bench;
    bool live = false;
    int partial_ms = 1000;
    int end_ms = 700;
    double max_s = 12.0;
    double min_db = 0;                   // 0 = the default of the segmenter (0.006, about -44 dB)
    int max_backlog = 3;                 // older sentences are dropped when the recogniser falls behind
    PcmFormat pcm = PcmFormat::S16;
    int rate = 16000;
    int threads = 0;                     // 0 = the engine decides
    bool stats = true;                   // the once-a-second {"type":"stats"} line
    bool level = true;                   // about ten {"type":"level"} lines a second (the loudness bar of the options)
    bool framed = false;                 // the input is framed (see protocol.h); false = raw sound only
    SegParams seg() const { SegParams p; p.end_ms = end_ms; p.max_s = max_s; if (min_db < 0) p.min_rms = std::pow(10.0, min_db / 20.0); return p; }
};

// false + error text when an argument is wrong
bool parseArgs(const std::vector<std::string>& args, Config& cfg, std::string& error);

}  // namespace cmr
