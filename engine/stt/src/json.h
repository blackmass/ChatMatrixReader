// One JSON object per line on stdout (UTF-8): the messages to the program (docs/PROTOCOL of the extension: see core/voice_proto.js).
#pragma once
#include <cmath>
#include <cstdio>
#include <functional>
#include <mutex>
#include <string>

namespace cmr {

inline std::string jsonString(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o.push_back(static_cast<char>(c));          // UTF-8 goes through as it is
        }
    }
    return o + "\"";
}

inline std::string jsonNum(double v, int decimals = 3) {
    if (!std::isfinite(v)) return "null";
    char b[48]; std::snprintf(b, sizeof b, "%.*f", decimals, v);
    return b;
}

// Builds {"type":"...", ...} step by step: Msg("text").str("text", t).num("dur", 3.2).line()
class Msg {
public:
    explicit Msg(const std::string& type) { s_ = "{\"type\":" + jsonString(type); }
    Msg& str(const std::string& k, const std::string& v) { s_ += "," + jsonString(k) + ":" + jsonString(v); return *this; }
    Msg& num(const std::string& k, double v, int decimals = 3) { s_ += "," + jsonString(k) + ":" + jsonNum(v, decimals); return *this; }
    Msg& integer(const std::string& k, long long v) { s_ += "," + jsonString(k) + ":" + std::to_string(v); return *this; }
    Msg& boolean(const std::string& k, bool v) { s_ += "," + jsonString(k) + ":" + (v ? "true" : "false"); return *this; }
    std::string line() const { return s_ + "}"; }
private:
    std::string s_;
};

// where the lines go (stdout in the program, a list in the tests); thread safe
class Out {
public:
    using Sink = std::function<void(const std::string&)>;
    explicit Out(Sink sink) : sink_(std::move(sink)) {}
    void emit(const Msg& m) { std::lock_guard<std::mutex> g(mu_); sink_(m.line()); }
private:
    Sink sink_;
    std::mutex mu_;
};

}  // namespace cmr
