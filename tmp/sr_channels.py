import json, urllib.request, os, re

BASE = "https://apiv2.shiprocket.in/v1/external"

# creds come from process env (passed inline)
env = {
    "SHIPROCKET_EMAIL": os.environ["SHIPROCKET_EMAIL"],
    "SHIPROCKET_PASSWORD": os.environ["SHIPROCKET_PASSWORD"],
}

def post(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))

def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(req, timeout=30))

auth = post(BASE + "/auth/login", {"email": env["SHIPROCKET_EMAIL"], "password": env["SHIPROCKET_PASSWORD"]})
token = auth["token"]
print("AUTH OK\n")

ch = get(BASE + "/channels", token)
channels = ch.get("data", [])
print("CHANNELS (%d):" % len(channels))
for c in channels:
    print("  id=%s  name=%r  code=%s  status=%s" % (c.get("id"), c.get("name"), c.get("base_channel_code"), c.get("status")))

def is_custom(c):
    return (c.get("base_channel_code") or "").upper() == "CS" or re.search("custom", c.get("name") or "", re.I)

resolved = next((c for c in channels if (c.get("base_channel_code") or "").upper() == "SH" or re.search("shopify", (c.get("name") or "") + (c.get("base_channel_code") or ""), re.I)), None)
if not resolved:
    resolved = next((c for c in channels if not is_custom(c)), None)

print("\n>>> SHIPROCKET_CHANNEL_ID=%s   (channel %r)" % (resolved.get("id") if resolved else "NONE", resolved.get("name") if resolved else None))

pu = get(BASE + "/settings/company/pickup", token)
addrs = pu.get("data", {}).get("shipping_address", [])
print("\nPICKUP LOCATIONS (%d):" % len(addrs))
for a in addrs:
    print("  %r  pin=%s  city=%s" % (a.get("pickup_location"), a.get("pin_code"), a.get("city")))
