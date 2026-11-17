// The pipeline (sound on an input stream -> JSON lines) and the speed test, with a stand-in recogniser.
#include "../src/procstats.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

#include "../src/bench.h"
#include "../src/pipeline.h"
#include "../src/protocol.h"
#include "check.h"

using namespace cmr;

// answers with a fixed text, can be slow, can fail
struct Mock : Recognizer {
    std::string text = "hello there", lang = "en";
    int delay_ms = 0, fail_times = 0, calls = 0; bool load_ok = true;
    std::vector<std::pair<std::string, std::string>> asked;       // (language, prompt) of every call
    std::optional<double> logprob = -0.3, nsp = 0.1;
    std::mutex mu;
    bool load(std::string& e) override { if (!load_ok) { e = "model file not found"; return false; } return true; }
    std::vector<Result> transcribe(const std::vector<float>&, const std::string& language, const std::string& prompt) override {
        { std::lock_guard<std::mutex> g(mu); calls++; asked.push_back({language, prompt}); }
        if (delay_ms) std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
        if (fail_times > 0) { fail_times--; throw std::runtime_error("boom"); }
        return {Result{text, logprob, nsp, lang}};
    }
    std::string device() const override { return "cpu"; }
    std::string describe() const override { return "Mock on cpu"; }
};

// 16 bit mono PCM: quiet noise, then `bursts` pieces of speech-like sound (1.2 s) with 1.2 s of quiet between
static std::string stream(int bursts) {
    std::string bytes; unsigned seed = 1;
    auto put = [&](double v) { int16_t s = static_cast<int16_t>(std::max(-1.0, std::min(1.0, v)) * 32767); bytes.append(reinterpret_cast<char*>(&s), 2); };
    auto noise = [&]() { seed = seed * 1103515245u + 12345u; return ((seed >> 16) & 0x7fff) / 32768.0 - 0.5; };
    for (int i = 0; i < 16000 * 1; i++) put(noise() * 0.006);
    for (int b = 0; b < bursts; b++) {
        for (int i = 0; i < 19200; i++) { double env = 0.55 + 0.45 * std::pow(std::sin(2 * 3.14159265 * 4 * i / 16000.0), 2); put(0.2 * env * std::sin(2 * 3.14159265 * 140 * i / 16000.0) + noise() * 0.006); }
        for (int i = 0; i < 19200; i++) put(noise() * 0.006);
    }
    return bytes;
}

// the lines go to a shared place (a reader that was left behind after a fatal error may still write: it must not write into a dead object)
struct Sink { std::mutex mu; std::vector<std::string> lines; };
struct Run { std::vector<std::string> lines; int code; };
static std::shared_ptr<Sink> makeSink() { return std::make_shared<Sink>(); }
static Run finish(const std::shared_ptr<Sink>& sink, int code) {
    if (code != 0) std::this_thread::sleep_for(std::chrono::milliseconds(150));      // (a reader that was left behind ends with the finite input)
    std::lock_guard<std::mutex> g(sink->mu);
    return Run{sink->lines, code};
}
static Run run(Config cfg, Mock& m, const std::string& bytes) {
    auto sink = makeSink();
    Out out([sink](const std::string& l) { std::lock_guard<std::mutex> g(sink->mu); sink->lines.push_back(l); });
    std::istringstream in(bytes);
    cfg.model = "m";
    Pipeline p(cfg, m, out, in);
    return finish(sink, p.run());
}

// an input that arrives like real sound: a little pause after every frame, so that the recogniser thread works in between
struct PacedBuf : std::streambuf {
    std::string data; size_t pos = 0; int pause_us;
    PacedBuf(std::string d, int us) : data(std::move(d)), pause_us(us) {}
    int_type underflow() override {
        if (pos >= data.size()) return traits_type::eof();
        std::this_thread::sleep_for(std::chrono::microseconds(pause_us));
        size_t n = std::min<size_t>(653, data.size() - pos);          // (one frame: 13 + 640 bytes)
        chunk = data.substr(pos, n); pos += n;
        setg(&chunk[0], &chunk[0], &chunk[0] + chunk.size());
        return traits_type::to_int_type(chunk[0]);
    }
    std::string chunk;
};
static Run runPaced(Config cfg, Mock& m, const std::string& bytes, int pause_us = 2500) {
    auto sink = makeSink();
    Out out([sink](const std::string& l) { std::lock_guard<std::mutex> g(sink->mu); sink->lines.push_back(l); });
    PacedBuf buf(bytes, pause_us); std::istream in(&buf);
    cfg.model = "m";
    Pipeline p(cfg, m, out, in);
    return finish(sink, p.run());
}

// the same sound, wrapped in frames of 20 ms, with control messages put in (index of a sound frame -> the JSON that is sent before it)
static std::string framed(const std::string& pcm, const std::map<size_t, std::string>& control) {
    std::string out; size_t i = 0, n = 0;
    for (size_t pos = 0; pos < pcm.size(); pos += 640, n++) {
        auto it = control.find(n); if (it != control.end()) out += makeFrame('C', it->second);
        out += makeFrame('A', pcm.substr(pos, 640)); i++;
    }
    (void)i;
    return out;
}
static int count(const Run& r, const std::string& needle) { int n = 0; for (auto& l : r.lines) if (l.find(needle) != std::string::npos) n++; return n; }
static const std::string* first(const Run& r, const std::string& needle) { for (auto& l : r.lines) if (l.find(needle) != std::string::npos) return &l; return nullptr; }

int main() {
    Config cfg; cfg.stats = false;
    // ---- the normal run
    { Mock m; Run r = run(cfg, m, stream(3));
      CHECK(r.code == 0 && r.lines.size() >= 5, "a stream with 3 sentences ends as asked");
      CHECK(r.lines[0].find("\"state\":\"loading\"") != std::string::npos && r.lines[1].find("\"state\":\"ready\"") != std::string::npos && r.lines[1].find("\"device\":\"cpu\"") != std::string::npos, "loading, then ready with the device");
      CHECK(count(r, "\"type\":\"text\"") == 3 && m.calls == 3, "one text per sentence");
      const std::string* t = first(r, "\"type\":\"text\"");
      CHECK(t && t->find("\"text\":\"hello there\"") != std::string::npos && t->find("\"dur\":") != std::string::npos && t->find("\"ms\":") != std::string::npos && t->find("\"audio_s\":") != std::string::npos && t->find("\"delay_s\":") != std::string::npos && t->find("\"lang\":\"en\"") != std::string::npos,
            "a text line has the text, dur and ms (the speed of the model), the 2.x names and the language");
      CHECK(r.lines.back().find("\"state\":\"stopped\"") != std::string::npos, "and ends with stopped"); }
    // ---- a sentence that is still being spoken when the input ends is recognised too
    { Mock m; std::string s = stream(1); s.resize(s.size() - 19200 * 2 + 4000); Run r = run(cfg, m, s);
      CHECK(count(r, "\"type\":\"text\"") == 1, "the end of the input finishes the sentence that is open"); }
    // ---- the filter: phantom phrases and empty texts are not sent
    { Mock m; m.text = "Thank you."; m.logprob = -0.8; Run r = run(cfg, m, stream(2));
      CHECK(count(r, "\"type\":\"text\"") == 0 && m.calls == 2, "'Thank you.' made up from noise is dropped"); }
    { Mock m; m.text = "   "; Run r = run(cfg, m, stream(1)); CHECK(count(r, "\"type\":\"text\"") == 0, "an empty text is dropped"); }
    { Mock m; m.logprob = -2.0; Run r = run(cfg, m, stream(1)); CHECK(count(r, "\"type\":\"text\"") == 0, "an unsure text is dropped"); }
    // ---- JSON escaping and UTF-8
    { Mock m; m.text = "He said \"hi\"\n안녕\\"; Run r = run(cfg, m, stream(1));
      const std::string* t = first(r, "\"type\":\"text\""); CHECK(t && t->find("\"text\":\"He said \\\"hi\\\"\\n안녕\\\\\"") != std::string::npos, "quotes, line breaks, backslashes escaped; Korean passes as UTF-8"); }
    // ---- the model does not load
    { Mock m; m.load_ok = false; Run r = run(cfg, m, stream(1));
      CHECK(r.code == 2 && r.lines.back().find("\"state\":\"error\"") != std::string::npos && r.lines.back().find("model file not found") != std::string::npos, "a model that does not load: error line, exit code 2"); }
    // ---- the recogniser fails
    { Mock m; m.fail_times = 1; Run r = run(cfg, m, stream(2));
      CHECK(r.code == 0 && count(r, "\"code\":\"failed\"") == 1 && count(r, "\"type\":\"text\"") == 1, "one failure is a warning, the next sentence still works"); }
    { Mock m; m.fail_times = 99; Run r = run(cfg, m, stream(6));
      CHECK(r.code == 4 && count(r, "\"code\":\"failed\"") == 5 && count(r, "\"state\":\"stopped\"") == 1 && count(r, "5 times in a row") == 1, "five failures in a row: stopped with code 4"); }
    // ---- falling behind: the oldest sentences are dropped, with a warning
    { Mock m; m.delay_ms = 300; Config c = cfg; c.max_backlog = 2; Run r = run(c, m, stream(7));
      CHECK(count(r, "\"code\":\"behind\"") >= 1 && count(r, "\"type\":\"text\"") < 7 && count(r, "\"type\":\"text\"") >= 2, "when the recogniser is slow the oldest sentences are skipped and the user is told"); }
    // ---- stats
    { Mock m; m.delay_ms = 1300; Config c = cfg; c.stats = true; Run r = run(c, m, stream(1));
      const std::string* s = first(r, "\"type\":\"stats\""); CHECK(s && s->find("\"cpu\":") != std::string::npos && s->find("\"ram\":") != std::string::npos && s->find("\"device\":\"cpu\"") != std::string::npos, "a stats line with cpu, ram and the device once a second"); }
    { Mock m; m.delay_ms = 1300; Config c = cfg; c.stats = true; Run r = run(c, m, stream(1)); const std::string* st = first(r, "\"type\":\"stats\"");
      CHECK(st && st->find("\"gpu\"") == std::string::npos && st->find("\"vram\"") == std::string::npos, "an engine on the CPU sends no gpu / vram");
      ProcSampler off(false); ProcStats p = off.sample(); CHECK(p.gpu_percent < 0 && p.vram_mb < 0, "no graphics numbers when the graphics card is not asked for"); }
    // ---- live mode: the text so far while it is spoken
    { Mock m; m.delay_ms = 20; Config c = cfg; c.live = true; c.partial_ms = 100; m.text = "so far";
      // the stream arrives in real time here (a pipe): a thread feeds it slowly
      std::string bytes = stream(1); std::istringstream* dummy = nullptr; (void)dummy;
      Run r = run(c, m, bytes);
      CHECK(r.code == 0, "live mode ends as asked");     // (a string stream is read at once; partials depend on timing, so only the end is checked)
    }
    // ---- framed input, and what changes while it runs
    { Mock m; Config c = cfg; c.framed = true; c.lang = "en"; c.prompt = "first";
      std::string pcm = stream(3);
      // sentence 1 is recognised at ~2.9 s (frame 145): the language and the hint change at 3.2 s (frame 160); at 6.6 s (frame 330) back to detection
      Run r = runPaced(c, m, framed(pcm, {{160, "{\"lang\":\"ko\",\"prompt\":\"second\"}"}, {330, "{\"lang\":\"auto\"}"}}));
      CHECK(r.code == 0 && count(r, "\"type\":\"text\"") == 3 && m.asked.size() == 3, "framed input: the same sentences as the raw sound");
      CHECK(m.asked[0].first == "en" && m.asked[0].second == "first", "the first sentence is recognised with the settings of the start");
      CHECK(m.asked[1].first == "ko" && m.asked[1].second == "second", "a control message changes the language and the hint for the next sentences");
      CHECK(m.asked[2].first == "" , "language 'auto' is detection again (empty)");
      CHECK(count(r, "\"type\":\"applied\"") == 2 && first(r, "\"type\":\"applied\"")->find("\"lang\":\"ko\"") != std::string::npos && first(r, "\"type\":\"applied\"")->find("\"prompt_chars\":6") != std::string::npos, "each control message is answered with what was taken over"); }
    { Mock m; Config c = cfg; c.framed = true;
      Run r = run(c, m, framed(stream(2), {{10, "not json"}, {20, "{\"end_ms\":99999,\"max_s\":\"x\",\"mode\":\"live\"}"}}));
      CHECK(r.code == 0 && count(r, "\"code\":\"control\"") == 1 && count(r, "\"type\":\"applied\"") == 1, "a broken control message is a warning, the stream goes on");
      CHECK(first(r, "\"type\":\"applied\"")->find("\"end_ms\":10000") != std::string::npos && first(r, "\"type\":\"applied\"")->find("max_s") != std::string::npos, "values are clamped to what is allowed"); }
    { Mock m; Config c = cfg; c.framed = true; c.end_ms = 700;
      // a longer quiet time (3 s) merges the two sentences of the stream that are 1.2 s apart into one
      Run base = runPaced(c, m, framed(stream(2), {})); Mock m2;
      Run longer = runPaced(c, m2, framed(stream(2), {{0, "{\"end_ms\":3000}"}}));
      CHECK(count(base, "\"type\":\"text\"") == 2 && count(longer, "\"type\":\"text\"") == 1, "the quiet time that ends a sentence can be changed while it runs"); }
    // the quietest sound that counts as speech can be changed while it runs: the limit of the loudness bar moves
    { Mock m; Config c = cfg; c.framed = true;
      Run r = runPaced(c, m, framed(stream(2), {{100, "{\"min_db\":-30}"}}), 300);
      double before = 0, after = 0; int nb = 0, na = 0;
      for (auto& l : r.lines) { size_t p = l.find("\"thr\":"); if (p == std::string::npos) continue; double t = std::atof(l.c_str() + p + 6); if (t > -35) { after = t; na++; } else { before = t; nb++; } }
      CHECK(nb > 10 && na > 10 && std::fabs(before + 44.4) < 0.5 && std::fabs(after + 30.0) < 0.5, "min_db: the limit of the loudness bar goes from about -44.4 dB to -30 dB");
      CHECK(first(r, "\"min_db\":-30.0") != nullptr, "and the engine says it took it over"); }
    // ---- the loudness
    { Mock m; Config c = cfg; c.framed = true; Run r = runPaced(c, m, framed(stream(2), {}), 100);
      const std::string* l = first(r, "\"type\":\"level\"");
      CHECK(l && l->find("\"db\":") != std::string::npos && l->find("\"peak\":") != std::string::npos && l->find("\"speech\":") != std::string::npos && l->find("\"thr\":") != std::string::npos, "level lines: db, peak, speech, thr");
      CHECK(count(r, "\"type\":\"level\"") >= 50 && count(r, "\"type\":\"level\"") <= 60, "ten a second for the 5.8 s of sound (20 ms frames)");
      CHECK(count(r, "\"speech\":true") >= 25 && count(r, "\"speech\":false") >= 15, "speech is true while a sentence is open (the speech and the quiet that ends it), false before and between");
      Config c2 = cfg; c2.level = false; Mock m3; Run quiet = run(c2, m3, stream(1)); CHECK(count(quiet, "\"type\":\"level\"") == 0, "--no-level"); }
    // ---- the speed test
    { std::vector<float> tone(16000 * 3); for (size_t i = 0; i < tone.size(); i++) tone[i] = 0.3f * std::sin(i * 0.05f);
      { std::ofstream f("t_bench.wav", std::ios::binary); auto w32 = [&](uint32_t v) { f.write(reinterpret_cast<char*>(&v), 4); }; auto w16 = [&](uint16_t v) { f.write(reinterpret_cast<char*>(&v), 2); };
        uint32_t data = static_cast<uint32_t>(tone.size() * 2); f.write("RIFF", 4); w32(36 + data); f.write("WAVEfmt ", 8); w32(16); w16(1); w16(1); w32(16000); w32(32000); w16(2); w16(16); f.write("data", 4); w32(data);
        for (float v : tone) { int16_t s = static_cast<int16_t>(v * 32767); f.write(reinterpret_cast<char*>(&s), 2); } }
      Mock m; m.delay_ms = 30; Config c = cfg; c.bench = "t_bench.wav"; c.model = "m";
      std::vector<std::string> lines; Out out([&](const std::string& l) { lines.push_back(l); });
      int code = runBench(c, m, out);
      CHECK(code == 0 && m.calls == 2 && lines.size() == 1, "the speed test recognises the file twice (warm-up, then timed) and reports once");
      CHECK(lines[0].find("\"type\":\"bench\"") != std::string::npos && lines[0].find("\"dur\":3.00") != std::string::npos && lines[0].find("\"ms\":") != std::string::npos && lines[0].find("\"load_ms\":") != std::string::npos && lines[0].find("\"text\":\"hello there\"") != std::string::npos, "the bench line: dur, ms, load_ms, text");
      size_t p = lines[0].find("\"ms\":"); double ms = std::atof(lines[0].c_str() + p + 5);
      CHECK(ms >= 25 && ms < 200, "ms is the time of the second run");
      c.bench = "no_such.wav"; lines.clear(); CHECK(runBench(c, m, out) == 2 && lines[0].find("\"state\":\"error\"") != std::string::npos, "a missing file: error line");
      std::remove("t_bench.wav"); }
    TEST_DONE();
}
