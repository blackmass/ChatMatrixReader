// The command line, the PCM decoding and the WAV reader.
#include <cmath>
#include <cstdio>
#include <fstream>

#include "../src/bench.h"
#include "../src/config.h"
#include "../src/pcm.h"
#include "check.h"

using namespace cmr;

static bool parse(std::vector<std::string> a, Config& c, std::string& e) { return parseArgs(a, c, e); }

static void writeWav(const std::string& path, int rate, int ch, int bits, bool isFloat, const std::vector<float>& frames) {
    std::ofstream f(path, std::ios::binary);
    auto w32 = [&](uint32_t v) { f.write(reinterpret_cast<char*>(&v), 4); };
    auto w16 = [&](uint16_t v) { f.write(reinterpret_cast<char*>(&v), 2); };
    uint32_t data = static_cast<uint32_t>(frames.size() * (bits / 8));
    f.write("RIFF", 4); w32(36 + data); f.write("WAVEfmt ", 8); w32(16); w16(isFloat ? 3 : 1); w16(static_cast<uint16_t>(ch)); w32(static_cast<uint32_t>(rate)); w32(static_cast<uint32_t>(rate * ch * bits / 8)); w16(static_cast<uint16_t>(ch * bits / 8)); w16(static_cast<uint16_t>(bits));
    f.write("data", 4); w32(data);
    for (float v : frames) {
        if (isFloat) f.write(reinterpret_cast<char*>(&v), 4);
        else { int16_t s = static_cast<int16_t>(v * 32767); f.write(reinterpret_cast<char*>(&s), 2); }
    }
}

int main() {
    // ---- arguments
    Config c; std::string e;
    CHECK(parse({"--model", "../models/ggml-small.bin", "--device", "gpu", "--lang", "ko", "--end-ms", "99999", "--max-s", "x"}, c, e) == false && e == "--max-s", "a number that is not a number is refused, naming the argument");
    Config d;
    bool ok = parse({"--model", "../models/ggml-small.bin", "--device", "gpu", "--lang", "ko", "--end-ms", "99999", "--max-s", "8", "--mode", "live", "--pcm", "s16", "--rate", "16000", "--partial-ms", "1000", "--prompt", "Tank, Healer"}, d, e);
    CHECK(ok && d.model == "../models/ggml-small.bin" && d.device == "gpu" && d.lang == "ko" && d.end_ms == 10000 && d.max_s == 8 && d.live && d.partial_ms == 1000 && d.prompt == "Tank, Healer", "the arguments of core/voice_proto.js engineArgs are read (numbers are clamped)");
    Config a2; parse({"--model", "m", "--lang", "auto"}, a2, e);
    CHECK(a2.lang.empty() && a2.device == "cpu" && !a2.live && a2.pcm == PcmFormat::S16, "defaults: language detected, cpu, sentences, 16 bit");
    Config f2; CHECK(parse({"--model", "m", "--pcm", "f32"}, f2, e) && f2.pcm == PcmFormat::F32, "float sound");
    Config bad; CHECK(!parse({"--device", "cpu"}, bad, e) && e.find("--model") != std::string::npos, "a model is required");
    CHECK(!parse({"--model", "m", "--wat"}, bad, e) && e.find("--wat") != std::string::npos, "an unknown argument is refused");
    CHECK(!parse({"--model", "m", "--rate", "44100"}, bad, e), "only 16 kHz");
    CHECK(!parse({"--model", "m", "--pcm", "mp3"}, bad, e) && !parse({"--model"}, bad, e), "wrong values are refused");
    Config seg; parse({"--model", "m", "--end-ms", "400", "--max-s", "5"}, seg, e);
    CHECK(seg.seg().end_ms == 400 && seg.seg().max_s == 5.0, "the segmenter gets its parameters from the arguments");
    Config db; parse({"--model", "m", "--min-db", "-30"}, db, e);
    Config nodb; parse({"--model", "m"}, nodb, e);
    CHECK(std::fabs(db.seg().min_rms - 0.0316228) < 1e-5 && nodb.seg().min_rms == 0.006, "--min-db sets the quietest speech; without it the default 0.006");
    CHECK(!parse({"--model", "m", "--min-db", "x"}, bad, e) && parse({"--model", "m", "--min-db", "-999"}, db, e) && db.min_db == -80, "--min-db: a number, clamped");

    // ---- PCM
    std::vector<uint8_t> carry; std::vector<float> out;
    const uint8_t s16[] = {0x00, 0x40, 0x00, 0xC0, 0xFF, 0x7F};              // 0.5, -0.5, ~1.0
    decodePcm(PcmFormat::S16, carry, s16, 5, out);                            // cut in the middle of the last sample
    CHECK(out.size() == 2 && std::fabs(out[0] - 0.5f) < 1e-4 && std::fabs(out[1] + 0.5f) < 1e-4 && carry.size() == 1, "16 bit: whole samples are decoded, the cut one waits");
    decodePcm(PcmFormat::S16, carry, s16 + 5, 1, out);
    CHECK(out.size() == 3 && out[2] > 0.999f && carry.empty(), "... and is finished by the next bytes");
    std::vector<uint8_t> c2; std::vector<float> o2; float fl[] = {0.25f, 2.0f, NAN};
    decodePcm(PcmFormat::F32, c2, reinterpret_cast<uint8_t*>(fl), sizeof fl, o2);
    CHECK(o2.size() == 3 && o2[0] == 0.25f && o2[1] == 1.0f && o2[2] == 0.0f, "float: clipped to [-1, 1], NaN is silence");

    // ---- WAV
    std::vector<float> tone(16000 * 2); for (size_t i = 0; i < tone.size(); i++) tone[i] = 0.3f * std::sin(i * 0.05f);
    writeWav("t_mono16.wav", 16000, 1, 16, false, tone);
    std::vector<float> got; std::string err;
    CHECK(readWav("t_mono16.wav", got, err) && got.size() == tone.size() && std::fabs(got[100] - tone[100]) < 1e-3, "a 16 bit mono WAV is read");
    writeWav("t_stereo.wav", 16000, 2, 16, false, tone);
    CHECK(readWav("t_stereo.wav", got, err) && got.size() == tone.size() / 2, "stereo is averaged to mono");
    writeWav("t_float.wav", 16000, 1, 32, true, tone);
    CHECK(readWav("t_float.wav", got, err) && got.size() == tone.size() && std::fabs(got[100] - tone[100]) < 1e-6, "a float WAV is read");
    writeWav("t_44k.wav", 44100, 1, 16, false, tone);
    CHECK(!readWav("t_44k.wav", got, err) && err.find("16000") != std::string::npos && err.find("ffmpeg") != std::string::npos, "another sample rate is refused with the way to convert it");
    CHECK(!readWav("no_such_file.wav", got, err) && err.find("cannot open") != std::string::npos, "a missing file is said");
    { std::ofstream f("t_text.wav"); f << "this is not a wave file, but it is long enough to pass the size check of the reader....."; }
    CHECK(!readWav("t_text.wav", got, err) && err == "not a WAV file", "a file that is not a WAV is said");
    std::remove("t_mono16.wav"); std::remove("t_stereo.wav"); std::remove("t_float.wav"); std::remove("t_44k.wav"); std::remove("t_text.wav");
    TEST_DONE();
}
