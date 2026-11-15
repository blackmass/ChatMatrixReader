"""Self-test for joiner.py: pieces of a long message are put together; every other case ends the message at once."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joiner
from decoder import Line

C, CI = "\x05", "\x06"
fails = 0


def check(name, cond):
    global fails
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        fails += 1


def L(i, text, ch="S", who="Bob"):
    return Line(ch, i, who, text)


# 1. a normal line goes straight through
j = joiner.Joiner()
r = j.feed(L(1, "hello"), 0)
check("normal line passes", [x.text for x in r] == ["hello"] and not j.pending())

# 2. three pieces
j = joiner.Joiner()
check("piece 1 held back", j.feed(L(1, "aaa " + C), 0) == [] and j.pending())
check("piece 2 held back", j.feed(L(2, C + "bbb " + C), 0.1) == [])
r = j.feed(L(3, C + "ccc"), 0.2)
check("joined", [x.text for x in r] == ["aaa bbb ccc"] and not j.pending())
check("keeps channel and sender", r[0].channel == "S" and r[0].sender == "Bob" and r[0].id == 1)

# 3. id wrap-around
j = joiner.Joiner()
j.feed(L(65535, "x" + C), 0)
r = j.feed(L(1, C + "y"), 0)
check("id wraps 65535 -> 1", [x.text for x in r] == ["xy"])

# 4. next line is not the continuation: closed at once with an ellipsis, new line follows
j = joiner.Joiner()
j.feed(L(5, "start" + C), 0)
r = j.feed(L(6, "other"), 0.1)
check("closed by next normal line", [x.text for x in r] == ["start…", "other"])
j.feed(L(7, "start" + C), 0)
r = j.feed(L(8, C + "x", who="Eve"), 0.1)              # a continuation, but of someone else
check("other speaker ends it", [x.text for x in r] == ["start…", "…x"])
j.feed(L(9, "start" + C), 0)
r = j.feed(L(11, C + "x"), 0.1)                         # an id was skipped
check("id gap ends it", [x.text for x in r] == ["start…", "…x"])

# 5. timeout
j = joiner.Joiner()
j.feed(L(1, "tail" + C), 0)
check("not yet due", j.flush_due(0.5) == [])
r = j.flush_due(1.01)
check("due after 1 s", [x.text for x in r] == ["tail…"] and not j.pending())
check("nothing left", j.flush_due(5) == [])

# 6. orphan continuation
j = joiner.Joiner()
r = j.feed(L(3, C + "rest"), 0)
check("orphan gets a leading ellipsis", [x.text for x in r] == ["…rest"])
r = j.feed(L(4, C + "mid" + C), 0)
check("orphan middle held", r == [] and j.pending())
r = j.feed(L(5, C + "end"), 0)
check("orphan chain joined", [x.text for x in r] == ["…midend"])

# 7. a link marker cut in two: closed before the flag, reopened with \6<code>
j = joiner.Joiner()
j.feed(L(1, "\x025abc\x03" + C), 0)
r = j.feed(L(2, CI + "5def\x03 tail"), 0)
check("marker put together", [x.text for x in r] == ["\x025abcdef\x03 tail"])

# 8. a marker cut in two, the rest lost: closed before the ellipsis
j = joiner.Joiner()
j.feed(L(1, "x \x025abc" + C), 0)
r = j.flush_due(2)
check("open marker closed", [x.text for x in r] == ["x \x025abc\x03…"])

# 9. an orphan that starts inside a marker gets it reopened
j = joiner.Joiner()
r = j.feed(L(2, CI + "5def\x03"), 0)
check("orphan inside marker", [x.text for x in r] == ["…\x025def\x03"])

# an orphan continuation inside a link marker (its start was lost): the tooltip is not shown, neither as text nor as control characters
j = joiner.Joiner()
r = j.feed(L(5, CI + "2" + "pieces here\x08\x0b<Requires:\x08- 10 x\x03"), 0)
check("orphan tooltip is dropped", len(r) == 1 and r[0].text == "…")

# the original name and the tooltip start (cut inside the original name), the text after the marker stays
j = joiner.Joiner()
r = j.feed(L(5, CI + "1" + "Agony]\x07line 1\x08line 2\x03 and more"), 0)
check("orphan inside the original name", [x.text for x in r] == ["… and more"])

# the end of the local name is still shown
j = joiner.Joiner()
r = j.feed(L(5, CI + "1" + "me\x04[Orig]\x07tip\x03 more"), 0)
check("orphan keeps the end of the local name", [x.text for x in r] == ["…\x021me\x03 more"])

# a chain: the first piece is only tooltip rest, the next ones go on inside the same marker, then plain text
j = joiner.Joiner()
r1 = j.feed(L(5, CI + "2" + "tip a\x08tip b\x03" + C), 0)
r2 = j.feed(L(6, CI + "2" + "tip c\x08tip d\x03 after" + C), 0.1)
r3 = j.feed(L(7, C + " end"), 0.2)
check("dead marker over several pieces", r1 == [] and r2 == [] and [x.text for x in r3] == ["… after end"])

# a live marker that starts in the first (orphan) piece and goes on in the next one is joined as usual
j = joiner.Joiner()
j.feed(L(5, CI + "2" + "junk\x08x\x03 text \x025live" + "\x03" + C), 0)
r = j.feed(L(6, CI + "5" + " name\x03"), 0.1)
check("live marker over pieces", [x.text for x in r] == ["… text \x025live name\x03"])

print("failures:", fails)
sys.exit(1 if fails else 0)

