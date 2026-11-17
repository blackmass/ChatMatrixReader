// Throws away what an engine makes up from noise (Whisper is known to write "Thank you." for silence and music).
// A port of sttcore/filters.py of the 2.x reader.
#pragma once
#include <optional>
#include <string>

namespace cmr {

struct Keep {
    bool ok;
    std::string why;     // "" when kept; else "empty" | "no speech (...)" | "unsure (...)" | "phantom phrase"
};

// avg_logprob / no_speech_prob: what the engine said about its own text (not given = not used)
Keep keep(const std::string& text, double audio_s, std::optional<double> avg_logprob = std::nullopt,
          std::optional<double> no_speech_prob = std::nullopt, double min_logprob = -1.6, double max_no_speech = 0.6);

// does the UTF-8 text contain a "word" character (Python's \w: letters, digits, underscore of any language)?
bool hasWordChar(const std::string& utf8);

}  // namespace cmr
