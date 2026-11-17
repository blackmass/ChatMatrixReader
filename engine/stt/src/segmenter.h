// Cuts a stream of 16 kHz mono audio into sentences (speech segments) with a simple energy detector.
// A port of sttcore/segmenter.py of the 2.x reader (same numbers, same rules; tests/golden/ was made by that Python code).
//
// No model: a frame is "speech" when its RMS is well above the noise floor that is measured on the quiet frames in between (so a quiet and a
// loud voice chat both work). A segment ends after `end_ms` of quiet; a very long one is cut at its quietest point near the end so the
// recogniser never gets more than `max_s` seconds.
#pragma once
#include <cstddef>
#include <deque>
#include <vector>

namespace cmr {

struct SegParams {
    int sr = 16000, frame_ms = 30, start_ms = 90, end_ms = 700, min_ms = 350;
    double max_s = 12.0;
    int preroll_ms = 300, tail_ms = 200;
    double min_rms = 0.006, ratio = 3.0;
};

using Samples = std::vector<float>;

class Segmenter {
public:
    explicit Segmenter(const SegParams& p = SegParams());

    // samples of any length; returns the sentences that were finished by them (usually none)
    std::vector<Samples> feed(const float* x, size_t n);
    // the sound of the sentence that is being spoken right now (for partial results); empty when nobody speaks
    Samples snapshot() const;
    // the source ended: what is being collected is a sentence too
    std::vector<Samples> flush();

    // changes the end-of-sentence quiet time and the longest piece while it runs (a sentence that is open goes on with the new values)
    void setParams(int end_ms, double max_s);
    // the quietest sound that can be speech (RMS, 0.006 = -44 dB); a noise floor that is louder than this moves the limit up by itself
    void setMinRms(double min_rms) { min_rms_ = min_rms; }
    // the loudness (RMS) from which a frame counts as speech now (the noise floor makes it move)
    double startThreshold() const { double on, off; thresholds(on, off); return on; }

    bool speaking() const { return speaking_; }
    double lastRms() const { return last_rms_; }
    int endFrames() const { return end_n_; }
    double frameSeconds() const { return frame_ms_ / 1000.0; }

private:
    struct Frame { Samples s; double rms; };
    double floor() const;
    void thresholds(double& on, double& off) const;
    void frame(const float* x, std::vector<Samples>& out);
    void reset();
    void finish(std::vector<Samples>& out);
    void cut(std::vector<Samples>& out);

    int frame_ms_, fl_, start_n_, end_n_, min_n_, max_n_, pre_n_, tail_n_;
    int sr_ = 16000;
    double min_rms_, ratio_;
    Samples buf_;
    std::deque<Frame> pre_;
    size_t pre_cap_;
    std::deque<double> floor_hist_;
    std::vector<Frame> frames_;
    bool speaking_ = false;
    int voiced_ = 0, silent_ = 0, lead_ = 0;
    double last_rms_ = 0.0;
};

}  // namespace cmr
