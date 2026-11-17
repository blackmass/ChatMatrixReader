// The Whisper recogniser (whisper.cpp). Built only with -DCMR_WITH_WHISPER=ON (CMakeLists.txt); without it `makeWhisper` gives a recogniser that
// says so when it is asked to load.
#pragma once
#include <memory>

#include "config.h"
#include "recognizer.h"

namespace cmr {
std::unique_ptr<Recognizer> makeWhisper(const Config& cfg);
}
