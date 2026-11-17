// The sound on the standard input: 16 kHz mono, little endian, 16 bit integer (s16) or 32 bit float (f32); a continuous stream.
#pragma once
#include <cstdint>
#include <cstring>
#include <vector>

namespace cmr {

enum class PcmFormat { S16, F32 };

inline size_t bytesPerSample(PcmFormat f) { return f == PcmFormat::S16 ? 2 : 4; }

// Turns the bytes into float samples. `carry` keeps the bytes of a sample that is cut by the end of a read, for the next call.
inline void decodePcm(PcmFormat f, std::vector<uint8_t>& carry, const uint8_t* data, size_t n, std::vector<float>& out) {
    carry.insert(carry.end(), data, data + n);
    size_t w = bytesPerSample(f), whole = carry.size() / w * w;
    for (size_t i = 0; i < whole; i += w) {
        if (f == PcmFormat::S16) {
            int16_t v = static_cast<int16_t>(carry[i] | (carry[i + 1] << 8));
            out.push_back(static_cast<float>(v) / 32768.0f);
        } else {
            uint32_t u = carry[i] | (carry[i + 1] << 8) | (carry[i + 2] << 16) | (static_cast<uint32_t>(carry[i + 3]) << 24);
            float v; std::memcpy(&v, &u, 4);
            out.push_back(v != v ? 0.0f : v < -1.0f ? -1.0f : v > 1.0f ? 1.0f : v);       // (NaN -> silence)
        }
    }
    carry.erase(carry.begin(), carry.begin() + whole);
}

}  // namespace cmr
