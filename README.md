# NearCall v3.2

Offline chat and calls over Bluetooth and Wi-Fi / hotspot. No SIM, no internet.
Native Kotlin shell + WebView UI (`app/src/main/assets/www`), same format as your other APKs.

## Build
Upload everything (keep `.github/workflows/main.yml`), run the "Build NearCall APK" action,
download `NearCall.apk` from the run's artifacts or the Releases page.

## Files
- `MeshService.kt`  the mesh node: Bluetooth (Nearby), encryption, routing, files, channels, SOS, calls, voice notes
- `LanLink.kt`      Wi-Fi / hotspot link (UDP on the shared network), bridged into the same mesh
- `Crypto.kt`       end-to-end encryption (ECDH + AES-GCM), number pinning keys
- `MainActivity.kt` WebView shell and the `AndroidNative` bridge
- `assets/www/`     the UI (index.html, app.js), Inter + Naskh fonts, English/Urdu

## Test plan
1. Two phones, a few metres apart: pair up, send text, a photo, a voice note, place a call.
2. Three phones in a line (A - B - C, A and C out of Bluetooth range): A messages C through B.
3. Hotspot: one phone turns on its hotspot, the others join that Wi-Fi (no internet needed). They link over Wi-Fi.
4. Turn off a phone, send it a message, turn it back on: the message is delivered when it returns.

## Two sections: Bluetooth and Wi-Fi / Hotspot
- A switch at the top of Chats, Dial and People picks the section. Each section has its own contacts, chats and call log.
- Messages, photos, voice notes and calls sent from a section use that link first.
- If that link has no way to reach the person, the packet switches to the other link by itself (checked per packet,
  and per voice frame during a call) and the bubble shows "↪ Wi-Fi" / "↪ Bluetooth". It switches back when the link returns.
- Channels and SOS use both links. Relaying bridges both links.
- Wi-Fi link loss is noticed in about 10 s, Bluetooth links reconnect within about 1 s of a drop,
  and unacknowledged messages are retried after 8 s, 16 s, 32 s ... up to 2 min.
- Settings has a separate on/off switch for the Bluetooth link and for the Wi-Fi / hotspot link.

## Link switching and delivery (v3.1)
- A message belongs to the section the SENDER chose, whatever link it travels on, so it always lands in the same section on the other phone.
- Every link gets a 1-byte heartbeat every 2 s. A silent link is dropped after 6 s (Wi-Fi) / 10 s (Bluetooth) and Bluetooth searches again at once.
- When both a Bluetooth and a Wi-Fi link reach the person, messages, calls and voice go on both at once (duplicates are dropped), so a dead link is never noticed.
- Unacknowledged messages retry after 3 s, 6 s, 12 s, 24 s, 48 s, then every minute, on every link, and are pushed the moment a new link appears.
- Either phone can start a Bluetooth connection (no waiting for the higher id). "Reconnect now" buttons force a fresh search.
- Network view shows each link and how many seconds ago it was last heard.

## Independent links (v3.2)
- Three link types, each with its own connection, heartbeat and reconnect logic:
  1. Wi-Fi / hotspot (UDP) - `LanLink.kt`
  2. Direct Bluetooth to PAIRED phones (RFCOMM) - `RfLink.kt`. Does not use Wi-Fi or Google Nearby at all.
  3. Bluetooth auto-discovery (Google Nearby) - may use Wi-Fi underneath; can be switched off in Settings.
- Pair phones once in Android Bluetooth settings (Settings > Links > "Pair phones") for the most stable Bluetooth link.
- When a person is reachable on several links, every packet goes on all of them; the receiver drops duplicates.
  If one link disappears the others carry on untouched.
- A Bluetooth on/off change only restarts the Bluetooth links; a Wi-Fi change only restarts the Wi-Fi link.
- The chat header shows each link on its own: "🔵 ✓ · 📶 ✗".

## Known limits
- Android only; needs Google Play Services (Nearby Connections).
- Channels are open (anyone who knows the name can read). Direct chats, photos, voice notes and calls are end-to-end encrypted.
- A number is pinned to the first phone seen using it. If a friend reinstalls, tap "Trust new device".
- Voice is best over 1 to 2 hops. Bluetooth links per phone are capped at 6; Wi-Fi links are separate.
- Wi-Fi link needs phones on the same network. Some public Wi-Fi blocks phone-to-phone traffic (client isolation); a phone hotspot does not.
- Not yet tested on real devices.
