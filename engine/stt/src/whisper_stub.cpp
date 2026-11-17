#include "whisper_engine.h"

namespace cmr {
namespace {
class NoWhisper : public Recognizer {
public:
    bool load(std::string& error) override { error = "this engine was built without Whisper (CMake option CMR_WITH_WHISPER)"; return false; }
    std::vector<Result> transcribe(const std::vector<float>&, const std::string&, const std::string&) override { return {}; }
    std::string device() const override { return "cpu"; }
    std::string describe() const override { return "no recogniser"; }
};
}  // namespace
std::unique_ptr<Recognizer> makeWhisper(const Config&) { return std::make_unique<NoWhisper>(); }
}  // namespace cmr
