// The input of the engine in "framed" mode (--framed): the program (exe) wraps everything it writes to the standard input, so that messages can
// travel with the sound while it runs (a new language, a new hint ...). The header is plain ASCII, so a message can also be written as text.
//
//     "CMRF" + type + length + payload
//        type    'A' = sound (16 kHz mono, the format of --pcm)     'C' = control (a JSON object, UTF-8)
//        length  8 hexadecimal digits: the number of bytes of the payload
//
// control object (every key is optional; what is not named stays as it is):
//     {"lang":"ko"|"auto", "prompt":"...", "end_ms":700, "max_s":12, "min_db":-44, "mode":"sentence"|"live", "partial_ms":1000}
// The engine answers with {"type":"applied", ...} (what it took over). Without --framed the input is the sound only (tests, simple use).
#pragma once
#include <cstdint>
#include <istream>
#include <map>
#include <string>
#include <vector>

namespace cmr {

constexpr size_t kFrameHeader = 13;               // "CMRF" + 1 + 8
constexpr size_t kMaxFramePayload = 1 << 20;      // a longer frame is a mistake (the program sends 20 ms of sound at a time)

struct Frame { char type = 0; std::vector<uint8_t> payload; };

// Reads the next frame. Bytes that are not a frame (a broken start) are skipped until "CMRF" shows up; `skipped` counts them.
// false = the input ended (or failed).
bool readFrame(std::istream& in, Frame& f, size_t& skipped);

// the other direction (used by the tests; the program writes the same bytes from Rust and from JavaScript)
std::string makeFrame(char type, const std::string& payload);

// A JSON object of plain values (string / number / true / false / null) -> text. Numbers and booleans are kept as their text ("700", "true").
// false when it is not such an object.
bool parseFlatObject(const std::string& json, std::map<std::string, std::string>& out);

}  // namespace cmr
