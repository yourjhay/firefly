// Plain WebSocket client with auto-reconnect and a tiny event bus.
// After connect, the client must complete a session handshake:
//   { type: 'createSession' } or { type: 'joinSession', code: 'FL1234' }
//
// Server URL resolution (first match wins):
//   1. ?server=ws://host[:port][/path]   (URL override, remembered in localStorage)
//   2. localStorage "maze.serverUrl"
//   3. same-origin ws(s)://<host>/ws     (default)
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
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let currentUrl = null;
  /** @type {null | 'create' | { type: 'join', code: string }} */
  let pendingIntent = null;
  let resumeRoomCode = null;
  let suppressReconnect = false;

  function clearSessionState() {
    pendingIntent = null;
    resumeRoomCode = null;
  }

  function setResumeRoomCode(code) {
    resumeRoomCode = code || null;
  }

  function scheduleReconnect() {
    if (reconnectTimer || suppressReconnect) return;
    const delay = Math.min(15000, 500 * Math.pow(2, reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function tryHandshake() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pendingIntent === 'create') {
      ws.send(JSON.stringify({ type: 'createSession' }));
      pendingIntent = null;
      return;
    }
    if (pendingIntent && pendingIntent.type === 'join') {
      ws.send(JSON.stringify({ type: 'joinSession', code: pendingIntent.code }));
      pendingIntent = null;
      return;
    }
    if (resumeRoomCode) {
      ws.send(JSON.stringify({ type: 'joinSession', code: resumeRoomCode }));
    }
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
      reconnectAttempts = 0;
      emit('status', { connected: true, url: currentUrl });
      tryHandshake();
    });

    ws.addEventListener('close', () => {
      emit('status', { connected: false, url: currentUrl });
      if (suppressReconnect) {
        suppressReconnect = false;
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Browser fires close after error.
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

  function beginCreateSession() {
    pendingIntent = 'create';
    suppressReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    connect(currentUrl || resolveServerUrl());
  }

  function beginJoinSession(code) {
    pendingIntent = { type: 'join', code };
    suppressReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    connect(currentUrl || resolveServerUrl());
  }

  function leaveSession() {
    suppressReconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    clearSessionState();
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    emit('status', { connected: false, url: currentUrl || resolveServerUrl(), left: true });
  }

  function switchServer(url) {
    setServerUrl(url);
    leaveSession();
    currentUrl = url || resolveServerUrl();
    emit('status', { connected: false, url: currentUrl });
  }

  window.Net = {
    connect,
    on,
    sendMove,
    sendFire,
    beginCreateSession,
    beginJoinSession,
    leaveSession,
    clearSessionState,
    setResumeRoomCode,
    switchServer,
    getServerUrl: () => currentUrl,
    resolveServerUrl,
  };
})();
