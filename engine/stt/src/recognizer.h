// What the pipeline needs from a speech recogniser. The real one is whisper_engine.cpp (whisper.cpp); the tests use a stand-in.
#pragma once
#include <optional>
#include <string>
#include <vector>

namespace cmr {

struct Result {
    std::string text;
    std::optional<double> avg_logprob, no_speech_prob;     // how sure the recogniser was (used by the filter)
    std::string language;                                  // what it detected ("" = not known)
};

class Recognizer {
public:
    virtual ~Recognizer() = default;
    // loads the model; false + error text when it cannot ("loading" can take seconds)
    virtual bool load(std::string& error) = 0;
    // 16 kHz mono float samples in [-1, 1]; language "" = detect; prompt = a hint ("" = none)
    virtual std::vector<Result> transcribe(const std::vector<float>& audio, const std::string& language, const std::string& prompt) = 0;
    virtual std::string device() const = 0;                // "cpu" | "gpu": what it computes on
    virtual std::string describe() const = 0;              // "Whisper large-v3-turbo on cpu"
};

}  // namespace cmr
