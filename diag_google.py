"""Finds out WHY the key-less Google endpoint answers HTTP 429 on this PC. Only sends a handful of requests.
Run:  py -3 diag_google.py      (it changes nothing; just paste the output)"""
import http.client, platform, socket, ssl, sys, time, urllib.request

HOST = "translate.googleapis.com"
PATH = "/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=hello"
print("Python", platform.python_version(), platform.platform())
print("system proxy:", urllib.request.getproxies() or "none")

def one(label, ip, family, ua):
    try:
        raw = socket.socket(family, socket.SOCK_STREAM); raw.settimeout(8); raw.connect((ip, 443))
        s = ssl.create_default_context().wrap_socket(raw, server_hostname=HOST)
        s.sendall(f"GET {PATH} HTTP/1.1\r\nHost: {HOST}\r\nUser-Agent: {ua}\r\nAccept: */*\r\nConnection: close\r\n\r\n".encode())
        data = b""
        while len(data) < 4000:
            c = s.recv(2048)
            if not c: break
            data += c
        head = data.split(b"\r\n", 1)[0].decode(errors="replace")
        print(f"  {label:34s} {ip:40s} -> {head}")
    except Exception as e:
        print(f"  {label:34s} {ip:40s} -> ERROR {e}")
    time.sleep(1.5)

addrs = {}
for fam, name in ((socket.AF_INET, "IPv4"), (socket.AF_INET6, "IPv6")):
    try:
        addrs[name] = (fam, socket.getaddrinfo(HOST, 443, fam, socket.SOCK_STREAM)[0][4][0])
    except Exception as e:
        print(name, "no address:", e)
print("\n[1] address family (same User-Agent)")
for name, (fam, ip) in addrs.items():
    one(name, ip, fam, "ChatMatrixReader/1.0")
print("\n[2] User-Agent, first available address")
if addrs:
    fam, ip = next(iter(addrs.values()))
    for label, ua in (("app UA", "ChatMatrixReader/1.0"), ("Python default UA", "Python-urllib/3"), ("no User-Agent", "")):
        one(label, ip, fam, ua)
print("\n[3] what Python's own default does (urllib)")
try:
    r = urllib.request.urlopen("https://" + HOST + PATH, timeout=8); print("  urllib ->", r.status)
except Exception as e:
    print("  urllib ->", e)
print("\nDone. Paste everything above.")
