"""Self-test for chattext.py (item-link markers)."""
import chattext as c

t = "WTS \x023[Farmer's Shovel]\x03 and \x024[Helm]\x03 pls"
assert c.plain(t) == "WTS [Farmer's Shovel] and [Helm] pls"
assert c.segments(t) == [("WTS ", None), ("[Farmer's Shovel]", 3), (" and ", None), ("[Helm]", 4), (" pls", None)]
assert c.segments("no links") == [("no links", None)]
assert c.segments("") == []
cut = "buy \x025[Legendary Swo"                          # message cut off by the byte limit: colour runs to the end
assert c.segments(cut) == [("buy ", None), ("[Legendary Swo", 5)] and c.plain(cut) == "buy [Legendary Swo"
assert c.plain("stray \x03 mark \x02") == "stray  mark "
assert all(q in c.QUALITY_COLORS for q in range(9))
print("ALL CHATTEXT TESTS PASSED")
