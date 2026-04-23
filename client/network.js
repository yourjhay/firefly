// Plain WebSocket client with auto-reconnect and a tiny event bus.
// Server URL resolution (first match wins):
//   1. ?server=ws://host[:port][/path]   (URL override, remembered in localStorage)
//   2. localStorage "maze.serverUrl"
//   3. same-origin ws(s)://<host>/ws     (default: talk to the page's host)
(function () {
  const STORAGE_KEY = 'maze.serverUrl';
  const listeners = {};

  function on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach((cb) => cb(data));
  }

  function resolveServerUrl() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('server');
    if (override) {
      try {
        localStorage.setItem(STORAGE_KEY, override);
      } catch {}
      return override;
    }
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return stored;
    } catch {}
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    return `${scheme}//${host}/ws`;
  }

  function setServerUrl(url) {
    try {
      if (url) localStorage.setItem(STORAGE_KEY, url);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  let ws = null;
  let connected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let currentUrl = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(15000, 500 * Math.pow(2, reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(url) {
    if (url) currentUrl = url;
    if (!currentUrl) currentUrl = resolveServerUrl();

    emit('status', { connected: false, url: currentUrl, connecting: true });

    try {
      ws = new WebSocket(currentUrl);
    } catch (err) {
      console.error('WebSocket init failed', err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      connected = true;
      reconnectAttempts = 0;
      emit('status', { connected: true, url: currentUrl });
    });

    ws.addEventListener('close', () => {
      connected = false;
      emit('status', { connected: false, url: currentUrl });
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Browser fires close after error; let that handler reconnect.
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || !msg.type) return;
      emit(msg.type, msg);
    });
  }

  function sendMove(dir) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'move', dir }));
  }

  function sendFire() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'fire' }));
  }

  function switchServer(url) {
    setServerUrl(url);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    currentUrl = url || resolveServerUrl();
    connect(currentUrl);
  }

  window.Net = {
    connect,
    on,
    sendMove,
    sendFire,
    switchServer,
    getServerUrl: () => currentUrl,
    resolveServerUrl,
  };
})();
