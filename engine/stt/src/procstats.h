// How much of the computer this program uses (the once-a-second "stats" line). CPU: share of the whole CPU, like the task manager; RAM: working set.
// GPU (Windows only, only when asked for): gpu_percent = the busiest engine of this program like the task manager's GPU column, vram_mb = graphics memory
// this program holds (dedicated + shared). -1 = not known (no GPU wanted, not Windows, or the system does not tell).
#pragma once

#include <memory>
#include <string>

namespace cmr {

struct ProcStats { double cpu_percent = 0; double ram_mb = 0; double gpu_percent = -1; double vram_mb = -1;
                 std::string gpu_why, vram_why; };     // (why a graphics number is not known: a short text with the system's error code, for the options window)

class ProcSampler {
public:
    explicit ProcSampler(bool gpu = false);
    ~ProcSampler();
    ProcStats sample();      // call about once a second; the CPU share is over the time since the last call
private:
    double last_cpu_ = 0, last_wall_ = 0;
    struct Gpu;
    std::unique_ptr<Gpu> gpu_;
};

}  // namespace cmr
