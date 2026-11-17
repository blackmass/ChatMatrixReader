// The frames of the input (protocol.h) and the small JSON reader of the control messages.
#include <sstream>

#include "../src/protocol.h"
#include "check.h"

using namespace cmr;

int main() {
    // ---- frames
    std::string a = makeFrame('A', std::string("\x01\x02\x03\x04", 4)), c = makeFrame('C', "{\"lang\":\"ko\"}");
    CHECK(a == "CMRFA00000004" + std::string("\x01\x02\x03\x04", 4) && c.substr(0, 13) == "CMRFC0000000d", "the header: CMRF, the type, the length in 8 hexadecimal digits");
    { std::istringstream in(a + c + makeFrame('A', ""));
      Frame f; size_t skipped = 0;
      CHECK(readFrame(in, f, skipped) && f.type == 'A' && f.payload.size() == 4 && f.payload[2] == 3, "a sound frame is read");
      CHECK(readFrame(in, f, skipped) && f.type == 'C' && std::string(f.payload.begin(), f.payload.end()) == "{\"lang\":\"ko\"}", "a control frame is read");
      CHECK(readFrame(in, f, skipped) && f.type == 'A' && f.payload.empty(), "an empty frame is fine");
      CHECK(!readFrame(in, f, skipped) && skipped == 0, "the end of the input ends the reading"); }
    // sound that happens to contain the letters of the header is just sound inside a frame
    { std::string tricky = "xxCMRFA0000000"; std::istringstream in(makeFrame('A', tricky) + makeFrame('A', "z")); Frame f; size_t sk = 0;
      CHECK(readFrame(in, f, sk) && std::string(f.payload.begin(), f.payload.end()) == tricky && readFrame(in, f, sk) && f.payload[0] == 'z', "the payload is taken by its length, not searched"); }
    // garbage before a frame is skipped and counted
    { std::istringstream in("junkCMCMRFA00000001Q"); Frame f; size_t sk = 0;
      CHECK(readFrame(in, f, sk) && f.payload.size() == 1 && f.payload[0] == 'Q' && sk == 6, "bytes outside of a frame are skipped (and counted)"); }
    { std::istringstream in("CMRFX00000001Q" + makeFrame('A', "ok")); Frame f; size_t sk = 0;
      CHECK(readFrame(in, f, sk) && std::string(f.payload.begin(), f.payload.end()) == "ok" && sk > 0, "a header with a wrong type or length is not a frame: the next one is found"); }
    { std::istringstream in("CMRFAffffffff" + makeFrame('A', "ok")); Frame f; size_t sk = 0;
      CHECK(readFrame(in, f, sk) && std::string(f.payload.begin(), f.payload.end()) == "ok", "a length that is too long is not a frame"); }
    { std::istringstream in(a.substr(0, 15)); Frame f; size_t sk = 0; CHECK(!readFrame(in, f, sk), "a frame cut short ends the reading"); }

    // ---- the JSON of the control messages
    std::map<std::string, std::string> m;
    CHECK(parseFlatObject("{\"lang\":\"ko\", \"end_ms\": 700 , \"live\":true,\"x\":null}", m) && m["lang"] == "ko" && m["end_ms"] == "700" && m["live"] == "true" && m["x"] == "null", "strings, numbers, booleans, null");
    CHECK(parseFlatObject("{}", m) && m.empty() && parseFlatObject("  { }  ", m), "an empty object");
    CHECK(parseFlatObject("{\"prompt\":\"Tank, \\\"Healer\\\"\\n\\\\ \\u00e9 \\uD83D\\uDE00 안녕\"}", m) && m["prompt"] == "Tank, \"Healer\"\n\\ \xC3\xA9 \xF0\x9F\x98\x80 안녕", "escapes, \\u and surrogate pairs become UTF-8; UTF-8 passes");
    CHECK(!parseFlatObject("", m) && !parseFlatObject("[1]", m) && !parseFlatObject("{\"a\":1", m) && !parseFlatObject("{\"a\":{\"b\":1}}", m) && !parseFlatObject("{\"a\":[1]}", m) && !parseFlatObject("{\"a\" 1}", m) && !parseFlatObject("{\"a\":1} x", m) && !parseFlatObject("{\"a\":\"\\q\"}", m) && !parseFlatObject("{'a':1}", m),
          "anything that is not a flat JSON object is refused");
    TEST_DONE();
}
