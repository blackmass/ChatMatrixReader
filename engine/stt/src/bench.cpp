#include "bench.h"

#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>

#include "filters.h"

namespace cmr {

namespace {
using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }
uint32_t u32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24); }
uint16_t u16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
}  // namespace

bool readWav(const std::string& path, std::vector<float>& out, std::string& error) {
    std::ifstream f(path, std::ios::binary);
    if (!f) { error = "cannot open " + path; return false; }
    std::vector<uint8_t> d((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (d.size() < 44 || std::memcmp(d.data(), "RIFF", 4) != 0 || std::memcmp(d.data() + 8, "WAVE", 4) != 0) { error = "not a WAV file"; return false; }
    uint16_t tag = 0, ch = 0, bits = 0; uint32_t rate = 0; const uint8_t* data = nullptr; size_t data_len = 0;
    for (size_t pos = 12; pos + 8 <= d.size();) {
        uint32_t len = u32(&d[pos + 4]);
        const uint8_t* body = &d[pos + 8];
        size_t avail = std::min<size_t>(len, d.size() - pos - 8);
        if (std::memcmp(&d[pos], "fmt ", 4) == 0 && avail >= 16) { tag = u16(body); ch = u16(body + 2); rate = u32(body + 4); bits = u16(body + 14);
            if (tag == 0xFFFE && avail >= 26) tag = u16(body + 24); }          // WAVE_FORMAT_EXTENSIBLE: the real format is in the sub-format
        else if (std::memcmp(&d[pos], "data", 4) == 0) { data = body; data_len = avail; break; }
        pos += 8 + len + (len & 1);
    }
    if (!data || !ch) { error = "the WAV file has no sound data"; return false; }
    if (rate != 16000) { error = "the WAV file is " + std::to_string(rate) + " Hz; it must be 16000 Hz (convert: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav)"; return false; }
    bool is16 = tag == 1 && bits == 16, isf = tag == 3 && bits == 32;
    if (!is16 && !isf) { error = "only 16 bit integer or 32 bit float WAV files are supported"; return false; }
    size_t w = bits / 8, frames = data_len / (w * ch);
    out.clear(); out.reserve(frames);
    for (size_t i = 0; i < frames; i++) {
        double sum = 0;
        for (uint16_t c = 0; c < ch; c++) {
            const uint8_t* p = data + (i * ch + c) * w;
            if (is16) sum += static_cast<int16_t>(u16(p)) / 32768.0;
            else { uint32_t u = u32(p); float v; std::memcpy(&v, &u, 4); sum += (v != v) ? 0.0 : v; }
        }
        out.push_back(static_cast<float>(sum / ch));
    }
    return true;
}

int runBench(const Config& cfg, Recognizer& rec, Out& out) {
    std::vector<float> audio; std::string error;
    if (!readWav(cfg.bench, audio, error)) { out.emit(Msg("status").str("state", "error").str("msg", error)); return 2; }
    if (audio.size() < 16000) { out.emit(Msg("status").str("state", "error").str("msg", "the sound file is shorter than 1 second")); return 2; }
    auto t0 = Clock::now();
    if (!rec.load(error)) { out.emit(Msg("status").str("state", "error").str("msg", error)); return 2; }
    double load_ms = msSince(t0);
    try {
        rec.transcribe(audio, cfg.lang, cfg.prompt);                          // warm-up: the first run pays for caches and lazy setup
        auto t1 = Clock::now();
        auto results = rec.transcribe(audio, cfg.lang, cfg.prompt);
        double ms = msSince(t1);
        std::string text;
        for (auto& r : results) {
            std::string t = r.text;
            size_t a = t.find_first_not_of(" \t\r\n"), b = t.find_last_not_of(" \t\r\n");
            if (a == std::string::npos) continue;
            t = t.substr(a, b - a + 1);
            if (!text.empty()) text += " ";
            text += t;
        }
        out.emit(Msg("bench").num("dur", audio.size() / 16000.0, 2).num("ms", ms, 0).num("load_ms", load_ms, 0).str("device", rec.device()).str("text", text));
        return 0;
    } catch (const std::exception& e) {
        out.emit(Msg("status").str("state", "error").str("msg", std::string("recognition failed: ") + e.what()));
        return 2;
    }
}

}  // namespace cmr
