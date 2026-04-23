# Maze Race

A browser-based multiplayer maze racing game. A new random maze is generated every round; the first player to reach the gold tile wins, and a new round starts automatically.

- **Rendering:** [Kaboom.js](https://kaboomjs.com/) (loaded from a CDN)
- **Server:** Node.js + Express + plain [`ws`](https://github.com/websockets/ws) WebSockets
- **Maze:** Recursive backtracking (DFS), server-authoritative
- **Controls:** WASD / arrow keys on desktop, on-screen D-pad on touch devices

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in one or more browsers to play.

### Play from another device on the same Wi-Fi

1. Find your machine's LAN IP (e.g. `192.168.1.42`).
2. Open `http://192.168.1.42:3000` on your phone's browser.

## Configuring the server URL

The client connects to `ws(s)://<page host>/ws` by default. You can override this without rebuilding:

- **Query string:** `http://localhost:3000/?server=ws://ws.rjhon.net/ws`
- **HUD button:** click **Server…** in the top-right to type a URL at runtime.
- **localStorage:** the chosen URL is remembered (key `maze.serverUrl`). Clear it by setting an empty value via the Server… prompt.

### Using `ws.rjhon.net`

Run the server on that host (any Node.js environment works — the process listens on HTTP + upgrades `/ws`), then point clients at it:

```
http://localhost:3000/?server=ws://ws.rjhon.net/ws
```

Both the page and the WebSocket can also just live on that host (open `http://ws.rjhon.net:<port>/` directly).

### Environment variables

| Var         | Default | Description                                           |
| ----------- | ------- | ----------------------------------------------------- |
| `PORT`      | `3000`  | HTTP + WS port                                        |
| `WS_PATH`   | `/ws`   | Path the WebSocket server is mounted at              |
| `MAZE_COLS` | `10`    | Maze cell columns (grid width is `2n+1` tiles)       |
| `MAZE_ROWS` | `10`    | Maze cell rows                                       |

Example:

```bash
PORT=8080 WS_PATH=/ws MAZE_COLS=15 MAZE_ROWS=15 npm start
```

## Protocol (plain JSON over WebSocket)

All messages are JSON objects with a `type` field.

### Server → client

| `type`         | Fields                                                        | When                                                   |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `init`         | `you`, `maze`, `players`, `state`, `winnerId`, `roundId`      | Sent once on connect                                   |
| `playerJoined` | `player: { id, name, color, x, y }`                           | Another client connected                               |
| `playerLeft`   | `id`                                                          | A client disconnected                                  |
| `playerMoved`  | `id`, `x`, `y`                                                | After a valid move                                     |
| `gameOver`     | `winnerId`, `winner`, `resetInMs`                             | A player reached the goal                              |
| `newRound`     | `maze`, `players`, `state`, `roundId`, …                      | Fresh maze + reset positions (fired on round rollover) |

### Client → server

| `type` | Fields       | Notes                                        |
| ------ | ------------ | -------------------------------------------- |
| `move` | `dir`        | `"up" \| "down" \| "left" \| "right"`        |
| `ping` | `t` (number) | Optional; echoed back in `pong` for latency  |

Movement is grid-based, one tile at a time. The server enforces a per-player ~70 ms cooldown so held inputs don't flood.

## File layout

```
server/
  server.js         Express + `ws` bootstrap, connection handling
  gameManager.js    Players, state, move validation, win detection
  mazeGenerator.js  Recursive-backtracking maze
client/
  index.html
  main.js           Wires network events to renderer + HUD
  network.js        Native WebSocket wrapper (reconnect + URL config)
  renderer.js       Kaboom scene: walls, goal, players, smoothing
  controls.js       Keyboard + touch D-pad
  styles.css
```

## License

MIT
