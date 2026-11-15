"""Self-test: translation method per channel / for sending, and which methods are in use (connection check once per method)."""
import os
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translator as t
cfg={"translator":"google","google_api_key":"K","api_url":"u","channel_route":{"S":"google_free","Y":"openai","P":"custom","G":"off","R":"google"},"send_enabled":True}
assert t.route_for(cfg,"S")=="google_free" and t.route_for(cfg,"Y")=="openai" and t.route_for(cfg,"G")=="off" and t.route_for(cfg,"W") is None
assert t.route_for({"channel_route":{"S":"bogus"}},"S") is None
c=t.apply_route(cfg,"google_free"); assert c["translator"]=="google" and c["google_api_key"]==""
c=t.apply_route(cfg,"google"); assert c["translator"]=="google" and c["google_api_key"]=="K"
assert t.apply_route(cfg,"openai")["translator"]=="openai" and t.apply_route(cfg,"custom")["translator"]=="custom"
assert t.apply_route(cfg,None) is cfg
assert t.modes_in_use(cfg)=={"google","openai","custom"}
assert t.modes_in_use({"translator":"none","channel_route":{}})==set()
assert t.modes_in_use({"translator":"google","channel_route":{"S":"openai","Y":"openai","P":"openai"},"send_route":"openai"})=={"google","openai"}
assert t.modes_in_use({"translator":"google","channel_route":{},"send_route":"openai","send_enabled":False})=={"google"}
assert t.send_route({"send_route":"default"}) is None and t.send_route({"send_route":"openai"})=="openai"
# outgoing uses the send route
seen={}
orig=t.translate
t.translate=lambda c,x: seen.update(mode=c["translator"],key=c.get("google_api_key")) or "hello"
t.translate_outgoing(dict(cfg,send_route="google_free"),"안녕"); assert seen["mode"]=="google" and seen["key"]==""
t.translate_outgoing(dict(cfg,send_route="openai"),"안녕"); assert seen["mode"]=="openai"
t.translate_outgoing(dict(cfg),"안녕"); assert seen["mode"]=="google"
# the check of a method that only the sending uses carries the sending prompt (never the received lines' prompt)
c3 = {"translator": "google", "channel_route": {"S": "google_free"}, "send_route": "openai", "send_lang": "English", "prompt": "RECV"}
assert t.only_sending_uses(c3, "openai") and not t.only_sending_uses(c3, "google")
assert "English" in t.send_cfg(c3)["prompt"] and t.send_cfg(c3)["prompt"] != "RECV"
assert not t.only_sending_uses(dict(c3, channel_route={"S": "openai"}), "openai")
assert not t.only_sending_uses(dict(c3, translator="openai"), "openai")
print("routes ok")

# the old switch "translate what was heard" becomes the channel translation of the voice channel
import json, tempfile, config
with tempfile.TemporaryDirectory() as d:
    config.PATH = os.path.join(d, "config.json")
    def load_with(saved):
        with open(config.PATH, "w", encoding="utf-8") as f:
            json.dump(saved, f)
        return config.load()
    c = load_with({"voice_translate": False})
    assert c["channel_route"].get("!VC") == "off" and "voice_translate" not in c
    c = load_with({"voice_translate": True})
    assert "!VC" not in c["channel_route"] and "voice_translate" not in c
    c = load_with({"voice_translate": False, "channel_route": {"!VC": "openai"}})
    assert c["channel_route"]["!VC"] == "openai", "a choice made in the new place wins"
print("voice route migration ok")
