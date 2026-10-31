(() => {
  'use strict';

  // Data channel tuning: 64 KB messages, pause when 4 MB is queued.
  const CHUNK = 64 * 1024;
  const READ_BLOCK = 1024 * 1024;
  const HIGH_WATER = 4 * 1024 * 1024;
  const LOW_WATER = 1024 * 1024;
  const CONNECT_TIMEOUT = 25000;
  const MAX_TEXT = 10000;

  const IDENTITY_KEY = 'peershare.identity.v1';
  const SECRET_KEY = 'peershare.secret.v1';
  const INSTALL_DISMISS_KEY = 'peershare.installDismissed';
  const SHARE_CACHE = 'peershare-share';
  // Set when running inside the PeerShare Mac app.
  const mac = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.peershare;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    },
  };

  const randomHex = (bytes) =>
    [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Per tab, so a reload keeps the same spot in the lobby.
  function tabSecret(fresh = false) {
    try {
      let s = sessionStorage.getItem(SECRET_KEY);
      if (!s || fresh) {
        s = randomHex(32);
        sessionStorage.setItem(SECRET_KEY, s);
      }
      return s;
    } catch { return randomHex(32); }
  }

  // ---------- Formatting ----------

  function formatBytes(n) {
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  const regionNames = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
  })();
  const realCountry = (cc) => typeof cc === 'string' && /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1';

  function flagEmoji(cc) {
    if (!realCountry(cc)) return '';
    return String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  }

  function countryName(cc) {
    if (!realCountry(cc)) return '';
    try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; }
  }

  const placeText = (p) => [p.city, countryName(p.country)].filter(Boolean).join(', ') || 'Somewhere on Earth';

  const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---------- DOM helpers ----------

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const ICONS = {
    save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    open: '<path d="M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
  };
  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function avatar(p, cls = '') {
    const el = h('div', { class: `avatar ${cls}`.trim(), 'aria-hidden': 'true' });
    paintAvatar(el, p);
    return el;
  }
  function paintAvatar(el, p) {
    el.textContent = p.emoji;
    el.style.background = p.color;
  }
  function paintPlace(el, p) {
    el.textContent = '';
    const flag = flagEmoji(p.country);
    if (flag) el.append(h('span', { class: 'flag', 'aria-hidden': 'true' }, flag));
    el.append(placeText(p));
  }

  // Shrinks a one-line element's font until its text fits (ellipsis below min).
  function fitText(el, max, min) {
    el.style.fontSize = `${max}px`;
    if (!el.clientWidth || el.scrollWidth <= el.clientWidth) return;
    let size = Math.max(min, Math.floor((max * el.clientWidth) / el.scrollWidth * 2) / 2);
    el.style.fontSize = `${size}px`;
    while (size > min && el.scrollWidth > el.clientWidth) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  }

  function fitNames() {
    fitText($('me-name'), 21, 11);
    for (const el of document.querySelectorAll('.peer-name')) fitText(el, 16, 11);
  }
  window.addEventListener('resize', fitNames);

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Couldn’t copy');
    }
  }

  // ---------- State ----------

  let self = null;
  const peers = new Map();
  const conns = new Map();
  const items = []; // activity, newest first
  let pendingShare = null; // files/text shared into the app from another app

  const ACTIVE = new Set(['connecting', 'waiting', 'asking', 'sending', 'receiving']);
  const isActive = (it) => ACTIVE.has(it.status);

  const unknownPeer = (id) => ({ id, name: 'Someone', emoji: '❔', color: 'Gray', city: '', country: '' });
  const peerFor = (id) => peers.get(id) || unknownPeer(id);

  // ---------- Lobby connection ----------

  let ws = null;
  let backoff = 1000;
  let pingTimer = 0;
  let reconnectTimer = 0;
  let secret = tabSecret();

  function setStatus(state) {
    const el = $('status');
    el.dataset.state = state;
    el.textContent = { online: 'Online', connecting: 'Connecting…', offline: 'Offline' }[state];
    $('shuffle').disabled = state !== 'online';
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    setStatus('connecting');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = socket;
    socket.onopen = () => {
      backoff = 1000;
      const saved = store.get(IDENTITY_KEY, {}) || {};
      socket.send(JSON.stringify({ t: 'hello', secret, color: saved.color, animal: saved.animal }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 25000);
    };
    socket.onmessage = (e) => {
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onLobbyMessage(msg);
    };
    socket.onclose = (e) => {
      if (socket !== ws) return;
      clearInterval(pingTimer);
      ws = null;
      // Another tab took this tab's id (duplicated tab): become someone new.
      if (e.code === 4000) secret = tabSecret(true);
      setStatus(navigator.onLine ? 'connecting' : 'offline');
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  }

  function lobbySend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  const sendSignal = (to, data) => lobbySend({ t: 'signal', to, data });

  function onLobbyMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        self = msg.self;
        store.set(IDENTITY_KEY, { color: self.color, animal: self.animal });
        peers.clear();
        for (const p of msg.peers) peers.set(p.id, p);
        for (const conn of [...conns.values()]) if (!peers.has(conn.id) && !conn.inUse()) conn.close('left');
        setStatus('online');
        renderSelf();
        renderPeers();
        break;
      case 'you':
        self = msg.self;
        store.set(IDENTITY_KEY, { color: self.color, animal: self.animal });
        renderSelf();
        break;
      case 'join': {
        const isNew = !peers.has(msg.peer.id);
        peers.set(msg.peer.id, msg.peer);
        renderPeers(isNew ? msg.peer.id : null);
        if (sendTarget && sendTarget.id === msg.peer.id) fillSendHead(msg.peer);
        break;
      }
      case 'leave': {
        peers.delete(msg.id);
        const conn = conns.get(msg.id);
        if (conn && !conn.inUse()) conn.close('left');
        renderPeers();
        break;
      }
      case 'signal':
        if (self && typeof msg.from === 'string' && msg.data) getConn(msg.from).signal(msg.data);
        break;
      case 'ice':
        onIce(msg);
        break;
    }
  }

  // ---------- WebRTC ----------

  // TURN credentials arrive over the lobby socket ("ice"), never from a URL.
  let ice = null;
  let iceAt = 0;
  const iceWaiters = [];
  const ICE_WAIT_MS = 8000;

  function onIce(msg) {
    if (!Array.isArray(msg.iceServers)) return;
    ice = msg;
    iceAt = Date.now();
    for (const resolve of iceWaiters.splice(0)) resolve(ice.iceServers);
  }

  function getIceServers() {
    if (ice && Date.now() - iceAt < (ice.ttl * 1000) / 2) return Promise.resolve(ice.iceServers);
    if (ice) lobbySend({ t: 'ice' });
    return new Promise((resolve) => {
      iceWaiters.push(resolve);
      setTimeout(() => resolve(ice ? ice.iceServers : [{ urls: 'stun:stun.cloudflare.com:3478' }]), ICE_WAIT_MS);
    });
  }

  // One peer connection per person, with one ordered data channel. Text frames
  // are control messages; binary frames belong to the file being received.
  //
  // Privacy: a connection someone else starts is relay-only, so they only ever
  // see Cloudflare's addresses, never this device's IP. It switches to direct
  // (trust()) once this side sends them something or accepts their files.
  class Conn {
    constructor(peerId, trusted) {
      this.id = peerId;
      this.trusted = trusted;
      this.polite = self.id < peerId;
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.restarted = false;
      this.closed = false;
      this.route = null;
      this.incoming = null;
      this.signals = Promise.resolve();
      this.sendLock = Promise.resolve();
      this.opened = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
      this.opened.catch(() => {});
      this.ready = getIceServers().then((servers) => this.setup(servers));
    }

    setup(iceServers) {
      if (this.closed) return;
      this.config = { iceServers, iceTransportPolicy: this.trusted ? 'all' : 'relay' };
      const pc = (this.pc = new RTCPeerConnection(this.config));
      // Negotiated with a fixed id: both sides create it, so there is never a second channel.
      const dc = (this.dc = pc.createDataChannel('peershare', { negotiated: true, id: 0, ordered: true }));
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATER;
      dc.onopen = () => {
        this.resolveOpen();
        this.detectRoute();
        this.makeSafetyCode();
        // Re-check when ICE moves to a new path (e.g. relay -> direct after trust()).
        const ice = pc.sctp && pc.sctp.transport && pc.sctp.transport.iceTransport;
        if (ice && 'onselectedcandidatepairchange' in ice) ice.onselectedcandidatepairchange = () => this.detectRoute();
      };
      dc.onclose = () => this.close('closed');
      dc.onmessage = (e) => onChannelMessage(this, e.data);

      pc.onnegotiationneeded = async () => {
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          sendSignal(this.id, { description: pc.localDescription });
        } catch (err) {
          console.warn('Offer failed', err);
        } finally {
          this.makingOffer = false;
        }
      };
      pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(this.id, { candidate }); };
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        // The path can change after trust() restarts ICE.
        if ((state === 'connected' || state === 'completed') && this.isOpen) this.detectRoute();
        if (state !== 'failed') return;
        if (this.restarted) this.close('failed');
        else { this.restarted = true; pc.restartIce(); }
      };
    }

    // Allow a direct path: gather this device's own candidates and renegotiate.
    trust() {
      if (this.trusted || this.closed) return;
      this.trusted = true;
      if (!this.pc) return; // setup() has not run yet and will use 'all'
      this.config = { ...this.config, iceTransportPolicy: 'all' };
      try {
        this.pc.setConfiguration(this.config);
        this.pc.restartIce();
      } catch (err) {
        console.warn('Could not switch to direct', err);
      }
    }

    signal(data) {
      this.signals = this.signals
        .then(() => this.ready)
        .then(() => this.handleSignal(data))
        .catch((err) => console.warn('Signal failed', err));
    }

    // "Perfect negotiation": the polite side yields when both offer at once.
    async handleSignal({ description, candidate }) {
      if (this.closed) return;
      const pc = this.pc;
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(this.id, { description: pc.localDescription });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.ignoreOffer) console.warn('ICE candidate failed', err);
        }
      }
    }

    open() {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT); });
      return Promise.race([this.opened, timeout]).finally(() => clearTimeout(timer));
    }

    get isOpen() {
      return !this.closed && this.dc && this.dc.readyState === 'open';
    }

    send(msg) {
      this.dc.send(JSON.stringify(msg));
    }

    get chunkSize() {
      const max = this.pc.sctp && this.pc.sctp.maxMessageSize;
      return max > 0 && Number.isFinite(max) ? Math.min(CHUNK, max) : CHUNK;
    }

    drain() {
      const dc = this.dc;
      if (dc.readyState !== 'open') return Promise.reject(new Error('closed'));
      if (dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          if (dc.readyState === 'open') resolve();
          else reject(new Error('closed'));
        };
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
      });
    }

    // Both sides derive the same 6 digits from the two DTLS certificate
    // fingerprints. If someone in the middle (even the signaling server)
    // swapped keys, the two people would see different codes.
    async makeSafetyCode() {
      try {
        const fp = (desc) => ((desc && desc.sdp.match(/a=fingerprint:\S+ (\S+)/)) || [])[1];
        const pair = [fp(this.pc.localDescription), fp(this.pc.remoteDescription)];
        if (!pair[0] || !pair[1]) return;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair.sort().join('|')));
        const digits = String(new DataView(digest).getUint32(0) % 1e6).padStart(6, '0');
        this.code = `${digits.slice(0, 3)} ${digits.slice(3)}`;
        for (const it of items) if (it.conn === this && isActive(it)) renderItem(it);
        if (asking && asking.conn === this) $('incoming-code').textContent = codeText(this.code);
      } catch {}
    }

    async detectRoute() {
      try {
        const stats = await this.pc.getStats();
        let pair = null;
        stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
        if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = pair || s; });
        if (!pair) return;
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        this.route = [local, remote].some((c) => c && c.candidateType === 'relay') ? 'relay' : 'direct';
        for (const it of items) if (it.conn === this && isActive(it)) renderItem(it);
      } catch {}
    }

    // Busy with something the other side is still part of.
    inUse() {
      return this.isOpen && items.some((it) => it.conn === this && isActive(it));
    }

    close(reason) {
      if (this.closed) return;
      this.closed = true;
      this.rejectOpen(new Error(reason));
      try { this.dc && this.dc.close(); } catch {}
      try { this.pc && this.pc.close(); } catch {}
      if (conns.get(this.id) === this) conns.delete(this.id);
      for (const it of items) if (it.conn === this && isActive(it)) finishItem(it, 'failed');
    }
  }

  // trusted: this side is reaching out, so a direct connection is fine.
  function getConn(peerId, trusted = false) {
    let conn = conns.get(peerId);
    if (!conn || conn.closed) {
      conn = new Conn(peerId, trusted);
      conns.set(peerId, conn);
    } else if (trusted) {
      conn.trust();
    }
    return conn;
  }

  // ---------- Sending ----------

  function newItem(fields) {
    const it = { xid: randomHex(8), at: Date.now(), done: 0, sent: 0, total: 0, ...fields };
    items.unshift(it);
    renderItem(it);
    updateWakeLock();
    return it;
  }

  async function connectFor(it) {
    const conn = getConn(it.peer.id, true);
    it.conn = conn;
    try {
      await conn.open();
      return isActive(it) ? conn : null;
    } catch {
      if (!conn.isOpen) conn.close('timeout');
      if (isActive(it)) finishItem(it, 'failed', `Couldn’t reach ${it.peer.name}`);
      return null;
    }
  }

  async function sendText(peer, text) {
    const it = newItem({ kind: 'text', dir: 'out', peer, text, status: 'connecting' });
    const conn = await connectFor(it);
    if (!conn) return;
    conn.send({ t: 'text', id: it.xid, text });
    setItemStatus(it, 'sending');
  }

  async function sendFiles(peer, files) {
    const it = newItem({
      kind: 'files',
      dir: 'out',
      peer,
      status: 'connecting',
      files: files.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        file: f,
        thumb: f instanceof Blob && f.type.startsWith('image/') && f.size < 30e6 ? URL.createObjectURL(f) : null,
      })),
      total: files.reduce((sum, f) => sum + f.size, 0),
    });
    const conn = await connectFor(it);
    if (!conn) return;
    const answer = new Promise((resolve) => { it.resolveAnswer = resolve; });
    conn.send({ t: 'offer', id: it.xid, files: it.files.map(({ name, size, type }) => ({ name, size, type })) });
    setItemStatus(it, 'waiting');
    const accepted = await answer;
    if (!isActive(it)) return;
    if (!accepted) {
      if (it.busy) return finishItem(it, 'failed', `${peer.name} has too many requests waiting. Try again in a minute.`);
      return finishItem(it, 'declined');
    }

    const run = conn.sendLock.then(() => streamFiles(conn, it));
    conn.sendLock = run.catch(() => {});
    try {
      await run;
    } catch {
      if (isActive(it)) finishItem(it, 'failed');
    }
  }

  async function streamFiles(conn, it) {
    if (!isActive(it)) return;
    it.started = performance.now();
    setItemStatus(it, 'sending');
    conn.detectRoute();
    const size = conn.chunkSize;
    for (let i = 0; i < it.files.length; i++) {
      const f = it.files[i];
      conn.send({ t: 'begin', id: it.xid, index: i });
      for (let off = 0; off < f.size; off += READ_BLOCK) {
        const block = await f.file.slice(off, off + READ_BLOCK).arrayBuffer();
        for (let pos = 0; pos < block.byteLength; pos += size) {
          await conn.drain();
          if (!isActive(it)) return;
          conn.dc.send(block.slice(pos, pos + size));
          it.sent += Math.min(size, block.byteLength - pos);
        }
      }
      conn.send({ t: 'end', id: it.xid, index: i });
    }
    // Stays "sending" until the receiver confirms with "done".
  }

  function cancelItem(it) {
    if (!isActive(it)) return;
    if (it.conn && it.conn.isOpen) {
      try { it.conn.send({ t: 'cancel', id: it.xid }); } catch {}
    }
    finishItem(it, 'cancelled');
  }

  // ---------- Receiving ----------

  // The sender picks the file type. A blob URL runs in this app's origin, so a
  // file the browser might render (HTML, SVG, XML…) is kept as a plain download.
  const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|heic|heif)$/;
  // Types no browser renders as an active page: media, PDF, plain-ish text,
  // archives and office documents (so phones still offer the right apps).
  const SAFE_TYPE = new RegExp([
    '^(video|audio)/[\\w.+-]+$',
    '^text/(plain|csv|markdown|calendar|vcard)$',
    '^application/(pdf|json|zip|x-zip-compressed|gzip|x-7z-compressed|vnd\\.rar|epub\\+zip)$',
    '^application/(msword|vnd\\.ms-excel|vnd\\.ms-powerpoint)$',
    '^application/vnd\\.(openxmlformats-officedocument|oasis\\.opendocument)\\.[\\w.+-]+$',
  ].join('|'));
  const safeType = (type) => (SAFE_IMAGE.test(type) || SAFE_TYPE.test(type) ? type : 'application/octet-stream');

  const safeName = (name) => String(name || '').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255) || 'file';
  const findItem = (conn, xid) => items.find((it) => it.xid === xid && it.peer.id === conn.id);

  // Spam limits for what others send you: per person per minute, and how many
  // Accept dialogs may queue up.
  const MAX_INCOMING_PER_MIN = 30;
  const MAX_PENDING_PER_PEER = 3;
  const MAX_ASK_QUEUE = 10;
  const incomingTimes = new Map(); // peer id -> recent arrival times

  function allowIncoming(peerId) {
    const now = Date.now();
    const recent = (incomingTimes.get(peerId) || []).filter((t) => now - t < 60000);
    if (recent.length >= MAX_INCOMING_PER_MIN) return false;
    recent.push(now);
    incomingTimes.set(peerId, recent);
    return true;
  }

  function onChannelMessage(conn, data) {
    if (typeof data !== 'string') return onChunk(conn, data);
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const it = typeof msg.id === 'string' ? findItem(conn, msg.id) : null;

    switch (msg.t) {
      case 'text': {
        if (typeof msg.text !== 'string' || typeof msg.id !== 'string') return;
        if (!allowIncoming(conn.id)) {
          conn.send({ t: 'busy', id: msg.id });
          return;
        }
        newItem({ kind: 'text', dir: 'in', xid: msg.id.slice(0, 40), peer: peerFor(conn.id), conn, text: msg.text.slice(0, MAX_TEXT), status: 'received' });
        conn.send({ t: 'got', id: msg.id });
        notify();
        break;
      }
      case 'got':
      case 'done':
        if (it && isActive(it)) finishItem(it, 'delivered');
        break;
      case 'offer': {
        if (typeof msg.id !== 'string' || !Array.isArray(msg.files) || !msg.files.length) return;
        const pending = items.filter((x) => x.status === 'asking' && x.peer.id === conn.id).length;
        if (pending >= MAX_PENDING_PER_PEER || askQueue.length >= MAX_ASK_QUEUE || !allowIncoming(conn.id)) {
          conn.send({ t: 'answer', id: msg.id, accept: false, busy: true });
          return;
        }
        const files = msg.files.slice(0, 2000).map((f) => ({
          name: safeName(f && f.name),
          size: Math.max(0, Math.floor(Number(f && f.size) || 0)),
          type: f && typeof f.type === 'string' ? f.type.slice(0, 200) : '',
          received: 0,
        }));
        const offer = newItem({
          kind: 'files',
          dir: 'in',
          xid: msg.id.slice(0, 40),
          peer: peerFor(conn.id),
          conn,
          files,
          total: files.reduce((sum, f) => sum + f.size, 0),
          status: 'asking',
        });
        askQueue.push(offer);
        showNextAsk();
        notify();
        break;
      }
      case 'answer':
        if (it && it.resolveAnswer) {
          it.busy = msg.busy === true;
          it.resolveAnswer(msg.accept === true);
        }
        break;
      case 'busy':
        if (it && isActive(it)) finishItem(it, 'failed', `${it.peer.name} is getting too many messages. Try again in a minute.`);
        break;
      case 'begin':
        if (it && it.status === 'receiving' && it.files[msg.index]) {
          if (!it.started) {
            it.started = performance.now();
            conn.detectRoute();
          }
          conn.incoming = { it, index: msg.index, parts: [], chunks: [], received: 0 };
        } else {
          conn.incoming = null;
        }
        break;
      case 'end':
        endIncomingFile(conn, msg);
        break;
      case 'cancel':
        if (it && isActive(it)) finishItem(it, 'cancelled', `${it.peer.name} cancelled`);
        break;
    }
  }

  function onChunk(conn, buf) {
    const cur = conn.incoming;
    if (!cur || cur.it.status !== 'receiving') return;
    // A sender must not push more than it announced (and you accepted).
    const f = cur.it.files[cur.index];
    if (cur.received + buf.byteLength > f.size) {
      try { conn.send({ t: 'cancel', id: cur.it.xid }); } catch {}
      finishItem(cur.it, 'failed', `${f.name} was bigger than announced`);
      return;
    }
    cur.chunks.push(buf);
    cur.received += buf.byteLength;
    cur.it.done += buf.byteLength;
    // Fold chunks into Blobs every ~16 MB so the browser can spill them to disk.
    if (cur.chunks.length >= 256) {
      cur.parts.push(new Blob(cur.chunks));
      cur.chunks = [];
    }
  }

  function endIncomingFile(conn, msg) {
    const cur = conn.incoming;
    conn.incoming = null;
    if (!cur || cur.it.status !== 'receiving' || cur.it.xid !== msg.id || cur.index !== msg.index) return;
    const it = cur.it;
    const f = it.files[cur.index];
    if (cur.received !== f.size) {
      try { conn.send({ t: 'cancel', id: it.xid }); } catch {}
      return finishItem(it, 'failed', `${f.name} arrived incomplete`);
    }
    f.blob = new Blob([...cur.parts, ...cur.chunks], { type: safeType(f.type) });
    f.url = URL.createObjectURL(f.blob);
    if (SAFE_IMAGE.test(f.blob.type)) f.thumb = f.url;
    if (cur.index === it.files.length - 1) {
      conn.send({ t: 'done', id: it.xid });
      finishItem(it, 'received');
    } else {
      renderItem(it);
    }
  }

  // ---------- Accept / decline ----------

  const codeText = (code) => `Safety code ${code}. To be sure who this is, check they see the same code.`;

  const askQueue = [];
  let asking = null;
  const incomingDialog = $('incoming-dialog');

  function showNextAsk() {
    if (asking) return;
    while (askQueue.length && askQueue[0].status !== 'asking') askQueue.shift();
    if (!askQueue.length) return;
    asking = askQueue.shift();
    const it = asking;
    paintAvatar($('incoming-avatar'), it.peer);
    $('incoming-title').textContent = it.peer.name;
    paintPlace($('incoming-place'), it.peer);
    const n = it.files.length;
    $('incoming-lead').textContent = `wants to send you ${n === 1 ? 'a file' : `${n} files`} (${formatBytes(it.total)}).`;
    $('incoming-code').textContent = it.conn.code ? codeText(it.conn.code) : '';
    const shown = it.files.slice(0, 5).map((f) =>
      h('li', {}, h('span', { class: 'fname' }, f.name), h('span', { class: 'fsize' }, formatBytes(f.size))));
    if (n > 5) shown.push(h('li', { class: 'muted' }, `and ${n - 5} more`));
    $('incoming-files').replaceChildren(...shown);
    if (!incomingDialog.open) incomingDialog.showModal();
    $('accept').focus();
  }

  function answerItem(it, accept) {
    if (it.status !== 'asking') return;
    try { it.conn.send({ t: 'answer', id: it.xid, accept }); } catch {}
    if (accept) {
      it.conn.trust();
      setItemStatus(it, 'receiving');
    } else {
      finishItem(it, 'declined');
    }
  }

  function closeAsk() {
    asking = null;
    if (incomingDialog.open) incomingDialog.close();
    showNextAsk();
  }

  $('accept').addEventListener('click', () => { if (asking) answerItem(asking, true); closeAsk(); });
  $('decline').addEventListener('click', () => { if (asking) answerItem(asking, false); closeAsk(); });
  incomingDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (asking) answerItem(asking, false);
    closeAsk();
  });

  // ---------- Item status ----------

  function setItemStatus(it, status) {
    it.status = status;
    renderItem(it);
    updateWakeLock();
  }

  function finishItem(it, status, note) {
    it.status = status;
    it.note = note || null;
    if (it.resolveAnswer) it.resolveAnswer(false);
    if (it.conn && it.conn.incoming && it.conn.incoming.it === it) it.conn.incoming = null;
    if (asking === it) closeAsk();
    renderItem(it);
    updateWakeLock();
    if (status === 'failed' && note) toast(note);
  }

  // ---------- Rendering: you and others ----------

  function renderSelf() {
    if (!self) return;
    paintAvatar($('me-avatar'), self);
    $('me-name').textContent = self.name;
    fitText($('me-name'), 21, 11);
    paintPlace($('me-place'), self);
  }

  function renderPeers(newId = null) {
    const list = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    $('peer-list').replaceChildren(...list.map((p) => h('li', {}, peerButton(p, p.id === newId))));
    $('empty').hidden = !self || list.length > 0;
    $('peer-hint').hidden = !list.length;
    $('peer-count').textContent = list.length ? `${list.length}` : '';
    for (const el of $('peer-list').querySelectorAll('.peer-name')) fitText(el, 16, 11);
  }

  function peerButton(p, isNew) {
    const place = h('div', { class: 'place muted' });
    paintPlace(place, p);
    const btn = h('button', { type: 'button', class: `peer${isNew ? ' peer-new' : ''}`, 'aria-label': `Send to ${p.name}, ${placeText(p)}` },
      avatar(p),
      h('div', { class: 'peer-text' }, h('div', { class: 'peer-name' }, p.name), place),
      icon('chevron', 'peer-go'));
    btn.addEventListener('click', () => openSend(peers.get(p.id) || p, pendingShare ? pendingShare.files : [], pendingShare ? pendingShare.text : ''));
    // Drop files straight onto a person (desktop).
    btn.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      btn.classList.add('dragover');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('dragover'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('dragover');
      const files = [...e.dataTransfer.files];
      if (files.length) openSend(peers.get(p.id) || p, files);
    });
    return btn;
  }

  // ---------- Rendering: activity ----------

  const STATUS = {
    connecting: ['Connecting…', ''],
    waiting: ['Waiting for OK', ''],
    asking: ['Wants to send', ''],
    sending: ['Sending', ''],
    receiving: ['Receiving', ''],
    delivered: ['Delivered', 'ok'],
    received: ['Received', 'ok'],
    declined: ['Declined', 'bad'],
    cancelled: ['Cancelled', 'bad'],
    failed: ['Failed', 'bad'],
  };

  function linkify(text) {
    const out = [];
    const re = /https?:\/\/[^\s<>"]+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      let url = m[0].replace(/[.,;:!?)\]}'’]+$/, '');
      out.push(text.slice(last, m.index));
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    out.push(text.slice(last));
    return out;
  }

  const singleUrl = (text) => /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : null;

  function iconButton(name, label, onclick) {
    return h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick }, icon(name));
  }

  function saveFile(f) {
    const a = h('a', { href: f.url, download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function shareFiles(files) {
    try {
      await navigator.share({ files: files.map((f) => new File([f.blob], f.name, { type: f.blob.type })) });
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Couldn’t share');
    }
  }

  const canShareFiles = (files) => {
    try {
      return !!navigator.canShare && navigator.canShare({ files: files.map((f) => new File([f.blob], f.name, { type: f.blob.type })) });
    } catch { return false; }
  };

  function fileRow(it, f) {
    const preview = f.thumb
      ? h('img', { class: 'thumb', src: f.thumb, alt: '' })
      : h('div', { class: 'ficon' }, icon('file'));
    const actions = h('div', { class: 'actions' });
    if (f.url) {
      if (canShareFiles([f])) actions.append(iconButton('share', `Share ${f.name}`, () => shareFiles([f])));
      actions.append(iconButton('save', `Save ${f.name}`, () => saveFile(f)));
    }
    let size = formatBytes(f.size);
    if (it.dir === 'in' && it.status === 'receiving' && !f.url && f.received) size = `${formatBytes(f.received)} of ${size}`;
    return h('li', { class: 'file' },
      preview,
      h('div', { class: 'fmeta' }, h('div', { class: 'fname', title: f.name }, f.name), h('div', { class: 'fsize' }, size)),
      actions);
  }

  function renderItem(it) {
    const [label, tone] = STATUS[it.status];
    const who = h('div', { class: 'who' }, it.dir === 'out' ? 'To ' : 'From ', h('b', {}, it.peer.name));
    const el = h('li', { class: 'item card' },
      h('div', { class: 'item-head' },
        avatar(it.peer, 'avatar-sm'),
        who,
        h('span', { class: `tag ${tone}` }, label),
        h('span', { class: 'when' }, timeText(it.at))));

    if (it.kind === 'text') {
      el.append(h('p', { class: 'message' }, linkify(it.text)));
    } else {
      el.append(h('ul', { class: 'files' }, it.files.map((f) => fileRow(it, f))));
    }

    it.bar = it.ptext = null;
    if (it.kind === 'files' && (it.status === 'sending' || it.status === 'receiving')) {
      it.bar = h('span');
      it.ptext = h('div', { class: 'progress-text' }, h('span'), h('span'));
      el.append(h('div', { class: 'progress' }, h('div', { class: 'bar' }, it.bar), it.ptext));
      updateProgress(it);
    }

    const route = it.conn && it.conn.route;
    if (route && it.kind === 'files' && isActive(it)) it.route = route;
    if (it.conn && it.conn.code) it.code = it.conn.code;
    const notes = [];
    if (it.note) notes.push(it.note);
    if (it.code) notes.push(`Safety code ${it.code}`);
    if (it.status === 'waiting') notes.push(`Waiting for ${it.peer.name} to accept`);
    if (it.route && it.kind === 'files') notes.push(it.route === 'relay' ? 'Relayed through Cloudflare (still encrypted)' : 'Direct connection');

    const actions = h('div', { class: 'item-actions' });
    if (notes.length) actions.append(h('span', { class: 'muted item-note' }, notes.join(' · ')));
    if (it.status === 'asking') {
      actions.append(
        h('button', { type: 'button', class: 'secondary', onclick: () => { answerItem(it, false); if (asking === it) closeAsk(); } }, 'Decline'),
        h('button', { type: 'button', class: 'primary', onclick: () => { answerItem(it, true); if (asking === it) closeAsk(); } }, 'Accept'));
    } else if (isActive(it)) {
      actions.append(h('button', { type: 'button', class: 'secondary', onclick: () => cancelItem(it) }, 'Cancel'));
    } else if (it.kind === 'text' && it.dir === 'in') {
      const url = singleUrl(it.text);
      actions.append(h('button', { type: 'button', class: 'secondary', onclick: () => copyText(it.text) }, icon('copy'), 'Copy'));
      if (url) actions.append(h('a', { class: 'primary', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('open'), 'Open'));
    } else if (it.kind === 'files' && it.status === 'received' && it.files.length > 1) {
      if (canShareFiles(it.files)) actions.append(h('button', { type: 'button', class: 'secondary', onclick: () => shareFiles(it.files) }, icon('share'), 'Share all'));
      actions.append(h('button', { type: 'button', class: 'primary', onclick: () => saveAll(it) }, icon('save'), 'Save all'));
    }
    if (actions.childNodes.length) el.append(actions);

    if (it.el && it.el.isConnected) it.el.replaceWith(el);
    else $('activity').prepend(el);
    it.el = el;
    $('activity-section').hidden = false;
  }

  async function saveAll(it) {
    for (const f of it.files) {
      saveFile(f);
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  function updateProgress(it) {
    if (!it.bar) return;
    const done = it.dir === 'out' ? Math.max(0, it.sent - (it.conn && it.conn.dc ? it.conn.dc.bufferedAmount : 0)) : it.done;
    const pct = it.total ? Math.min(100, (done / it.total) * 100) : 100;
    it.bar.style.width = `${pct.toFixed(1)}%`;
    const secs = it.started ? (performance.now() - it.started) / 1000 : 0;
    const rate = secs > 0.5 ? done / secs : 0;
    it.ptext.firstChild.textContent = `${formatBytes(done)} of ${formatBytes(it.total)}`;
    it.ptext.lastChild.textContent = rate ? `${formatBytes(rate)}/s` : '';
  }

  let lastFileRender = 0;
  setInterval(() => {
    const now = Date.now();
    const refreshFiles = now - lastFileRender > 1000;
    for (const it of items) {
      if (it.status !== 'sending' && it.status !== 'receiving') continue;
      if (refreshFiles && it.dir === 'in' && it.conn && it.conn.incoming && it.conn.incoming.it === it) {
        it.files[it.conn.incoming.index].received = it.conn.incoming.received;
        renderItem(it);
      } else {
        updateProgress(it);
      }
    }
    if (refreshFiles) lastFileRender = now;
  }, 250);

  $('clear-activity').addEventListener('click', () => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (isActive(it)) continue;
      for (const f of it.files || []) {
        if (f.url) URL.revokeObjectURL(f.url);
        if (f.thumb && f.thumb !== f.url) URL.revokeObjectURL(f.thumb);
      }
      it.el.remove();
      items.splice(i, 1);
    }
    $('activity-section').hidden = items.length === 0;
  });

  // ---------- Send sheet ----------

  const sendDialog = $('send-dialog');
  const fileInput = $('file-input');
  const sendText_ = $('send-text');
  sendText_.maxLength = MAX_TEXT;
  let sendTarget = null;
  let picked = [];

  function fillSendHead(p) {
    paintAvatar($('send-avatar'), p);
    $('send-title').textContent = p.name;
    paintPlace($('send-place'), p);
  }

  function openSend(peer, files = [], text = '') {
    sendTarget = peer;
    picked = [...files];
    sendText_.value = text || '';
    fillSendHead(peer);
    renderPicked();
    if (!sendDialog.open) sendDialog.showModal();
    if (!files.length && matchMedia('(pointer: fine)').matches) sendText_.focus();
  }

  function renderPicked() {
    $('picked').replaceChildren(...picked.map((f, i) =>
      h('li', {},
        h('span', { class: 'fname', title: f.name }, f.name),
        h('span', { class: 'fsize' }, formatBytes(f.size)),
        h('button', {
          type: 'button', class: 'icon-btn remove', 'aria-label': `Remove ${f.name}`,
          onclick: () => { picked.splice(i, 1); renderPicked(); },
        }, icon('x')))));
    $('drop-label').textContent = picked.length ? 'Add more files' : 'Choose files';
    updateSendButton();
  }

  function updateSendButton() {
    const text = sendText_.value.trim();
    const n = picked.length;
    $('send-btn').disabled = !text && !n;
    let label = 'Send';
    if (n) label = `Send ${n === 1 ? '1 file' : `${n} files`}${text ? ' + message' : ''}`;
    else if (text) label = singleUrl(text) ? 'Send link' : 'Send message';
    $('send-btn-label').textContent = label;
  }

  fileInput.addEventListener('change', () => {
    picked.push(...fileInput.files);
    fileInput.value = '';
    renderPicked();
  });
  sendText_.addEventListener('input', updateSendButton);
  sendText_.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('send-form').requestSubmit();
    }
  });

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    picked.push(...e.dataTransfer.files);
    renderPicked();
  });
  sendDialog.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (!files.length) return;
    e.preventDefault();
    picked.push(...files);
    renderPicked();
  });

  $('send-close').addEventListener('click', () => sendDialog.close());
  sendDialog.addEventListener('close', () => { sendTarget = null; });
  // Tap outside the sheet to close it.
  sendDialog.addEventListener('click', (e) => { if (e.target === sendDialog) sendDialog.close(); });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const peer = sendTarget;
    const text = sendText_.value.trim();
    const files = picked;
    if (!peer || (!text && !files.length)) return;
    picked = [];
    sendDialog.close();
    clearShare();
    if (text) sendText(peer, text);
    if (files.length) sendFiles(peer, files);
  });

  // ---------- Shared into the app (Android share target, Mac share menu) ----------

  function setShare(share) {
    pendingShare = share;
    // Name what was shared, so nothing unexpected gets sent along.
    const names = share.files.map((f) => f.name);
    let what = names.slice(0, 2).join(', ');
    if (names.length > 2) what += ` and ${names.length - 2} more`;
    if (!names.length) what = share.text.length > 40 ? `${share.text.slice(0, 40)}…` : share.text;
    $('share-banner-text').textContent = `${matchMedia('(pointer: fine)').matches ? 'Click' : 'Tap'} someone to send ${what}`;
    $('share-banner').hidden = false;
  }

  function clearShare() {
    pendingShare = null;
    $('share-banner').hidden = true;
  }
  $('share-banner-clear').addEventListener('click', clearShare);

  async function loadShared() {
    const params = new URLSearchParams(location.search);
    if (!params.has('share')) return;
    history.replaceState(null, '', '/');
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(SHARE_CACHE);
      const files = [];
      let text = '';
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (new URL(req.url).pathname === '/__share/text') {
          text = await res.text();
        } else {
          const blob = await res.blob();
          files.push(new File([blob], decodeURIComponent(res.headers.get('X-Name') || 'file'), { type: blob.type }));
        }
        await cache.delete(req);
      }
      if (files.length || text) setShare({ files, text });
    } catch {}
  }

  // ---------- Attention, wake lock, leaving ----------

  let unseen = 0;
  function notify() {
    if (!document.hidden) return;
    unseen++;
    document.title = `(${unseen}) PeerShare`;
    if (navigator.vibrate) navigator.vibrate(150);
  }

  // Keep the screen on while a transfer is under way, including while it
  // connects or waits for the other person to accept: a phone that goes to
  // sleep puts the app in the background, which stalls the transfer.
  const AWAKE = new Set(['connecting', 'waiting', 'sending', 'receiving']);
  const keepsAwake = () => items.some((it) => AWAKE.has(it.status));
  let wakeLock = null;
  let wakeLockPending = false;
  let wakeLockFailed = false;
  let macBusy = false;

  // Fallback where the Wake Lock API is missing or failed, and on iOS, where
  // home-screen apps before iOS 18.4 got a lock that did nothing: a tiny muted
  // video playing on a loop keeps the screen on.
  let awakeVideo = null;
  function playAwakeVideo(on) {
    if (on) {
      if (!awakeVideo) {
        awakeVideo = h('video', { class: 'keep-awake', src: '/keep-awake.mp4', muted: true, playsinline: true, loop: true, 'aria-hidden': 'true' });
        awakeVideo.muted = true;
        document.body.append(awakeVideo);
      }
      awakeVideo.play().catch(() => {});
    } else if (awakeVideo && !awakeVideo.paused) {
      awakeVideo.pause();
    }
  }

  async function updateWakeLock() {
    const busy = keepsAwake();
    const visible = document.visibilityState === 'visible';
    // The Mac app keeps the Mac awake itself, and keeps going in the background.
    $('awake-hint').hidden = !busy || !!mac;
    if (mac && busy !== macBusy) {
      macBusy = busy;
      mac.postMessage({ t: 'busy', on: busy }).catch(() => {});
    }
    const hasApi = 'wakeLock' in navigator;
    playAwakeVideo(busy && visible && (!hasApi || wakeLockFailed || isIos()));

    if (busy && visible && hasApi && !wakeLock && !wakeLockPending) {
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock !== lock) return;
          wakeLock = null;
          // Released by the system (not by us): take it again if still needed.
          if (keepsAwake() && document.visibilityState === 'visible') setTimeout(updateWakeLock, 1000);
        });
      } catch {
        wakeLockFailed = true;
        playAwakeVideo(keepsAwake() && document.visibilityState === 'visible');
      } finally {
        wakeLockPending = false;
      }
      // The transfer may have ended while the request was pending.
      if (!keepsAwake()) updateWakeLock();
    } else if (!busy && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    unseen = 0;
    document.title = 'PeerShare';
    updateWakeLock();
    if (!ws) connect();
  });
  window.addEventListener('online', () => { if (!ws) connect(); });
  window.addEventListener('offline', () => setStatus('offline'));
  window.addEventListener('beforeunload', (e) => {
    if (keepsAwake()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  $('shuffle').addEventListener('click', () => lobbySend({ t: 'shuffle' }));

  $('copy-link').addEventListener('click', async () => {
    const url = location.origin;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'PeerShare', url }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    copyText(url);
  });

  // ---------- Install card ----------

  const installEl = $('install');
  const installTitle = $('install-title');
  const installSteps = $('install-steps');
  const installBtn = $('install-btn');
  let installPrompt = null;

  const isInstalled = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    navigator.standalone === true;

  // iPadOS reports itself as a Mac, but has touch.
  const isIos = () => {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  };

  // Ask again two weeks after "Not now".
  const installDismissed = () => Date.now() - Number(store.get(INSTALL_DISMISS_KEY, 0)) < 14 * 24 * 60 * 60 * 1000;

  function renderInstall() {
    const ios = isIos();
    installEl.hidden = isInstalled() || installDismissed() || (!installPrompt && !ios);
    installTitle.textContent = ios ? 'Add to your Home Screen' : 'Install PeerShare';
    installSteps.hidden = !ios;
    installBtn.hidden = ios;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installEl.hidden = true;
  });
  installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    const p = installPrompt;
    installPrompt = null;
    await p.prompt();
    await p.userChoice.catch(() => {});
    renderInstall();
  });
  $('install-close').addEventListener('click', () => {
    store.set(INSTALL_DISMISS_KEY, Date.now());
    installEl.hidden = true;
  });

  // ---------- Mac app ----------

  // Files from the Mac share menu stay on disk; the app hands them over in
  // blocks as they're sent, so even huge files never sit in memory.
  if (mac) {
    const ask = (msg) => mac.postMessage(msg);
    const decode = (b64) => Uint8Array.fromBase64
      ? Uint8Array.fromBase64(b64)
      : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const macFile = (f) => ({
      name: String(f.name),
      size: Number(f.size),
      type: String(f.type || ''),
      slice: (start, end) => ({
        arrayBuffer: async () => decode(await ask({ t: 'read', id: f.id, start, end: Math.min(end, f.size) })).buffer,
      }),
    });
    const receive = (share) => {
      if (!share) return;
      const files = (share.files || []).map(macFile);
      const text = String(share.text || '').slice(0, MAX_TEXT);
      if (files.length || text) setShare({ files, text });
    };
    window.peershareMac = { share: receive };
    ask({ t: 'ready' }).then(receive).catch(() => {});
  }

  // ---------- Startup ----------

  renderInstall();
  connect();
  loadShared();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
