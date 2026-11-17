#include "filters.h"

#include <cstdio>
#include <set>

namespace cmr {

namespace {

// UTF-8 -> code points (a broken byte becomes U+FFFD, which counts as "not a word")
std::u32string decode(const std::string& s) {
    std::u32string out;
    for (size_t i = 0; i < s.size();) {
        unsigned char c = s[i];
        int n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        if (n == 0 || i + n > s.size()) { out.push_back(0xFFFD); i++; continue; }
        char32_t cp = n == 1 ? c : c & (0xFF >> (n + 1));
        bool bad = false;
        for (int k = 1; k < n; k++) {
            unsigned char d = s[i + k];
            if ((d & 0xC0) != 0x80) { bad = true; break; }
            cp = (cp << 6) | (d & 0x3F);
        }
        if (bad) { out.push_back(0xFFFD); i++; continue; }
        out.push_back(cp);
        i += n;
    }
    return out;
}

bool in(char32_t c, char32_t lo, char32_t hi) { return c >= lo && c <= hi; }

// Python's \w for one code point (str.isalnum() or "_"). Exact for ASCII; for the rest the blocks of punctuation, symbols and emoji are
// "not a word" and everything else (letters of every script, digits) is. Only the "is there anything to read?" decision depends on it.
bool isWord(char32_t c) {
    if (c < 0x80) return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    if (c == 0xFFFD) return false;
    if (in(c, 0x80, 0xBF)) return c == 0xAA || c == 0xB2 || c == 0xB3 || c == 0xB5 || c == 0xB9 || c == 0xBA || (c >= 0xBC && c <= 0xBE);   // Latin-1 punctuation
    if (c == 0xD7 || c == 0xF7) return false;
    if (in(c, 0x2000, 0x206F)) return false;                                                    // general punctuation
    if (in(c, 0x2070, 0x209F)) return true;                                                     // super / subscripts (digits, letters)
    if (in(c, 0x20A0, 0x20FF)) return false;                                                    // currency, combining marks for symbols
    if (in(c, 0x2100, 0x218F)) return true;                                                     // letterlike symbols, number forms (approximation)
    if (in(c, 0x2190, 0x245F)) return false;                                                    // arrows, math, technical, pictures
    if (in(c, 0x2460, 0x24FF)) return true;                                                     // enclosed alphanumerics
    if (in(c, 0x2500, 0x2775)) return false;                                                    // box drawing, shapes, symbols (incl. musical notes)
    if (in(c, 0x2776, 0x2793)) return true;                                                     // dingbat circled numbers
    if (in(c, 0x2794, 0x2BFF)) return false;                                                    // dingbats, arrows, symbols
    if (in(c, 0x2E00, 0x2E7F)) return false;                                                    // supplemental punctuation
    if (in(c, 0x3000, 0x303F)) return in(c, 0x3005, 0x3007) || in(c, 0x3021, 0x3029) || in(c, 0x3031, 0x3035) || in(c, 0x3038, 0x303C);   // CJK symbols
    if (in(c, 0x30FB, 0x30FB)) return false;                                                    // katakana middle dot
    if (in(c, 0xE000, 0xF8FF)) return false;                                                    // private use
    if (in(c, 0xFE10, 0xFE1F) || in(c, 0xFE30, 0xFE6F)) return false;                           // vertical / compatibility forms (punctuation)
    if (in(c, 0xFF00, 0xFF0F) || in(c, 0xFF1A, 0xFF20) || in(c, 0xFF3B, 0xFF40) || in(c, 0xFF5B, 0xFF65)) return false;   // full width punctuation
    if (in(c, 0xFFF0, 0xFFFF)) return false;
    if (in(c, 0x1F000, 0x1FAFF)) return false;                                                  // emoji and pictographs
    if (in(c, 0xFE00, 0xFE0F)) return false;                                                    // variation selectors
    if (in(c, 0x300, 0x36F)) return false;                                                      // combining marks
    return true;
}

// the text lower-cased and cut to [a-z0-9 ] (ASCII only), as Python's re.sub(r"[^a-z0-9 ]+", "", t.lower()).strip()
std::string norm(const std::string& t) {
    std::string out;
    for (unsigned char c : t) {
        if (c >= 'A' && c <= 'Z') c = static_cast<unsigned char>(c - 'A' + 'a');
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ' ') out.push_back(static_cast<char>(c));
    }
    size_t a = out.find_first_not_of(' ');                   // Python's strip() also drops \t \n ..., which cannot be in `out`
    if (a == std::string::npos) return "";
    size_t b = out.find_last_not_of(' ');
    return out.substr(a, b - a + 1);
}

// Python's str.strip() for whitespace (ASCII whitespace only; enough for the "empty" decision, which also needs a word character)
std::string strip(const std::string& s) {
    size_t a = 0, b = s.size();
    auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
    while (a < b && ws(s[a])) a++;
    while (b > a && ws(s[b - 1])) b--;
    return s.substr(a, b - a);
}

const std::set<std::string>& phantoms() {
    // Short, typical phantom texts. Only dropped when the sound was short or the engine was unsure.
    static const std::set<std::string> p = {"thank you", "thanks", "thanks for watching", "thank you for watching", "you", "bye", "bye bye", "okay", "ok", "yeah",
        "so", "uh", "um", "hmm", "mm", "oh", "the end", "subtitles by the amara.org community"};
    return p;
}

std::string f2(double v) { char b[32]; std::snprintf(b, sizeof b, "%.2f", v); return b; }

}  // namespace

bool hasWordChar(const std::string& utf8) {
    for (char32_t c : decode(utf8)) if (isWord(c)) return true;
    return false;
}

Keep keep(const std::string& text, double audio_s, std::optional<double> avg_logprob, std::optional<double> no_speech_prob, double min_logprob, double max_no_speech) {
    std::string t = strip(text);
    if (t.empty() || !hasWordChar(t)) return {false, "empty"};
    if (no_speech_prob && avg_logprob && *no_speech_prob > max_no_speech && *avg_logprob < -1.0)
        return {false, "no speech (" + f2(*no_speech_prob) + ", logprob " + f2(*avg_logprob) + ")"};
    if (avg_logprob && *avg_logprob < min_logprob) return {false, "unsure (logprob " + f2(*avg_logprob) + ")"};
    if (phantoms().count(norm(t)) && audio_s < 2.5 && (!avg_logprob || *avg_logprob < -0.5)) return {false, "phantom phrase"};
    return {true, ""};
}

}  // namespace cmr
