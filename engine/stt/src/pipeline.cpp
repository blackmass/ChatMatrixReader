#include "pipeline.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>

#include "filters.h"
#include "pcm.h"
#include "procstats.h"
#include "protocol.h"
#include "segmenter.h"

namespace cmr {

namespace {
using Clock = std::chrono::steady_clock;
double secondsSince(Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); }
double toDb(double linear) { return 20.0 * std::log10(std::max(linear, 1e-6)); }

struct Queue {
    struct Item { Samples audio; Clock::time_point in; };
    std::mutex mu;
    std::condition_variable cv;
    std::deque<Item> sentences;
    Samples partial; long long partial_gen = 0; bool has_partial = false;      // the newest "sentence so far" (live mode)
    long long gen = 0;                                                         // counts finished sentences: a partial of an older one is stale
    bool done = false;
    std::atomic<bool> stop{false};
};

// what can change while it runs (control messages, protocol.h); read by the reader thread and by the recogniser loop
struct Live {
    std::mutex mu;
    std::string lang, prompt;
    bool live = false;
    int partial_ms = 1000;
};

int clampInt(const std::string& s, int lo, int hi, int def) {
    char* end = nullptr; double d = std::strtod(s.c_str(), &end);
    if (end == s.c_str() || *end != 0) return def;
    return static_cast<int>(std::min<double>(hi, std::max<double>(lo, d)));
}
}  // namespace

int Pipeline::run() {
    Out& out = out_;
    out.emit(Msg("status").str("state", "loading").str("msg", "loading the model (the first time this can take a while) ..."));
    auto t0 = Clock::now();
    std::string error;
    if (!rec_.load(error)) { out.emit(Msg("status").str("state", "error").str("msg", error)); return 2; }
    out.emit(Msg("status").str("state", "ready").str("device", rec_.device())
                 .str("msg", rec_.describe() + " - loaded in " + jsonNum(secondsSince(t0), 1) + " s"));

    // The reader owns its state (a shared queue and its own copy of everything else): if the recogniser fails for good we leave without waiting for
    // it (it can be stuck in a read of the standard input until the program closes it).
    auto qp = std::make_shared<Queue>();
    auto livep = std::make_shared<Live>();
    livep->lang = cfg_.lang; livep->prompt = cfg_.prompt; livep->live = cfg_.live; livep->partial_ms = cfg_.partial_ms;
    Queue& q = *qp;
    Segmenter probe(cfg_.seg());
    const double end_s_default = probe.endFrames() * probe.frameSeconds();
    const Config cfg = cfg_;
    std::istream* inp = &in_;
    Out* outp = &out;

    auto push = [](Queue& q, Out& out, int max_backlog, Samples s) {
        long long lost = 0;
        {
            std::lock_guard<std::mutex> g(q.mu);
            q.gen++;
            q.has_partial = false;                          // the finished sentence replaces whatever was shown while it was spoken
            q.sentences.push_back({std::move(s), Clock::now()});
            while (static_cast<int>(q.sentences.size()) > max_backlog) { q.sentences.pop_front(); lost++; }
        }
        q.cv.notify_one();
        if (lost) out.emit(Msg("warn").str("code", "behind").integer("lost", lost).str("msg", "recognition is behind: " + std::to_string(lost) + " older sentence(s) skipped"));
    };

    // ---- the reader
    std::thread reader([qp, livep, cfg, inp, outp, push] {
        Queue& q = *qp;
        Live& live = *livep;
        Segmenter seg(cfg.seg());
        int end_ms = cfg.end_ms; double max_s = cfg.max_s;
        std::vector<uint8_t> carry;
        std::vector<float> samples;
        auto last_partial = Clock::now();
        double sumsq = 0, peak = 0; size_t nlevel = 0;                      // the loudness of the last ~100 ms

        auto onSamples = [&] {
            if (samples.empty()) return;
            for (auto& s : seg.feed(samples.data(), samples.size())) push(q, *outp, cfg.max_backlog, std::move(s));
            if (cfg.level) {
                for (float v : samples) { sumsq += static_cast<double>(v) * v; peak = std::max(peak, static_cast<double>(std::fabs(v))); }
                nlevel += samples.size();
                if (nlevel >= 1600) {
                    outp->emit(Msg("level").num("db", toDb(std::sqrt(sumsq / nlevel)), 1).num("peak", peak, 3).boolean("speech", seg.speaking()).num("thr", toDb(seg.startThreshold()), 1));
                    sumsq = 0; peak = 0; nlevel = 0;
                }
            }
            bool is_live; int partial_ms;
            { std::lock_guard<std::mutex> g(live.mu); is_live = live.live; partial_ms = live.partial_ms; }
            if (is_live && seg.speaking() && secondsSince(last_partial) >= partial_ms / 1000.0) {
                Samples snap = seg.snapshot();
                if (snap.size() >= 9600) {                   // < 0.6 s: nothing to read yet
                    last_partial = Clock::now();
                    { std::lock_guard<std::mutex> g(q.mu); q.partial = std::move(snap); q.partial_gen = q.gen; q.has_partial = true; }
                    q.cv.notify_one();
                }
            }
        };

        auto control = [&](const std::vector<uint8_t>& payload) {
            std::map<std::string, std::string> m;
            if (!parseFlatObject(std::string(payload.begin(), payload.end()), m)) {
                outp->emit(Msg("warn").str("code", "control").str("msg", "a control message that is not a JSON object was ignored"));
                return;
            }
            Msg applied("applied");
            {
                std::lock_guard<std::mutex> g(live.mu);
                if (m.count("lang")) { live.lang = m["lang"] == "auto" ? "" : m["lang"]; applied.str("lang", m["lang"]); }
                if (m.count("prompt")) { live.prompt = m["prompt"].substr(0, 400); applied.integer("prompt_chars", static_cast<long long>(live.prompt.size())); }
                if (m.count("mode")) { live.live = m["mode"] == "live"; applied.str("mode", m["mode"]); }
                if (m.count("partial_ms")) { live.partial_ms = clampInt(m["partial_ms"], 100, 10000, live.partial_ms); applied.integer("partial_ms", live.partial_ms); }
            }
            if (m.count("end_ms")) { end_ms = clampInt(m["end_ms"], 100, 10000, end_ms); applied.integer("end_ms", end_ms); }
            if (m.count("max_s")) { max_s = clampInt(m["max_s"], 1, 60, static_cast<int>(max_s)); applied.integer("max_s", static_cast<long long>(max_s)); }
            seg.setParams(end_ms, max_s);
            if (m.count("min_db")) {
                char* end = nullptr; double d = std::strtod(m["min_db"].c_str(), &end);
                if (end != m["min_db"].c_str() && *end == 0) { d = std::min(-10.0, std::max(-80.0, d)); seg.setMinRms(std::pow(10.0, d / 20.0)); applied.num("min_db", d, 1); }
            }
            outp->emit(applied);
        };

        if (cfg.framed) {
            Frame f; size_t skipped = 0, warned = 0;
            while (!q.stop && readFrame(*inp, f, skipped)) {
                if (skipped > warned) { warned = skipped; outp->emit(Msg("warn").str("code", "frames").integer("skipped", static_cast<long long>(skipped)).str("msg", "bytes outside of a frame were skipped")); }
                if (f.type == 'A') { samples.clear(); decodePcm(cfg.pcm, carry, f.payload.data(), f.payload.size(), samples); onSamples(); }
                else if (f.type == 'C') control(f.payload);
            }
        } else {
            std::vector<uint8_t> buf(1280 * 4);
            while (!q.stop && inp->good()) {
                inp->read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
                std::streamsize got = inp->gcount();
                if (got <= 0) break;
                samples.clear();
                decodePcm(cfg.pcm, carry, buf.data(), static_cast<size_t>(got), samples);
                onSamples();
            }
        }
        for (auto& s : seg.flush()) push(q, *outp, cfg.max_backlog, std::move(s));
        { std::lock_guard<std::mutex> g(q.mu); q.done = true; }
        q.cv.notify_all();
    });

    // ---- the stats
    std::thread stats;
    std::atomic<bool> stats_stop{false};
    std::mutex stats_mu; std::condition_variable stats_cv;
    if (cfg_.stats) {
        stats = std::thread([&] {
            ProcSampler sampler(rec_.device() == "gpu");      // (the graphics card is looked at only when it is the one that computes)
            std::unique_lock<std::mutex> lk(stats_mu);
            while (!stats_stop) {
                if (stats_cv.wait_for(lk, std::chrono::seconds(1), [&] { return stats_stop.load(); })) break;
                ProcStats s = sampler.sample();
                Msg m("stats");
                m.num("cpu", s.cpu_percent, 1).num("ram", s.ram_mb, 0);
                if (s.gpu_percent >= 0) m.num("gpu", s.gpu_percent, 1);
                if (s.vram_mb >= 0) m.num("vram", s.vram_mb, 0);
                if (s.gpu_percent < 0 && !s.gpu_why.empty()) m.str("gpu_why", s.gpu_why);
                if (s.vram_mb < 0 && !s.vram_why.empty()) m.str("vram_why", s.vram_why);
                out.emit(m.str("device", rec_.device()));
            }
        });
    }

    // ---- the recogniser
    int errors = 0, code = 0;
    std::string last_partial_text;
    for (;;) {
        Queue::Item item;
        Samples part; long long part_gen = 0; bool have_part = false;
        {
            std::unique_lock<std::mutex> lk(q.mu);
            q.cv.wait(lk, [&] { return !q.sentences.empty() || q.has_partial || q.done; });
            if (!q.sentences.empty()) { item = std::move(q.sentences.front()); q.sentences.pop_front(); }
            else if (q.has_partial) { part = std::move(q.partial); part_gen = q.partial_gen; q.has_partial = false; have_part = true; }
            else break;                                     // done, and nothing left
        }
        std::string lang, prompt;
        { std::lock_guard<std::mutex> g(livep->mu); lang = livep->lang; prompt = livep->prompt; }      // (they may have been changed since the last sentence)
        if (have_part) {
            try {
                auto t1 = Clock::now();
                auto results = rec_.transcribe(part, lang, prompt);
                double infer = secondsSince(t1), audio_s = part.size() / 16000.0;
                std::string text;
                for (auto& r : results) if (keep(r.text, audio_s, r.avg_logprob, r.no_speech_prob).ok) { if (!text.empty()) text += " "; text += r.text; }
                long long gen_now; { std::lock_guard<std::mutex> g(q.mu); gen_now = q.gen; }
                if (!text.empty() && text != last_partial_text && part_gen == gen_now) {
                    last_partial_text = text;
                    out.emit(Msg("partial").str("text", text).num("audio_s", audio_s, 2).num("infer_s", infer, 3));
                }
            } catch (const std::exception&) { /* a partial that fails is not worth a warning */ }
            continue;
        }
        double waited = secondsSince(item.in), audio_s = item.audio.size() / 16000.0;
        auto t1 = Clock::now();
        std::vector<Result> results;
        try {
            results = rec_.transcribe(item.audio, lang, prompt);
            errors = 0;
        } catch (const std::exception& e) {
            errors++;
            out.emit(Msg("warn").str("code", "failed").str("error", e.what()).str("msg", std::string("recognition failed: ") + e.what()));
            if (errors >= 5) {
                out.emit(Msg("status").str("state", "error").str("msg", std::string("recognition failed 5 times in a row - stopped (") + e.what() + ")"));
                q.stop = true; code = 4; break;
            }
            continue;
        }
        double infer = secondsSince(t1);
        std::string text, detected;
        for (auto& r : results) {
            if (keep(r.text, audio_s, r.avg_logprob, r.no_speech_prob).ok) {
                std::string t = r.text;
                size_t a = t.find_first_not_of(" \t\r\n"), b = t.find_last_not_of(" \t\r\n");
                t = a == std::string::npos ? "" : t.substr(a, b - a + 1);
                if (!text.empty()) text += " ";
                text += t;
            }
        }
        if (!results.empty()) detected = results[0].language;
        last_partial_text.clear();
        if (!text.empty()) {
            // `dur` and `ms` are what the options use to show how fast the model is (core/voice_bench.js); the other names are 2.x's
            Msg m("text");
            m.str("text", text).num("dur", audio_s, 2).num("ms", infer * 1000.0, 0).num("audio_s", audio_s, 2).num("infer_s", infer, 3).num("delay_s", end_s_default + waited + infer, 2);
            if (!detected.empty()) m.str("lang", detected);
            out.emit(m);
        }
    }
    q.stop = true;
    { std::lock_guard<std::mutex> g(stats_mu); stats_stop = true; }
    stats_cv.notify_all();
    if (stats.joinable()) stats.join();
    if (code == 0) { if (reader.joinable()) reader.join(); } else reader.detach();
    out.emit(Msg("status").str("state", "stopped").str("msg", "stopped"));
    return code;
}

}  // namespace cmr
