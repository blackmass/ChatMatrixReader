"""Self-test for the model behind the voice indicator (voicemeter.Model)."""
import voicemeter as vm
from voicemeter import Model, bars_for

assert [bars_for(x) for x in (None, -120, -55, -54, -48, -40, -20, 0)] == [0, 0, 0, 1, 2, 3, 5, 5], "levels -> bars"

m = Model()
assert m.snapshot(0)[0] == "off"
m.on_event({"type": "status", "state": "starting"}, 0)
assert m.snapshot(0)[0] == "loading"
m.on_event({"type": "status", "state": "loading", "msg": "m"}, 1)
m.on_event({"type": "status", "state": "ready", "msg": "m"}, 2)
assert m.state == "loading", "ready is not yet listening"
m.on_event({"type": "status", "state": "listening", "msg": "x"}, 3)
st, bars, code, v = m.tick(3.1)
assert (st, bars, code, v) == ("idle", 0, "idle", {"ago": None}), (st, bars, code, v)

# quiet group leader: connected, silence for a long time is NOT an error as long as the process keeps reporting
t = 3.0
for i in range(100):                                  # 20 s of "-120 dB" reports, five per second
    t += 0.2
    m.on_event({"type": "level", "db": -120.0, "speech": False}, t)
    st = m.tick(t)[0]
    assert st == "idle", (i, st)

# sound: the bars follow, fall one step per tick, and after the hold time the state is idle again
m.on_event({"type": "level", "db": -14.0, "speech": True}, t + 0.2)
st, bars, *_ = m.tick(t + 0.2)
assert (st, bars) == ("active", 5), (st, bars)
m.on_event({"type": "level", "db": -120.0, "speech": False}, t + 0.4)
assert m.tick(t + 0.4)[1] == 4 and m.tick(t + 0.45)[1] == 3, "falls one bar per tick"
m.on_event({"type": "level", "db": -120.0, "speech": False}, t + 1.1)
st, bars, code, v = m.tick(t + 1.2)
assert st == "idle" and v["ago"] == 1, (st, v)                       # last sound ~1 s ago

# text / partial count as sound for the "last sound" time
m.on_event({"type": "text", "text": "hi"}, t + 5)
assert m.snapshot(t + 8)[3]["ago"] == 3

# the process stops answering: error (stale), a restart clears it
m.on_event({"type": "level", "db": -120.0}, t + 8)
assert m.tick(t + 8.5)[0] == "idle"
assert m.tick(t + 8 + vm.STALE_S + 0.5)[0] == "error"
assert m.snapshot(t + 20)[2] == "stale"
m.on_event({"type": "status", "state": "starting"}, t + 21)
assert m.snapshot(t + 21)[0] == "loading"

# real errors
m.on_event({"type": "status", "state": "error", "msg": "not installed"}, 0)
assert m.snapshot(0)[:3] == ("error", 0, "not_installed")
m.on_event({"type": "status", "state": "starting"}, 1)
m.on_event({"type": "status", "state": "error", "msg": "no engine"}, 2)
s = m.snapshot(2)
assert s[2] == "message" and s[3]["msg"] == "no engine", s
m.on_event({"type": "exit", "code": 3}, 3)
s = m.snapshot(3)
assert s[2] == "exit" and s[3]["code"] == 3, s
# switched off by the user: no error afterwards, nothing shown
m.on_event({"type": "off"}, 4)
assert m.snapshot(4)[0] == "off"
m.on_event({"type": "exit", "code": 0}, 5)
assert m.snapshot(5)[0] == "off", "the exit that follows a stop asked for by the user is not an error"
print("ALL VOICEMETER TESTS PASSED")
