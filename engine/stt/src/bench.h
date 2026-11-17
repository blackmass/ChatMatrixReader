// The speed test: one sound file through the model, to compare models on the same sound (the options 모델 목록과 속도).
//   cmr-stt --bench <file.wav> --model <path> --device cpu|gpu
// Loads the model, recognises the file once to warm up, then again; reports the second run's time:
//   {"type":"bench","dur":<seconds of sound>,"ms":<recognising time>,"load_ms":<loading time>,"text":"what it heard"}
#pragma once
#include <string>
#include <vector>

#include "config.h"
#include "json.h"
#include "recognizer.h"

namespace cmr {

// a WAV file (16 bit integer or 32 bit float, any number of channels, 16000 Hz) -> mono samples; false + error text when it cannot be used
bool readWav(const std::string& path, std::vector<float>& samples, std::string& error);

int runBench(const Config& cfg, Recognizer& rec, Out& out);          // 0 = reported, 2 = failed (a status error line says why)

}  // namespace cmr
