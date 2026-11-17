#include "protocol.h"

#include <cctype>
#include <cstring>

namespace cmr {

namespace {
bool hex8(const uint8_t* p, uint32_t& v) {
    v = 0;
    for (int i = 0; i < 8; i++) {
        int c = p[i], d;
        if (c >= '0' && c <= '9') d = c - '0'; else if (c >= 'a' && c <= 'f') d = c - 'a' + 10; else if (c >= 'A' && c <= 'F') d = c - 'A' + 10; else return false;
        v = (v << 4) | static_cast<uint32_t>(d);
    }
    return true;
}

void appendUtf8(std::string& s, uint32_t cp) {
    if (cp < 0x80) s.push_back(static_cast<char>(cp));
    else if (cp < 0x800) { s.push_back(static_cast<char>(0xC0 | (cp >> 6))); s.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else if (cp < 0x10000) { s.push_back(static_cast<char>(0xE0 | (cp >> 12))); s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); s.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else { s.push_back(static_cast<char>(0xF0 | (cp >> 18))); s.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F))); s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); s.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
}
}  // namespace

bool readFrame(std::istream& in, Frame& f, size_t& skipped) {
    // find "CMRF": a byte that does not continue the pattern restarts it
    static const char magic[4] = {'C', 'M', 'R', 'F'};
    size_t have = 0;
    for (;;) {
        while (have < 4) {
            int c = in.get();
            if (c == std::char_traits<char>::eof()) return false;
            if (c == magic[have]) { have++; continue; }
            skipped += have + 1;                           // what we had matched so far, and this byte, are not a frame
            have = (c == magic[0]) ? 1 : 0;
            if (have == 1) skipped--;
        }
        uint8_t h[9];
        in.read(reinterpret_cast<char*>(h), 9);
        if (in.gcount() < 9) return false;
        uint32_t len;
        if ((h[0] != 'A' && h[0] != 'C') || !hex8(h + 1, len) || len > kMaxFramePayload) {
            // not a header after all: what we took for one was sound; look again from the byte after "CMRF"
            skipped += 4 + 9; have = 0;
            continue;
        }
        f.type = static_cast<char>(h[0]);
        f.payload.resize(len);
        if (len) {
            in.read(reinterpret_cast<char*>(f.payload.data()), static_cast<std::streamsize>(len));
            if (static_cast<size_t>(in.gcount()) < len) return false;
        }
        return true;
    }
}

std::string makeFrame(char type, const std::string& payload) {
    char head[16];
    std::snprintf(head, sizeof head, "CMRF%c%08x", type, static_cast<unsigned>(payload.size()));
    return std::string(head) + payload;
}

bool parseFlatObject(const std::string& s, std::map<std::string, std::string>& out) {
    out.clear();
    size_t i = 0, n = s.size();
    auto ws = [&] { while (i < n && std::isspace(static_cast<unsigned char>(s[i]))) i++; };
    auto str = [&](std::string& v) {
        if (i >= n || s[i] != '"') return false;
        i++; v.clear();
        while (i < n && s[i] != '"') {
            char c = s[i++];
            if (c != '\\') { v.push_back(c); continue; }
            if (i >= n) return false;
            char e = s[i++];
            switch (e) {
                case '"': v.push_back('"'); break; case '\\': v.push_back('\\'); break; case '/': v.push_back('/'); break;
                case 'n': v.push_back('\n'); break; case 'r': v.push_back('\r'); break; case 't': v.push_back('\t'); break;
                case 'b': v.push_back('\b'); break; case 'f': v.push_back('\f'); break;
                case 'u': {
                    auto u4 = [&](uint32_t& cp) { if (i + 4 > n) return false; cp = 0; for (int k = 0; k < 4; k++) { int c2 = s[i + k], d;
                        if (c2 >= '0' && c2 <= '9') d = c2 - '0'; else if (c2 >= 'a' && c2 <= 'f') d = c2 - 'a' + 10; else if (c2 >= 'A' && c2 <= 'F') d = c2 - 'A' + 10; else return false;
                        cp = (cp << 4) | static_cast<uint32_t>(d); } i += 4; return true; };
                    uint32_t cp;
                    if (!u4(cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < n && s[i] == '\\' && s[i + 1] == 'u') {       // a surrogate pair
                        i += 2; uint32_t lo;
                        if (!u4(lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    appendUtf8(v, cp); break;
                }
                default: return false;
            }
        }
        if (i >= n) return false;
        i++;
        return true;
    };
    ws();
    if (i >= n || s[i] != '{') return false;
    i++; ws();
    if (i < n && s[i] == '}') { i++; ws(); return i == n; }
    for (;;) {
        ws();
        std::string key, val;
        if (!str(key)) return false;
        ws();
        if (i >= n || s[i] != ':') return false;
        i++; ws();
        if (i < n && s[i] == '"') { if (!str(val)) return false; }
        else {
            size_t a = i;
            while (i < n && s[i] != ',' && s[i] != '}' && !std::isspace(static_cast<unsigned char>(s[i]))) i++;
            val = s.substr(a, i - a);
            if (val.empty() || val[0] == '{' || val[0] == '[') return false;          // only plain values
        }
        out[key] = val;
        ws();
        if (i < n && s[i] == ',') { i++; continue; }
        if (i < n && s[i] == '}') { i++; ws(); return i == n; }
        return false;
    }
}

}  // namespace cmr
