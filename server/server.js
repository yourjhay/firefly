const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SessionManager } = require('./sessionManager');

const PORT = parseInt(process.env.PORT || '3000', 10);
const COLS = parseInt(process.env.MAZE_COLS || '10', 10);
const ROWS = parseInt(process.env.MAZE_ROWS || '10', 10);
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

const sessionManager = new SessionManager({ cols: COLS, rows: ROWS });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendInit(ws, code, player, game) {
  send(ws, { type: 'sessionCreated', code });
  send(ws, {
    type: 'init',
    roomCode: code,
    you: { id: player.id, name: player.name, color: player.color },
    ...game.snapshot(),
  });
}

function sendInitJoin(ws, code, player, game) {
  send(ws, { type: 'sessionJoined', code });
  send(ws, {
    type: 'init',
    roomCode: code,
    you: { id: player.id, name: player.name, color: player.color },
    ...game.snapshot(),
  });
}

function attachSession(ws, code, playerId, game) {
  ws.sessionCode = code;
  ws.playerId = playerId;
  ws.game = game;
  sessionManager.registerSocket(code, playerId, ws);
}

function detachSession(ws) {
  const code = ws.sessionCode;
  const playerId = ws.playerId;
  const game = ws.game;
  if (!code || !playerId || !game) return;
  sessionManager.unregisterSocket(code, playerId);
  game.removePlayer(playerId);
  sessionManager.destroySessionIfEmpty(code);
  ws.sessionCode = null;
  ws.playerId = null;
  ws.game = null;
}

wss.on('connection', (ws, req) => {
  const playerId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  ws.playerId = playerId;
  ws.sessionCode = null;
  ws.game = null;

  console.log(`[ws] client ${playerId} connected from ${req.socket.remoteAddress}`);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'createSession': {
        if (ws.sessionCode) {
          send(ws, { type: 'sessionError', code: 'ALREADY_IN_SESSION' });
          return;
        }
        const { code, game } = sessionManager.createSession();
        attachSession(ws, code, playerId, game);
        const player = game.addPlayer(playerId);
        console.log(`[+] ${player.name} hosted ${code} (${game.players.size} in room)`);
        sendInit(ws, code, player, game);
        break;
      }
      case 'joinSession': {
        if (ws.sessionCode) {
          send(ws, { type: 'sessionError', code: 'ALREADY_IN_SESSION' });
          return;
        }
        const raw = typeof msg.code === 'string' ? msg.code : '';
        const normalized = sessionManager.normalizeCode(raw);
        if (!sessionManager.isValidCodeFormat(normalized)) {
          send(ws, { type: 'sessionError', code: 'BAD_REQUEST' });
          return;
        }
        const game = sessionManager.getGameForJoin(normalized);
        if (!game) {
          send(ws, { type: 'sessionError', code: 'NOT_FOUND' });
          return;
        }
        attachSession(ws, normalized, playerId, game);
        const player = game.addPlayer(playerId);
        console.log(
          `[+] ${player.name} joined ${normalized} (${game.players.size} in room)`
        );
        sendInitJoin(ws, normalized, player, game);
        break;
      }
      case 'move':
        if (!ws.sessionCode || !ws.game) {
          send(ws, { type: 'sessionError', code: 'NOT_IN_SESSION' });
          return;
        }
        if (typeof msg.dir === 'string') ws.game.move(playerId, msg.dir);
        break;
      case 'fire':
        if (!ws.sessionCode || !ws.game) {
          send(ws, { type: 'sessionError', code: 'NOT_IN_SESSION' });
          return;
        }
        ws.game.fire(playerId);
        break;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws.sessionCode && ws.game) {
      const name = ws.game.players.get(ws.playerId)?.name || ws.playerId;
      detachSession(ws);
      console.log(`[-] ${name} left`);
    }
  });

  ws.on('error', () => {
    // `close` runs after this.
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      // ignore
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Maze race server listening at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}${WS_PATH}`);
});
