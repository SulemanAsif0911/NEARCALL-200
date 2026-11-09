# NearChat (BitChat-style mesh chat)

Same engine as NearCall (Bluetooth + Wi-Fi mesh, end-to-end encryption, store-and-forward, relaying),
different idea: no accounts, no phone numbers, no servers.

## The idea
- Identity = random nickname + fingerprint (`sara#a1b2`). The fingerprint is made from your key, so it cannot be faked.
- `#mesh` is a public room for everyone in range. Messages hop phone to phone (up to 200 hops). Public messages are signed.
- Tap "people" to open a private chat: end-to-end encrypted, delivered later if the person is away.
- `/j #name password` creates a channel that only people with the password can read.
- Nothing is saved unless you switch on "keep history". Triple-tap the logo (or /panic) wipes keys, chats and queues.
- IRC-style commands: /help /who /msg /j /leave /me /hug /slap /nick /fav /block /unblock /clear /links /panic

## Build
Push the repo; the workflow builds `NearCall.apk` and `NearChat.apk` (install side by side). Gradle task names:
`assembleNearcallRelease`, `assembleNearchatRelease`.

## Not the same as the real BitChat
Different protocol (not compatible with the BitChat app), uses Nearby + paired-Bluetooth + Wi-Fi links instead of BLE only,
ECDH + AES-GCM instead of Noise, up to 200 hops (BitChat: 7). Android only for now.
