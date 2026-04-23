const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { GameManager } = require('./gameManager');

const PORT = parseInt(process.env.PORT || '3000', 10);
const COLS = parseInt(process.env.MAZE_COLS || '10', 10);
const ROWS = parseInt(process.env.MAZE_ROWS || '10', 10);
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

// id -> ws
const sockets = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const payload = JSON.stringify(msg);
  for (const [id, ws] of sockets) {
    if (id === exceptId) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const game = new GameManager({ broadcast, cols: COLS, rows: ROWS });

wss.on('connection', (ws, req) => {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  sockets.set(id, ws);
  const player = game.addPlayer(id);
  console.log(
    `[+] ${player.name} joined from ${req.socket.remoteAddress} (${game.players.size} total)`
  );

  send(ws, {
    type: 'init',
    you: { id: player.id, name: player.name, color: player.color },
    ...game.snapshot(),
  });

  // Heartbeat: drop dead clients so their player is removed from the maze.
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
      case 'move':
        if (typeof msg.dir === 'string') game.move(id, msg.dir);
        break;
      case 'fire':
        game.fire(id);
        break;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    sockets.delete(id);
    game.removePlayer(id);
    console.log(`[-] ${player.name} left (${game.players.size} total)`);
  });

  ws.on('error', () => {
    // `close` will run after this; nothing extra to do.
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
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
