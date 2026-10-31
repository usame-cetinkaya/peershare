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

## Security

| Threat | Protection |
|---|---|
| Learning someone's IP by sending them an offer | A connection someone else starts is relay-only (TURN), so they only see Cloudflare's addresses. It goes direct after you accept their files or send them something. |
| Free-riding on the TURN relay | No public credential endpoint; 4-hour credentials come over the lobby socket, refreshable at most every 10 minutes. |
| Flooding the lobby / burning the free-plan quota | Per-IP caps (10 sockets, 30 connects a minute, IP kept only as a salted hash), 1000 sockets total, a per-socket token bucket (burst 300, 20/s), renames once per 2 s. |
| Offer and message spam | One pending offer per person, 10 offers or messages a minute per person, 10 queued Accept dialogs at most. |
| Files that run code (HTML, SVG…) | Received files keep their type only if it is a raster image, video, audio, PDF or plain text; everything else is `application/octet-stream`. |
| XSS, clickjacking | All peer content is inserted as text; strict CSP without inline script or style, `frame-ancestors 'none'`, plus nosniff, no-referrer, COOP, HSTS (`public/_headers`). |
| A sender pushing more than announced | The receiver cancels the moment a file exceeds its announced size. |
| Other sites posting to the share target | The service worker drops `/share` posts with another site's referrer; the banner names the shared files. |
| Taking over someone's lobby spot | The public id is a hash of a per-tab secret that never leaves the browser. |
| Key swapping in the middle | Each transfer shows a safety code derived from both DTLS fingerprints; both people see the same digits unless someone swapped keys. |

By design, everyone online can see everyone's random name and approximate city and country.

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

Without it there is no relay, so connections someone else starts (relay-only until you accept) can't be made.

`npm run icons` re-renders the PNG icons from `public/icons/icon.svg` (needs Google Chrome).

## Deploy

Pushing to `main` deploys through Cloudflare Workers Builds (`npx wrangler deploy`). The TURN secrets are set on the Worker, not in this repo.
