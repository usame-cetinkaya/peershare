import { DurableObject } from 'cloudflare:workers';
import { pickIdentity, identityKey } from './identity.js';

// TURN credentials live this long; transfers longer than this are unlikely.
const ICE_TTL = 12 * 60 * 60;
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const MAX_MESSAGE = 64 * 1024;

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...init.headers },
  });

// Requests from other sites must not get our TURN credentials or lobby.
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
      headers.set('X-City', cf.city || '');
      headers.set('X-Country', cf.country || '');
      const stub = env.LOBBY.get(env.LOBBY.idFromName('global'));
      return stub.fetch(new Request(request.url, { headers }));
    }

    if (url.pathname === '/api/ice') {
      if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
      return json(await iceServers(env));
    }

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
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id: null,
      city: request.headers.get('X-City') || '',
      country: request.headers.get('X-Country') || '',
    });
    return new Response(null, { status: 101, webSocket: client });
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
      return;
    }

    if (!me.id) return;

    if (msg.t === 'signal' && typeof msg.to === 'string') {
      const target = this.peers(ws).find(([, p]) => p.id === msg.to);
      if (target) target[0].send(JSON.stringify({ t: 'signal', from: me.id, data: msg.data }));
      else ws.send(JSON.stringify({ t: 'leave', id: msg.to }));
      return;
    }

    if (msg.t === 'shuffle') {
      const taken = new Set(this.peers(ws).map(([, p]) => identityKey(p.color, p.animal)));
      const peer = { ...me, ...pickIdentity(null, null, taken, identityKey(me.color, me.animal)) };
      ws.serializeAttachment(peer);
      ws.send(JSON.stringify({ t: 'you', self: publicPeer(peer) }));
      this.broadcast({ t: 'join', peer: publicPeer(peer) }, ws);
    }
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
