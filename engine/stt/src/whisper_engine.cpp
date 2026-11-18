// The Whisper recogniser, on whisper.cpp (official source; the version is in whisper.version). Only this file knows whisper.cpp.
//
// What the 2.x reader asked faster-whisper for, as closely as whisper.cpp allows:
//   greedy decoding (beam 1), no text of earlier sentences as context, the hint as initial prompt, "no speech" limit 0.6, the usual temperature fallback.
// Not done here: faster-whisper's built-in voice filter (vad_filter). The sentences are cut by our own segmenter before they get here and
// the filters (filters.cpp) drop what Whisper makes up from silence.
#include "whisper_engine.h"

#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <thread>

#include "ggml-backend.h"
#include "whisper.h"

namespace cmr {

namespace {

// whisper.cpp / ggml write a lot to the standard error by default; keep warnings and errors only (the log line for people)
void logCallback(enum ggml_log_level level, const char* text, void*) {
    if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR) std::fputs(text, stderr);
}

class WhisperRecognizer : public Recognizer {
public:
    explicit WhisperRecognizer(const Config& cfg) : cfg_(cfg) {}
    ~WhisperRecognizer() override { if (ctx_) whisper_free(ctx_); }

    bool load(std::string& error) override {
        whisper_log_set(logCallback, nullptr);
        whisper_context_params cp = whisper_context_default_params();
        cp.use_gpu = cfg_.device == "gpu";
        ctx_ = whisper_init_from_file_with_params(cfg_.model.c_str(), cp);
        if (!ctx_) { error = "cannot load the model " + cfg_.model + " (missing, damaged, or not a Whisper model file)"; return false; }
        // a GPU was asked for: it is used when this build has a GPU backend and a device for it, else whisper.cpp computes on the CPU
        gpu_ = cp.use_gpu && (ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU) != nullptr || ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU) != nullptr);
        return true;
    }

    std::vector<Result> transcribe(const std::vector<float>& audio, const std::string& language, const std::string& prompt) override {
        whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        p.greedy.best_of = 1;
        p.n_threads = cfg_.threads > 0 ? cfg_.threads : static_cast<int>(std::min(8u, std::max(1u, std::thread::hardware_concurrency())));
        p.no_context = true;                      // faster-whisper: condition_on_previous_text=False
        p.print_special = p.print_progress = p.print_realtime = p.print_timestamps = false;
        p.suppress_nst = true;                    // no "(music)" style tokens, as in faster-whisper's default suppression
        p.no_speech_thold = 0.6f;
        p.language = language.empty() ? "auto" : language.c_str();
        p.detect_language = false;                // (true would only detect the language and stop)
        p.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
        if (whisper_full(ctx_, p, audio.data(), static_cast<int>(audio.size())) != 0) throw std::runtime_error("whisper_full failed");

        std::vector<Result> out;
        const char* lang = whisper_lang_str(whisper_full_lang_id(ctx_));
        const whisper_token eot = whisper_token_eot(ctx_);
        int n = whisper_full_n_segments(ctx_);
        for (int i = 0; i < n; i++) {
            Result r;
            const char* t = whisper_full_get_segment_text(ctx_, i);
            r.text = t ? t : "";
            r.no_speech_prob = whisper_full_get_segment_no_speech_prob(ctx_, i);
            // the mean log probability of the text tokens (special tokens are not text): the filter's "how sure was it"
            double sum = 0; int cnt = 0;
            for (int k = 0, nt = whisper_full_n_tokens(ctx_, i); k < nt; k++) {
                whisper_token_data d = whisper_full_get_token_data(ctx_, i, k);
                if (d.id < eot) { sum += d.plog; cnt++; }
            }
            if (cnt > 0) r.avg_logprob = sum / cnt;
            r.language = lang ? lang : "";
            out.push_back(std::move(r));
        }
        return out;
    }

    std::string device() const override { return gpu_ ? "gpu" : "cpu"; }
    std::string describe() const override {
        std::string m = cfg_.model;
        size_t s = m.find_last_of("/\\");
        if (s != std::string::npos) m = m.substr(s + 1);
        if (m.rfind("ggml-", 0) == 0) m = m.substr(5);
        if (m.size() > 4 && m.compare(m.size() - 4, 4, ".bin") == 0) m.resize(m.size() - 4);
        std::string d = cfg_.device == "gpu" && !gpu_ ? " (no GPU backend in this build: cpu)" : "";
        return "Whisper " + m + " on " + device() + d;
    }

private:
    Config cfg_;
    whisper_context* ctx_ = nullptr;
    bool gpu_ = false;
};

}  // namespace

std::unique_ptr<Recognizer> makeWhisper(const Config& cfg) { return std::make_unique<WhisperRecognizer>(cfg); }

}  // namespace cmr
