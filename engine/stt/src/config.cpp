#include "config.h"

#include <algorithm>
#include <cstdlib>

namespace cmr {

bool parseArgs(const std::vector<std::string>& a, Config& c, std::string& err) {
    auto num = [&](const std::string& v, double lo, double hi, double& out) {
        char* end = nullptr; double d = std::strtod(v.c_str(), &end);
        if (end == v.c_str() || *end != 0) return false;
        out = std::min(hi, std::max(lo, d)); return true;
    };
    for (size_t i = 0; i < a.size(); i++) {
        const std::string& k = a[i];
        auto next = [&](std::string& v) { if (i + 1 >= a.size()) { err = "missing value for " + k; return false; } v = a[++i]; return true; };
        std::string v; double d = 0;
        if (k == "--model") { if (!next(c.model)) return false; }
        else if (k == "--device") { if (!next(v)) return false; c.device = v == "gpu" ? "gpu" : "cpu"; }
        else if (k == "--lang") { if (!next(v)) return false; c.lang = v == "auto" ? "" : v; }
        else if (k == "--prompt") { if (!next(c.prompt)) return false; }
        else if (k == "--bench") { if (!next(c.bench)) return false; }
        else if (k == "--mode") { if (!next(v)) return false; c.live = v == "live"; }
        else if (k == "--pcm") { if (!next(v)) return false; if (v != "s16" && v != "f32") { err = "--pcm is s16 or f32"; return false; } c.pcm = v == "f32" ? PcmFormat::F32 : PcmFormat::S16; }
        else if (k == "--rate") { if (!next(v) || !num(v, 8000, 192000, d)) { err = "--rate"; return false; } c.rate = static_cast<int>(d); }
        else if (k == "--end-ms") { if (!next(v) || !num(v, 100, 10000, d)) { err = "--end-ms"; return false; } c.end_ms = static_cast<int>(d); }
        else if (k == "--max-s") { if (!next(v) || !num(v, 1, 60, d)) { err = "--max-s"; return false; } c.max_s = d; }
        else if (k == "--partial-ms") { if (!next(v) || !num(v, 100, 10000, d)) { err = "--partial-ms"; return false; } c.partial_ms = static_cast<int>(d); }
        else if (k == "--min-db") { if (!next(v) || !num(v, -80, -10, d)) { err = "--min-db"; return false; } c.min_db = d; }
        else if (k == "--backlog") { if (!next(v) || !num(v, 1, 100, d)) { err = "--backlog"; return false; } c.max_backlog = static_cast<int>(d); }
        else if (k == "--threads") { if (!next(v) || !num(v, 0, 256, d)) { err = "--threads"; return false; } c.threads = static_cast<int>(d); }
        else if (k == "--no-stats") { c.stats = false; }
        else if (k == "--no-level") { c.level = false; }
        else if (k == "--framed") { c.framed = true; }
        else { err = "unknown argument " + k; return false; }
    }
    if (c.model.empty()) { err = "--model is required"; return false; }
    if (c.rate != 16000) { err = "only 16000 Hz is supported (the program sends 16 kHz)"; return false; }
    return true;
}

}  // namespace cmr
