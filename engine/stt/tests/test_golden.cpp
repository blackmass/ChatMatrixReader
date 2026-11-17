// The segmenter and the filter against what the 2.x Python code gave for the same input (tests/golden/, made by tools/make_golden_stt.py).
//   test_golden <golden folder>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../src/filters.h"
#include "../src/segmenter.h"
#include "check.h"

using namespace cmr;

static std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out; std::string cur;
    for (char c : s) { if (c == sep) { out.push_back(cur); cur.clear(); } else cur.push_back(c); }
    out.push_back(cur);
    return out;
}

static std::vector<float> readPcm(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::vector<char> raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    std::vector<float> x(raw.size() / 2);
    for (size_t i = 0; i < x.size(); i++) {
        int16_t v = static_cast<int16_t>(static_cast<uint8_t>(raw[2 * i]) | (static_cast<uint8_t>(raw[2 * i + 1]) << 8));
        x[i] = static_cast<float>(v) / 32768.0f;
    }
    return x;
}

static void segmenterCase(const std::string& dir, const std::string& file) {
    std::ifstream f(dir + "/" + file);
    std::string line, input; SegParams p; bool flush = true; std::vector<int> chunks;
    struct Want { size_t len; double sum, first, last; }; std::vector<Want> want; int wantSpeaking = 0;
    while (std::getline(f, line)) {
        std::istringstream is(line); std::string key; is >> key;
        if (key == "input") is >> input;
        else if (key == "params") { std::string kv; while (is >> kv) { auto e = split(kv, '='); double v = std::stod(e[1]);
            if (e[0] == "end_ms") p.end_ms = (int)v; else if (e[0] == "min_ms") p.min_ms = (int)v; else if (e[0] == "max_s") p.max_s = v; else CHECK(false, "unknown parameter in a golden file"); } }
        else if (key == "flush") { int v; is >> v; flush = v != 0; }
        else if (key == "chunks") { int c; while (is >> c) chunks.push_back(c); }
        else if (key == "seg") { Want w; is >> w.len >> w.sum >> w.first >> w.last; want.push_back(w); }
        else if (key == "end") { std::string kv; is >> kv; wantSpeaking = kv == "speaking=1"; }
    }
    std::vector<float> x = readPcm(dir + "/" + input);
    Segmenter seg(p);
    std::vector<Samples> got;
    size_t pos = 0, k = 0;
    while (pos < x.size()) {
        size_t c = static_cast<size_t>(chunks[k++ % chunks.size()]);
        c = std::min(c, x.size() - pos);
        for (auto& s : seg.feed(x.data() + pos, c)) got.push_back(std::move(s));
        pos += c;
    }
    if (flush) for (auto& s : seg.flush()) got.push_back(std::move(s));
    std::string name = file + ": ";
    CHECK(got.size() == want.size(), (name + "number of sentences").c_str());
    if (got.size() != want.size()) { std::printf("   got %zu, want %zu\n", got.size(), want.size()); return; }
    for (size_t i = 0; i < got.size(); i++) {
        double sum = 0; for (float v : got[i]) sum += v;
        std::string n = name + "sentence " + std::to_string(i);
        CHECK(got[i].size() == want[i].len, (n + " length").c_str());
        if (got[i].size() != want[i].len) std::printf("   got %zu, want %zu\n", got[i].size(), want[i].len);
        CHECK(std::fabs(sum - want[i].sum) < 1e-3, (n + " sound (sum)").c_str());
        CHECK(!got[i].empty() && std::fabs(got[i].front() - want[i].first) < 1e-5 && std::fabs(got[i].back() - want[i].last) < 1e-5, (n + " first / last sample").c_str());
    }
    CHECK(seg.speaking() == (wantSpeaking != 0), (name + "still speaking at the end").c_str());
}

static void filterCases(const std::string& dir) {
    std::ifstream f(dir + "/filters.txt");
    std::string line; int n = 0;
    while (std::getline(f, line)) {
        if (line.empty() || line[0] == '#') continue;
        auto c = split(line, '\t');
        if (c.size() < 6) { CHECK(false, "a line of filters.txt has 6 columns"); continue; }
        std::optional<double> lp, nsp;
        if (c[2] != "-") lp = std::stod(c[2]);
        if (c[3] != "-") nsp = std::stod(c[3]);
        Keep k = keep(c[0], std::stod(c[1]), lp, nsp);
        bool ok = c[4] == "1";
        std::string what = "filter '" + c[0] + "' (" + c[1] + " s, " + c[2] + ", " + c[3] + ")";
        CHECK(k.ok == ok && k.why == c[5], what.c_str());
        if (k.ok != ok || k.why != c[5]) std::printf("   got %d '%s', want %d '%s'\n", (int)k.ok, k.why.c_str(), (int)ok, c[5].c_str());
        n++;
    }
    CHECK(n >= 40, "all the filter cases were read");
}

int main(int argc, char** argv) {
    if (argc < 2) { std::cout << "usage: test_golden <golden folder>\n"; return 2; }
    std::string dir = argv[1];
    for (int i = 0; i < 9; i++) {
        const char* names[] = {"seg0_basic", "seg1_basic", "seg2_quiet", "seg3_noisy", "seg4_long", "seg5_long", "seg6_flush", "seg7_flush", "seg8_quick"};
        segmenterCase(dir, std::string(names[i]) + ".txt");
    }
    filterCases(dir);
    TEST_DONE();
}
