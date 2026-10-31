import { DurableObject } from 'cloudflare:workers';
import { pickIdentity, identityKey } from './identity.js';

// TURN credentials live this long. Clients ask for fresh ones (over the
// lobby socket, at most every ICE_REFRESH_MS) before they run out.
const ICE_TTL = 4 * 60 * 60;
const ICE_REFRESH_MS = 10 * 60 * 1000;
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const MAX_MESSAGE = 64 * 1024;

// Abuse limits. One global lobby sees every socket, so these are exact.
const MAX_SOCKETS = 1000; // whole lobby
const MAX_SOCKETS_PER_IP = 10; // a household or office shares one address
const MAX_CONNECTS_PER_IP_PER_MIN = 30; // reconnect churn
// One WebRTC connection sends 30-40 signaling messages in a few seconds
// (more on a phone with Wi-Fi + cellular), and a person may connect to
// several people at once, so leave plenty of room.
const BUCKET_SIZE = 300;
const BUCKET_REFILL_PER_SEC = 20;
const SHUFFLE_EVERY_MS = 2000;

// Other sites must not reach the lobby. Scripts can still fake Origin, which
// is why the lobby also rate-limits.
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
      const cf = request.cf || {};
      const headers = new Headers(request.headers);
      // Header values must be ASCII; city names often aren't ("Adapazarı").
      headers.set('X-City', encodeURIComponent(cf.city || ''));
      headers.set('X-Country', encodeURIComponent(cf.country || ''));
      headers.set('X-Client-IP', request.headers.get('CF-Connecting-IP') || '');
      const stub = env.LOBBY.get(env.LOBBY.idFromName('global'));
      return stub.fetch(new Request(request.url, { headers }));
    }

    // TURN credentials are only handed out inside the lobby connection.
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

    // Share target before the service worker is running: just open the app.
    if (url.pathname === '/share' && request.method === 'POST') {
      return Response.redirect(`${url.origin}/`, 303);
    }

    return env.ASSETS.fetch(request);
  },
};

async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: FALLBACK_ICE, ttl: ICE_TTL };
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: ICE_TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`TURN API ${res.status}`);
    const data = await res.json();
    // Browsers block port 53, so Cloudflare suggests dropping those URLs.
    const iceServers = data.iceServers
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return { iceServers, ttl: ICE_TTL };
  } catch (err) {
    console.error('ICE servers:', err.message);
    return { iceServers: FALLBACK_ICE, ttl: ICE_TTL };
  }
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const publicPeer = ({ id, name, color, animal, emoji, city, country }) => ({ id, name, color, animal, emoji, city, country });

// One global lobby. It only lists who is online and relays WebRTC signaling;
// files and messages travel directly between browsers.
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // In-memory rate state; it resets if the object hibernates, which is fine.
    this.buckets = new WeakMap();
    this.connects = new Map(); // ip hash -> recent connect times
  }

  // Sockets remember a salted hash of the client IP, never the IP itself.
  async ipHash(ip) {
    if (!this.salt) {
      this.salt = await this.ctx.storage.get('ipSalt');
      if (!this.salt) {
        this.salt = crypto.randomUUID();
        await this.ctx.storage.put('ipSalt', this.salt);
      }
    }
    return (await sha256hex(`${this.salt}:${ip}`)).slice(0, 16);
  }

  async fetch(request) {
    const ip = await this.ipHash(request.headers.get('X-Client-IP') || 'unknown');
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response('Lobby is full', { status: 503 });
    if (sockets.filter((ws) => (ws.deserializeAttachment() || {}).ip === ip).length >= MAX_SOCKETS_PER_IP) {
      return new Response('Too many connections', { status: 429 });
    }
    const now = Date.now();
    const recent = (this.connects.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= MAX_CONNECTS_PER_IP_PER_MIN) return new Response('Slow down', { status: 429 });
    recent.push(now);
    this.connects.set(ip, recent);
    if (this.connects.size > 5000) this.connects.clear();

    const decode = (v) => { try { return decodeURIComponent(v || ''); } catch { return ''; } };
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id: null,
      ip,
      city: decode(request.headers.get('X-City')).slice(0, 100),
      country: decode(request.headers.get('X-Country')).slice(0, 2),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Token bucket per socket; false means this message is over the limit.
  allow(ws) {
    const now = Date.now();
    const b = this.buckets.get(ws) || { tokens: BUCKET_SIZE, at: now, shuffleAt: 0 };
    b.tokens = Math.min(BUCKET_SIZE, b.tokens + ((now - b.at) / 1000) * BUCKET_REFILL_PER_SEC);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // Sockets that have said hello, with their peer data.
  peers(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const peer = ws.deserializeAttachment();
      if (peer && peer.id) out.push([ws, peer]);
    }
    return out;
  }

  broadcast(message, except) {
    const data = JSON.stringify(message);
    for (const [ws] of this.peers(except)) {
      try { ws.send(data); } catch {}
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    if (!this.allow(ws)) {
      this.leave(ws);
      try { ws.close(1008, 'Too many messages'); } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment();

    if (msg.t === 'hello') {
      if (me.id) return;
      // The public id is a hash of a secret only this client knows, so no one
      // else can take over its spot in the lobby.
      if (typeof msg.secret !== 'string' || !/^[0-9a-f]{32,64}$/.test(msg.secret)) {
        ws.close(1008, 'Bad hello');
        return;
      }
      const id = (await sha256hex(msg.secret)).slice(0, 24);
      const taken = new Set();
      for (const [other, peer] of this.peers(ws)) {
        if (peer.id === id) {
          // Same client reconnecting: retire the old socket without a "leave".
          other.serializeAttachment({ ...peer, id: null });
          try { other.close(4000, 'Replaced'); } catch {}
        } else {
          taken.add(identityKey(peer.color, peer.animal));
        }
      }
      const peer = { ...me, id, ...pickIdentity(msg.color, msg.animal, taken) };
      ws.serializeAttachment(peer);
      ws.send(JSON.stringify({
        t: 'welcome',
        self: publicPeer(peer),
        peers: this.peers(ws).map(([, p]) => publicPeer(p)),
      }));
      this.broadcast({ t: 'join', peer: publicPeer(peer) }, ws);
      await this.sendIce(ws);
      return;
    }

    if (!me.id) return;

    if (msg.t === 'ice') {
      if (Date.now() - (me.iceAt || 0) >= ICE_REFRESH_MS) await this.sendIce(ws);
      return;
    }

    if (msg.t === 'signal' && typeof msg.to === 'string') {
      const target = this.peers(ws).find(([, p]) => p.id === msg.to);
      if (target) target[0].send(JSON.stringify({ t: 'signal', from: me.id, data: msg.data }));
      else ws.send(JSON.stringify({ t: 'leave', id: msg.to }));
      return;
    }

    if (msg.t === 'shuffle') {
      // Every rename is broadcast to everyone, so it gets its own, slower limit.
      const b = this.buckets.get(ws);
      if (b && Date.now() - b.shuffleAt < SHUFFLE_EVERY_MS) return;
      if (b) b.shuffleAt = Date.now();
      const taken = new Set(this.peers(ws).map(([, p]) => identityKey(p.color, p.animal)));
      const peer = { ...me, ...pickIdentity(null, null, taken, identityKey(me.color, me.animal)) };
      ws.serializeAttachment(peer);
      ws.send(JSON.stringify({ t: 'you', self: publicPeer(peer) }));
      this.broadcast({ t: 'join', peer: publicPeer(peer) }, ws);
    }
  }

  async sendIce(ws) {
    const current = ws.deserializeAttachment();
    if (!current || !current.id) return;
    ws.serializeAttachment({ ...current, iceAt: Date.now() });
    const ice = await iceServers(this.env);
    try { ws.send(JSON.stringify({ t: 'ice', ...ice })); } catch {}
  }

  async webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Bye'); } catch {}
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const peer = ws.deserializeAttachment();
    if (!peer || !peer.id) return;
    ws.serializeAttachment({ ...peer, id: null });
    if (!this.peers(ws).some(([, p]) => p.id === peer.id)) this.broadcast({ t: 'leave', id: peer.id }, ws);
  }
}
