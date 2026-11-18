/* Tabmate Claude bridge (service worker side).
   Off until the person turns on "Connect to Claude" in the popup.
   When on, it looks for the tabmate-mcp server on 127.0.0.1 only, on a fixed set of ports.
   Both sides prove they hold the pairing token (HMAC challenge, the token itself is never sent).
   The server can only list learned workflows and run them; safety rails still apply. */
const bridge = { api: null, socks: new Map(), connecting: new Set(), clients: new Map() };
const BRIDGE_HOST = '127.0.0.1';

function bridgeInit(api) {
  bridge.api = api;
  chrome.alarms.create('tabmate-bridge', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tabmate-bridge') bridgeSync(); });
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.settings || c.bridgeToken)) bridgeSync(); });
  bridgeSync();
}

function bridgeStatus() {
  return { connected: bridge.socks.size, clients: [...new Set(bridge.clients.values())] };
}
function publishStatus() {
  chrome.storage.session.set({ bridge: bridgeStatus() }).catch(() => {});
}

async function bridgeSync() {
  const { settings, bridgeToken } = await chrome.storage.local.get(['settings', 'bridgeToken']);
  if (!(settings && settings.bridge && bridgeToken)) {
    for (const ws of bridge.socks.values()) ws.close(1000, 'off');
    bridge.socks.clear();
    bridge.clients.clear();
    return publishStatus();
  }
  // Servers take the first free port, so stop at the first port with nothing on it.
  for (const port of self.TabmateShared.BRIDGE_PORTS) {
    if (bridge.socks.has(port) || bridge.connecting.has(port)) continue;
    if (!(await probe(port))) break;
    bridgeConnect(port, bridgeToken);
  }
}

async function probe(port) {
  try {
    const r = await fetch('http://' + BRIDGE_HOST + ':' + port + '/tabmate-mcp', { cache: 'no-store', credentials: 'omit' });
    return r.ok && (await r.text()) === 'tabmate-mcp';
  } catch (e) { return false; }
}

async function hmacHex(token, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function bridgeConnect(port, token) {
  bridge.connecting.add(port);
  let ws;
  try { ws = new WebSocket('ws://' + BRIDGE_HOST + ':' + port + '/tabmate'); } catch (e) { bridge.connecting.delete(port); return; }
  let authed = false;
  let mine = '';
  const send = (m) => { try { ws.send(JSON.stringify(m)); } catch (e) { /* closed */ } };
  const giveUp = setTimeout(() => { if (!authed) ws.close(); }, 5000);
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return ws.close(); }
    if (!m || typeof m.t !== 'string') return;
    if (!authed) {
      if (m.t === 'hello' && typeof m.nonce === 'string' && !mine) {
        mine = nonce();
        send({ t: 'auth', mac: await hmacHex(token, 'tabmate-ext:' + m.nonce), nonce: mine, version: chrome.runtime.getManifest().version });
      } else if (m.t === 'ok' && mine && typeof m.mac === 'string' && m.mac === (await hmacHex(token, 'tabmate-srv:' + mine))) {
        authed = true;
        clearTimeout(giveUp);
        bridge.connecting.delete(port);
        bridge.socks.set(port, ws);
        bridge.clients.set(port, typeof m.client === 'string' ? m.client.slice(0, 40) : 'Claude');
        publishStatus();
      } else ws.close(); // anything else before both sides are proven: hang up
      return;
    }
    if (m.t === 'ping') return send({ t: 'pong' });
    if (m.t === 'client' && typeof m.client === 'string') { bridge.clients.set(port, m.client.slice(0, 40)); return publishStatus(); }
    if (m.t !== 'req' || typeof m.id !== 'number') return;
    try {
      const result = m.method === 'list' ? await bridge.api.tools()
        : m.method === 'run' ? await bridge.api.run(m.params || {})
        : null;
      if (result === null) send({ t: 'res', id: m.id, error: 'unknown method' });
      else send({ t: 'res', id: m.id, result });
    } catch (e) {
      send({ t: 'res', id: m.id, error: 'Tabmate could not do that' });
    }
  };
  ws.onclose = () => {
    clearTimeout(giveUp);
    bridge.connecting.delete(port);
    if (bridge.socks.get(port) === ws) { bridge.socks.delete(port); bridge.clients.delete(port); publishStatus(); }
  };
  ws.onerror = () => {};
}

function bridgeChanged() {
  for (const ws of bridge.socks.values()) { try { ws.send(JSON.stringify({ t: 'changed' })); } catch (e) { /* closed */ } }
}
