#include "segmenter.h"

#include <algorithm>
#include <cmath>

namespace cmr {

namespace {
// Python's int(round(ms / frame_ms)) (halves go to the even number), at least 1
int frames_of(double ms, int frame_ms) {
    int n = static_cast<int>(std::nearbyint(ms / frame_ms));
    return std::max(1, n);
}
}  // namespace

Segmenter::Segmenter(const SegParams& p) {
    frame_ms_ = p.frame_ms;
    sr_ = p.sr;
    fl_ = static_cast<int>(p.sr * p.frame_ms / 1000);
    start_n_ = frames_of(p.start_ms, p.frame_ms);
    end_n_ = frames_of(p.end_ms, p.frame_ms);
    min_n_ = frames_of(p.min_ms, p.frame_ms);
    max_n_ = frames_of(p.max_s * 1000, p.frame_ms);
    pre_n_ = frames_of(p.preroll_ms, p.frame_ms);
    tail_n_ = frames_of(p.tail_ms, p.frame_ms);
    min_rms_ = p.min_rms;
    ratio_ = p.ratio;
    pre_cap_ = static_cast<size_t>(pre_n_ + start_n_);
}

void Segmenter::setParams(int end_ms, double max_s) {
    end_n_ = frames_of(end_ms, frame_ms_);
    max_n_ = frames_of(max_s * 1000, frame_ms_);
}

// the 20th percentile of the quiet frames (numpy's linear interpolation), at most 0.05
double Segmenter::floor() const {
    if (floor_hist_.size() < 10) return 0.0;
    std::vector<double> v(floor_hist_.begin(), floor_hist_.end());
    std::sort(v.begin(), v.end());
    double k = (v.size() - 1) * 0.2;
    size_t lo = static_cast<size_t>(std::floor(k));
    size_t hi = std::min(lo + 1, v.size() - 1);
    double p = v[lo] + (v[hi] - v[lo]) * (k - lo);
    return std::min(p, 0.05);
}

void Segmenter::thresholds(double& on, double& off) const {
    double f = floor() * ratio_;
    on = std::max(min_rms_, f);
    off = std::max(min_rms_ * 0.6, f * 0.6);        // (start, keep going)
}

std::vector<Samples> Segmenter::feed(const float* x, size_t n) {
    buf_.insert(buf_.end(), x, x + n);
    std::vector<Samples> out;
    size_t nfr = buf_.size() / fl_;
    for (size_t i = 0; i < nfr; i++) frame(buf_.data() + i * fl_, out);
    buf_.erase(buf_.begin(), buf_.begin() + nfr * fl_);
    return out;
}

void Segmenter::frame(const float* x, std::vector<Samples>& out) {
    double sq = 0;
    for (int i = 0; i < fl_; i++) sq += static_cast<double>(x[i]) * x[i];
    double rms = std::sqrt(sq / fl_);
    last_rms_ = rms;
    double on, off;
    thresholds(on, off);
    Frame fr{Samples(x, x + fl_), rms};
    if (!speaking_) {
        pre_.push_back(std::move(fr));
        if (pre_.size() > pre_cap_) pre_.pop_front();
        if (rms >= on) {
            voiced_++;
        } else {
            voiced_ = 0;
            floor_hist_.push_back(rms);
            if (floor_hist_.size() > 150) floor_hist_.pop_front();
        }
        if (voiced_ >= start_n_) {
            speaking_ = true;
            frames_.assign(pre_.begin(), pre_.end());
            lead_ = static_cast<int>(frames_.size()) - voiced_;
            pre_.clear();
            silent_ = 0;
        }
        return;
    }
    frames_.push_back(std::move(fr));
    if (rms < off) {
        silent_++;
        floor_hist_.push_back(rms);
        if (floor_hist_.size() > 150) floor_hist_.pop_front();
    } else {
        silent_ = 0;
    }
    if (silent_ >= end_n_) finish(out);
    else if (static_cast<int>(frames_.size()) >= max_n_) cut(out);
}

void Segmenter::reset() {
    speaking_ = false;
    frames_.clear();
    voiced_ = silent_ = lead_ = 0;
    pre_.clear();
}

void Segmenter::finish(std::vector<Samples>& out) {
    int speech = static_cast<int>(frames_.size()) - lead_ - silent_;
    if (speech >= min_n_) {
        size_t keep = std::min(frames_.size(), static_cast<size_t>(lead_ + speech + tail_n_));
        Samples s;
        s.reserve(keep * fl_);
        for (size_t i = 0; i < keep; i++) s.insert(s.end(), frames_[i].s.begin(), frames_[i].s.end());
        out.push_back(std::move(s));
    }
    reset();
}

// too long: cut at the quietest frame in the last third and go on with the rest
void Segmenter::cut(std::vector<Samples>& out) {
    size_t n = frames_.size(), lo = n * 2 / 3, idx = lo;
    for (size_t i = lo; i < n; i++) if (frames_[i].rms < frames_[idx].rms) idx = i;       // (the first minimum, like numpy's argmin)
    Samples s;
    for (size_t i = 0; i <= idx; i++) s.insert(s.end(), frames_[i].s.begin(), frames_[i].s.end());
    out.push_back(std::move(s));
    frames_.erase(frames_.begin(), frames_.begin() + idx + 1);
    silent_ = 0;
    lead_ = 0;
}

Samples Segmenter::snapshot() const {
    Samples s;
    if (!speaking_ || frames_.empty()) return s;
    for (const Frame& f : frames_) s.insert(s.end(), f.s.begin(), f.s.end());
    return s;
}

std::vector<Samples> Segmenter::flush() {
    std::vector<Samples> out;
    if (speaking_) finish(out);
    reset();
    return out;
}

}  // namespace cmr
