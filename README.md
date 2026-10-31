# PeerShare

Send files and messages straight to another device. No accounts: everyone gets a random color + animal name, and sees who else is online with their city and country.

- **Peer to peer.** Files and text travel over WebRTC data channels, encrypted (DTLS) end to end.
- **TURN for reliability.** When two devices can't reach each other directly, Cloudflare Realtime TURN relays the (still encrypted) data. The activity card says "Direct connection" or "Relayed".
- **One-to-one.** Pick a person, choose files and/or type a message or link. Files need the receiver to accept; messages show up right away.
- **Installable.** PWA with an install card (iOS steps / Android & desktop prompt), offline shell, Android share target for files and links.

## How it works

| Piece | Where |
|---|---|
| Static app (HTML/CSS/JS, no build step) | `public/` served by Workers static assets |
| Lobby + signaling | `src/index.js` → `Lobby` Durable Object (one global instance, hibernating WebSockets) |
| Names | `src/identity.js` — CSS named colors × animal emoji |
| Location | `request.cf.city` / `request.cf.country`, shown with a flag emoji |
| TURN credentials | Sent over the lobby socket after joining (no public endpoint), generated with the `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` secrets |

Nothing is stored server-side: the lobby only holds who is connected right now.

## Develop

```sh
npm install
npm run dev        # http://localhost:3000
```

Local TURN needs a `.dev.vars` file (git-ignored):

```
TURN_KEY_ID=...
TURN_KEY_API_TOKEN=...
```

Without it the app falls back to STUN only.

`npm run icons` re-renders the PNG icons from `public/icons/icon.svg` (needs Google Chrome).

## Deploy

Pushing to `main` deploys through Cloudflare Workers Builds (`npx wrangler deploy`). The TURN secrets are set on the Worker, not in this repo.
