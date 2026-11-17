// The stream of sound -> sentences -> recogniser -> filter -> JSON lines. The same job as sttcore/pipeline.py of the 2.x reader, with one
// difference: the program (exe) sends a CONTINUOUS stream (it fills the pauses with silence), so the end of a sentence needs no timer here.
//
//   thread 1 (reader)   the standard input: bytes -> samples -> Segmenter -> queue of sentences (the oldest are dropped when the recogniser
//                       falls behind: the newest words matter more than a queue that keeps growing)
//   thread 2 (stats)    once a second {"type":"stats",...}
//   this thread         one sentence at a time: recognise, filter, {"type":"text",...}
// With --framed (protocol.h) the input holds control messages too: language, hint, quiet time, longest piece, mode - applied to the NEXT sentences, with no restart.
// Also about ten {"type":"level"} lines a second (loudness, whether a sentence is open, where the speech limit is): the bar of the options.
// End of the input = the program wants it to stop: what is being spoken is finished, the queue is worked off, then it ends.
#pragma once
#include <istream>

#include "config.h"
#include "json.h"
#include "recognizer.h"

namespace cmr {

class Pipeline {
public:
    Pipeline(const Config& cfg, Recognizer& rec, Out& out, std::istream& in) : cfg_(cfg), rec_(rec), out_(out), in_(in) {}
    // 0 = ended as asked, 2 = the model did not load, 4 = the recogniser failed 5 times in a row.
    // After 4 the reader of the input may still be waiting in a read: `out` and the input must stay alive until the process ends (main does exit right away).
    int run();
private:
    const Config& cfg_;
    Recognizer& rec_;
    Out& out_;
    std::istream& in_;
};

}  // namespace cmr
