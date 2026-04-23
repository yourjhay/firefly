# Maze Race

A browser-based multiplayer maze racing game. A new random maze is generated every round; the first player to reach the gold tile wins, and a new round starts automatically.

![Maze Race promo art — fireflies](fireflies_promo.png)

- **Rendering:** [Kaboom.js](https://kaboomjs.com/) (loaded from a CDN)
- **Server:** Node.js + Express + plain [`ws`](https://github.com/websockets/ws) WebSockets
- **Maze:** Recursive backtracking (DFS), server-authoritative
- **Controls:** WASD / arrow keys on desktop, on-screen D-pad on touch devices; **Space** or the on-screen **●** button to fire

## Game mechanics

### Objective

Each round uses a **new random maze**. Spawn at the start tile; **first player to step on the gold goal tile** wins that round.

### Movement

- Moves are **one grid tile** at a time along corridors; **walls block** you.
- The server enforces a per-player **move cooldown** (~70 ms) so held keys do not spam the network.
- If you press into a **blocked** direction, you still **turn** to face that way (useful for aiming without walking).

### Shooting and walls

- Shots travel in your **current facing** (the last direction you pressed).
- **Inner** walls have **HP**; each hit removes a slice of health until the wall becomes **floor** you can walk through. **Outer border** walls cannot be destroyed.
- Shots have a **short cooldown** between them. Firing in long bursts spends a **burst budget**; when it runs out you **overheat** and must wait before you can shoot again. Repeated overheats in the same round **shorten** your next burst window and **lengthen** the lockout until you are **depleted** and cannot fire until the **next round**.

### Rounds and disconnects

- After a win, the server broadcasts **game over**, then starts a **new round** after a few seconds with a **fresh maze** and **reset positions** (fire limits reset too).
- When the **last** player in a **room** disconnects, that room is destroyed and its invite code is freed. The next host gets a new maze and a new code.

## Private rooms (invite codes)

There is **no global public lobby**. Each browser must either **Host game** (creates a room and shows a code like `FL1234`) or **Join game** with a friend’s code.

- Codes are **two letters + four digits** (A–Z, 0–9), case-insensitive when typing. Newly hosted codes never use **W, A, S, or D** as either letter (so they are not confused with movement keys); joining still accepts any valid pair if you type it manually.
- All WebSocket traffic for a room is isolated: movement, shots, and chat-style events only go to players in that room.
- Rooms live **in memory** on the Node process; restarting the server clears every room.

**Shareable link:** open the game with a query param so joiners skip typing (still uses your configured WebSocket server URL):

```
http://localhost:3000/?code=FL1234
```

You can combine with a custom server:

```
http://localhost:3000/?server=ws://example.com/ws&code=FL1234
```

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). In the first browser choose **Host game** and note the room code. In another browser (or device) choose **Join game** and enter that code.

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

After the WebSocket opens, the client must send exactly one of:

- `{ "type": "createSession" }` — create a new room; you become the first player.
- `{ "type": "joinSession", "code": "FL1234" }` — join an existing room (`code` normalized server-side).

Until one of these succeeds, the server will not send `init`. Unknown or malformed join codes receive `sessionError` (see below).

### Server → client

| `type`           | Fields                                                        | When                                                   |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `sessionCreated` | `code`                                                        | You hosted a room (sent just before `init`)            |
| `sessionJoined`  | `code`                                                        | You joined an existing room (sent just before `init`) |
| `sessionError`   | `code` — one of `NOT_FOUND`, `BAD_REQUEST`, `ALREADY_IN_SESSION`, `NOT_IN_SESSION` | Invalid join / bad state                               |
| `init`           | `roomCode`, `you`, `maze`, `players`, `state`, `winnerId`, `roundId`, … | After a successful create/join                         |
| `playerJoined` | `player: { id, name, color, x, y, facing, … }`                | Another client connected                               |
| `playerLeft`   | `id`                                                          | A client disconnected                                  |
| `playerFaced`  | `id`, `facing`                                                | Facing changed (including when a move was blocked)     |
| `playerMoved`  | `id`, `x`, `y`, `facing`                                      | After a valid move                                     |
| `bullet`       | `shooterId`, `color`, `from`, `to`, `dir`, `hitKind`, `destroyed`, `wallHpAfter?` | Shot ray result; `wallHpAfter` = inner-wall HP after hit when `hitKind` is `wall` |
| `fireState`    | `id`, `overheated`, `overheatedUntil`, `burstUsedMs`, `nextBurstCapacityMs`, `depleted`, … | Fire/overheat budget for a player              |
| `gameOver`     | `winnerId`, `winner`, `resetInMs`                             | A player reached the goal                              |
| `newRound`     | `maze`, `wallHp`, `players`, `state`, `roundId`, `fire`, …    | Fresh maze + reset positions (fired on round rollover) |

`wallHp` is a 2D array aligned with `maze.grid`: `0` = path, `-1` = indestructible border wall, `>0` = remaining HP for inner walls (for client damage visuals).

### Client → server

| `type`           | Fields        | Notes                                        |
| ---------------- | ------------- | -------------------------------------------- |
| `createSession`  | _(none)_      | Create a private room; server assigns `code` |
| `joinSession`    | `code` string | Join room `FL1234` style code               |
| `move`           | `dir`         | `"up" \| "down" \| "left" \| "right"` (only after `init`) |
| `fire`           | _(none)_      | Fire a bullet in the player’s current facing |
| `ping`           | `t` (number)  | Optional; echoed back in `pong` for latency  |

Movement is grid-based, one tile at a time. The server enforces a per-player ~70 ms cooldown so held inputs do not flood.

## File layout

```
server/
  server.js          Express + `ws` bootstrap, session handshake, routing
  sessionManager.js  Invite codes, per-room `GameManager` + socket fan-out
  gameManager.js     Players, state, move validation, win detection
  mazeGenerator.js   Recursive-backtracking maze
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
