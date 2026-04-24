const { generateMaze } = require('./mazeGenerator');

const PLAYER_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1',
  '#22d3ee', '#e11d48',
];

/** Max players in one room (host + guests). */
const MAX_PLAYERS_PER_ROOM = 13;

const MOVE_COOLDOWN_MS = 70;
/** Ghost grid step delay when no player is in line-of-sight (patrol). */
const GHOST_MOVE_COOLDOWN_PATROL_MS = 400;
/** Ghost grid step delay when at least one living player is visible (chase). */
const GHOST_MOVE_COOLDOWN_CHASE_MS = 300;
const GHOST_TICK_MS = 35;
const GHOST_HP_MAX = 2;
const GHOST_BULLET_DAMAGE = 1;
const RESET_DELAY_MS = 5000;

const WALL_HP_DEFAULT = 5;
const BULLET_DAMAGE = 0.5;
const FIRE_COOLDOWN_MS = 280;
const BULLET_MAX_RANGE = 40;

// Firing budget (per round, per player):
//   - Start with BURST_CAPACITY_MS_BASE of burst time and the
//     OVERHEAT_LOCKOUT_MS_BASE lockout after a full burst.
//   - Every subsequent overheat within the same round:
//       next lockout   += OVERHEAT_LOCKOUT_STEP_MS   (10s → 15s → 20s → …)
//       next opportunity -= BURST_CAPACITY_STEP_MS   (2s  → 1.5s → 1s  → …)
//   - Once the opportunity hits 0 the player is "depleted" and cannot fire
//     for the rest of the round. Everything resets on newMaze().
//   - Between shots, the burst regenerates at 0.2 ms/ms of idle time so
//     intermittent firing doesn't overheat.
const BURST_CAPACITY_MS_BASE = 2000;
const BURST_CAPACITY_STEP_MS = 500;
const OVERHEAT_LOCKOUT_MS_BASE = 10000;
const OVERHEAT_LOCKOUT_STEP_MS = 5000;
const BURST_RECOVERY_RATE = BURST_CAPACITY_MS_BASE / OVERHEAT_LOCKOUT_MS_BASE; // 0.2 ms/ms

const DIR_DELTAS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const DIR_ORDER = ['up', 'right', 'down', 'left'];

function dirFromDelta(dx, dy) {
  if (dy === -1) return 'up';
  if (dy === 1) return 'down';
  if (dx === -1) return 'left';
  return 'right';
}

/** Axis-aligned clear line of sight on path cells (no walls strictly between). */
function axisAlignedLos(grid, ax, ay, bx, by) {
  if (grid[ay]?.[ax] === 1 || grid[by]?.[bx] === 1) return false;
  if (ax === bx) {
    if (ay === by) return true;
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    for (let y = y0 + 1; y < y1; y++) {
      if (grid[y][ax] === 1) return false;
    }
    return true;
  }
  if (ay === by) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    for (let x = x0 + 1; x < x1; x++) {
      if (grid[ay][x] === 1) return false;
    }
    return true;
  }
  return false;
}

/** BFS distances from (sx,sy) to all reachable path cells; unwalkable = -1. */
function bfsDistances(grid, width, height, sx, sy) {
  const dist = Array.from({ length: height }, () => Array(width).fill(-1));
  if (grid[sy][sx] === 1) return dist;
  const q = [[sx, sy]];
  dist[sy][sx] = 0;
  let qi = 0;
  while (qi < q.length) {
    const [x, y] = q[qi++];
    const d = dist[y][x];
    for (const dir of DIR_ORDER) {
      const [dx, dy] = DIR_DELTAS[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (grid[ny][nx] === 1) continue;
      if (dist[ny][nx] !== -1) continue;
      dist[ny][nx] = d + 1;
      q.push([nx, ny]);
    }
  }
  return dist;
}

class GameManager {
  // broadcast(msg, exceptId?) is the transport hook. Caller fans the JSON
  // payload out to every connected client (optionally skipping one).
  constructor({ broadcast, cols = 16, rows = 16 } = {}) {
    this.broadcast = broadcast || (() => {});
    this.cols = cols;
    this.rows = rows;
    this.players = new Map();
    this.state = 'playing';
    this.winnerId = null;
    this.colorIndex = 0;
    this.roundId = 0;
    this._resetTimer = null;
    /** When true, next `reset()` sets round counter so `newMaze` yields round 1. */
    this._resetAllEliminated = false;
    this.ghosts = new Map();
    this._ghostIdSeq = 0;
    this._ghostTickTimer = setInterval(() => this._tickGhosts(), GHOST_TICK_MS);
    this.newMaze();
  }

  newMaze() {
    this.maze = generateMaze(this.cols, this.rows);
    this.wallHp = this._buildWallHp();
    this.state = 'playing';
    this.winnerId = null;
    this.roundId += 1;
    for (const p of this.players.values()) {
      p.eliminated = false;
      p.x = this.maze.start.x;
      p.y = this.maze.start.y;
      p.facing = 'right';
      p.lastMoveAt = 0;
      p.lastFireAt = 0;
      p.burstUsedMs = 0;
      p.overheated = false;
      p.overheatedUntil = 0;
      p.nextBurstCapacityMs = BURST_CAPACITY_MS_BASE;
      p.nextLockoutMs = OVERHEAT_LOCKOUT_MS_BASE;
      p.appliedLockoutMs = OVERHEAT_LOCKOUT_MS_BASE;
      p.depleted = false;
      if (p._overheatTimer) {
        clearTimeout(p._overheatTimer);
        p._overheatTimer = null;
      }
    }
    for (const gid of this.ghosts.keys()) {
      this.ghosts.delete(gid);
      this.broadcast({ type: 'ghostRemoved', id: gid });
    }
    this.syncGhosts();
  }

  // 2D array mirroring the maze grid. Path tiles have 0 HP (not applicable),
  // outer-border walls are Infinity (indestructible), everything else starts
  // with WALL_HP_DEFAULT.
  _buildWallHp() {
    const { grid, width, height } = this.maze;
    const hp = Array.from({ length: height }, () => Array(width).fill(0));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === 0) continue;
        const border = x === 0 || x === width - 1 || y === 0 || y === height - 1;
        hp[y][x] = border ? Infinity : WALL_HP_DEFAULT;
      }
    }
    return hp;
  }

  // JSON-friendly grid for snapshots: 0 = path, -1 = indestructible border, >0 = remaining HP.
  _serializeWallHp() {
    const { grid, width, height } = this.maze;
    const out = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === 0) {
          row.push(0);
        } else {
          const h = this.wallHp[y][x];
          row.push(h === Infinity ? -1 : h);
        }
      }
      out.push(row);
    }
    return out;
  }

  nextColor() {
    const c = PLAYER_COLORS[this.colorIndex % PLAYER_COLORS.length];
    this.colorIndex += 1;
    return c;
  }

  _livingPlayerCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.eliminated) n += 1;
    }
    return n;
  }

  desiredGhostCount() {
    return Math.ceil(this._livingPlayerCount() / 3);
  }

  _collectPathCells(excludeKeys) {
    const { grid, width, height, start, goal } = this.maze;
    const cells = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] !== 0) continue;
        const k = `${x},${y}`;
        if (excludeKeys.has(k)) continue;
        if (x === start.x && y === start.y) continue;
        if (x === goal.x && y === goal.y) continue;
        cells.push([x, y]);
      }
    }
    return cells;
  }

  _nextGhostId() {
    const id = `g${this._ghostIdSeq}`;
    this._ghostIdSeq += 1;
    return id;
  }

  syncGhosts() {
    const want = this.desiredGhostCount();
    const exclude = new Set();

    for (const p of this.players.values()) {
      exclude.add(`${p.x},${p.y}`);
    }
    for (const g of this.ghosts.values()) {
      exclude.add(`${g.x},${g.y}`);
    }

    while (this.ghosts.size > want) {
      const ids = [...this.ghosts.keys()];
      const rid = ids[ids.length - 1];
      this.ghosts.delete(rid);
      this.broadcast({ type: 'ghostRemoved', id: rid });
    }

    const pool = this._collectPathCells(exclude);
    while (this.ghosts.size < want && pool.length > 0) {
      const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const [x, y] = pick;
      exclude.add(`${x},${y}`);
      const id = this._nextGhostId();
      const ghost = {
        id,
        x,
        y,
        facing: 'right',
        hp: GHOST_HP_MAX,
        lastMoveAt: 0,
        prevX: x,
        prevY: y,
      };
      this.ghosts.set(id, ghost);
      this.broadcast({ type: 'ghostSpawned', ghost: serializeGhost(ghost) });
    }

    // Fallback for tiny mazes: still must not overlap players or other ghosts.
    while (this.ghosts.size < want) {
      const ex = new Set();
      for (const p of this.players.values()) {
        ex.add(`${p.x},${p.y}`);
      }
      for (const g of this.ghosts.values()) {
        ex.add(`${g.x},${g.y}`);
      }
      const wide = this._collectPathCells(ex);
      if (!wide.length) break;
      const [x, y] = wide[Math.floor(Math.random() * wide.length)];
      ex.add(`${x},${y}`);
      const id = this._nextGhostId();
      const ghost = {
        id,
        x,
        y,
        facing: 'right',
        hp: GHOST_HP_MAX,
        lastMoveAt: 0,
        prevX: x,
        prevY: y,
      };
      this.ghosts.set(id, ghost);
      this.broadcast({ type: 'ghostSpawned', ghost: serializeGhost(ghost) });
    }
  }

  addPlayer(id) {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) return null;
    const player = {
      id,
      name: id.slice(0, 4).toUpperCase(),
      color: this.nextColor(),
      x: this.maze.start.x,
      y: this.maze.start.y,
      facing: 'right',
      lastMoveAt: 0,
      lastFireAt: 0,
      burstUsedMs: 0,
      overheated: false,
      overheatedUntil: 0,
      nextBurstCapacityMs: BURST_CAPACITY_MS_BASE,
      nextLockoutMs: OVERHEAT_LOCKOUT_MS_BASE,
      appliedLockoutMs: OVERHEAT_LOCKOUT_MS_BASE,
      depleted: false,
      eliminated: false,
      _overheatTimer: null,
    };
    this.players.set(id, player);
    this.syncGhosts();
    this.broadcast(
      {
        type: 'playerJoined',
        player: serializePlayer(player),
      },
      id
    );
    return player;
  }

  removePlayer(id) {
    if (!this.players.delete(id)) return;
    this.broadcast({ type: 'playerLeft', id });

    // No one's left to play — wipe round history so the next player
    // starts fresh on Round 1 with a brand new maze.
    if (this.players.size === 0) {
      if (this._ghostTickTimer) {
        clearInterval(this._ghostTickTimer);
        this._ghostTickTimer = null;
      }
      if (this._resetTimer) {
        clearTimeout(this._resetTimer);
        this._resetTimer = null;
      }
      this.roundId = 0;
      this.colorIndex = 0;
      this.state = 'playing';
      this.winnerId = null;
      this.newMaze();
      this._ghostTickTimer = setInterval(() => this._tickGhosts(), GHOST_TICK_MS);
    } else {
      this.syncGhosts();
    }
  }

  snapshot() {
    return {
      maze: this.maze,
      wallHp: this._serializeWallHp(),
      players: Array.from(this.players.values()).map(serializePlayer),
      state: this.state,
      winnerId: this.winnerId,
      roundId: this.roundId,
      fire: {
        burstCapacityBaseMs: BURST_CAPACITY_MS_BASE,
        burstCapacityStepMs: BURST_CAPACITY_STEP_MS,
        lockoutBaseMs: OVERHEAT_LOCKOUT_MS_BASE,
        lockoutStepMs: OVERHEAT_LOCKOUT_STEP_MS,
        serverTime: Date.now(),
      },
      ghosts: Array.from(this.ghosts.values()).map(serializeGhost),
    };
  }

  move(id, dir) {
    if (this.state !== 'playing') return;
    const p = this.players.get(id);
    if (!p || p.eliminated) return;
    const delta = DIR_DELTAS[dir];
    if (!delta) return;

    // Facing updates even if the move is blocked, so players can aim by
    // pressing a direction against a wall.
    if (p.facing !== dir) {
      p.facing = dir;
      this.broadcast({ type: 'playerFaced', id, facing: dir });
    }

    const now = Date.now();
    if (now - p.lastMoveAt < MOVE_COOLDOWN_MS) return;

    const nx = p.x + delta[0];
    const ny = p.y + delta[1];
    if (nx < 0 || nx >= this.maze.width || ny < 0 || ny >= this.maze.height) return;
    if (this.maze.grid[ny][nx] === 1) return;

    p.x = nx;
    p.y = ny;
    p.lastMoveAt = now;

    this.broadcast({ type: 'playerMoved', id, x: nx, y: ny, facing: p.facing });

    this._checkGhostPlayerCollision();

    if (nx === this.maze.goal.x && ny === this.maze.goal.y) {
      this.state = 'finished';
      this.winnerId = id;
      this.broadcast({
        type: 'gameOver',
        winnerId: id,
        winner: serializePlayer(p),
        resetInMs: RESET_DELAY_MS,
      });
      if (this._resetTimer) clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => this.reset(), RESET_DELAY_MS);
    }
  }

  fire(id) {
    if (this.state !== 'playing') return;
    const p = this.players.get(id);
    if (!p || p.eliminated) return;
    const now = Date.now();

    // Out of opportunity for this round — nothing to do.
    if (p.depleted) return;

    // Overheated? If lockout already elapsed, recover; otherwise deny.
    if (p.overheated) {
      if (now >= p.overheatedUntil) {
        this._endOverheat(p);
      } else {
        return;
      }
    }

    // Regenerate burst budget only for idle time beyond the shot cooldown,
    // so rapid-fire bursts don't silently refill mid-burst. Breaks longer
    // than FIRE_COOLDOWN_MS contribute toward recovery at 0.2 ms/ms.
    const sinceLastShot = Math.max(0, now - (p.lastFireAt || 0));
    const idleMs = Math.max(0, sinceLastShot - FIRE_COOLDOWN_MS);
    if (idleMs > 0) {
      p.burstUsedMs = Math.max(0, p.burstUsedMs - idleMs * BURST_RECOVERY_RATE);
    }

    // Short cooldown between individual shots.
    if (now - p.lastFireAt < FIRE_COOLDOWN_MS) return;

    // Not enough budget left for another shot — trip the overheat instead.
    // Both the NEXT lockout and the NEXT opportunity escalate per trigger.
    if (p.burstUsedMs + FIRE_COOLDOWN_MS > p.nextBurstCapacityMs) {
      const appliedLockout = p.nextLockoutMs;
      p.appliedLockoutMs = appliedLockout;
      p.burstUsedMs = p.nextBurstCapacityMs;
      p.overheated = true;
      p.overheatedUntil = now + appliedLockout;

      // Escalate for the next cycle.
      p.nextLockoutMs = appliedLockout + OVERHEAT_LOCKOUT_STEP_MS;
      p.nextBurstCapacityMs = Math.max(
        0,
        p.nextBurstCapacityMs - BURST_CAPACITY_STEP_MS
      );
      if (p.nextBurstCapacityMs <= 0) {
        p.nextBurstCapacityMs = 0;
        p.depleted = true;
      }

      if (p._overheatTimer) clearTimeout(p._overheatTimer);
      p._overheatTimer = setTimeout(() => {
        if (!this.players.has(p.id)) return;
        this._endOverheat(p);
        this.broadcast(this._fireStateMessage(p));
      }, appliedLockout);
      this.broadcast(this._fireStateMessage(p));
      return;
    }

    p.lastFireAt = now;
    p.burstUsedMs += FIRE_COOLDOWN_MS;
    this.broadcast(this._fireStateMessage(p));

    const delta = DIR_DELTAS[p.facing || 'right'];
    const [dx, dy] = delta;

    let cx = p.x;
    let cy = p.y;
    let hit = { x: cx, y: cy };
    let hitKind = 'maxRange';
    let destroyed = false;
    let wallHpAfter;

    for (let step = 0; step < BULLET_MAX_RANGE; step++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= this.maze.width || ny < 0 || ny >= this.maze.height) {
        hit = { x: cx, y: cy };
        hitKind = 'border';
        break;
      }
      const ghostHit = this._ghostAt(nx, ny);
      if (ghostHit) {
        ghostHit.hp -= GHOST_BULLET_DAMAGE;
        hit = { x: nx, y: ny };
        hitKind = 'ghost';
        const dead = ghostHit.hp <= 0;
        if (dead) this.ghosts.delete(ghostHit.id);
        const bulletMsg = {
          type: 'bullet',
          shooterId: id,
          color: p.color,
          from: { x: p.x, y: p.y },
          to: hit,
          dir: p.facing,
          hitKind: 'ghost',
          ghostId: ghostHit.id,
          ghostHpAfter: dead ? 0 : ghostHit.hp,
          destroyed: dead,
        };
        this.broadcast(bulletMsg);
        return;
      }
      if (this.maze.grid[ny][nx] === 1) {
        hit = { x: nx, y: ny };
        const currentHp = this.wallHp[ny][nx];
        if (currentHp === Infinity) {
          hitKind = 'border';
        } else {
          const newHp = currentHp - BULLET_DAMAGE;
          if (newHp <= 0) {
            this.maze.grid[ny][nx] = 0;
            this.wallHp[ny][nx] = 0;
            destroyed = true;
            wallHpAfter = 0;
          } else {
            this.wallHp[ny][nx] = newHp;
            wallHpAfter = newHp;
          }
          hitKind = 'wall';
        }
        break;
      }
      cx = nx;
      cy = ny;
      hit = { x: cx, y: cy };
    }

    const bulletMsg = {
      type: 'bullet',
      shooterId: id,
      color: p.color,
      from: { x: p.x, y: p.y },
      to: hit,
      dir: p.facing,
      hitKind,
      destroyed,
    };
    if (hitKind === 'wall' && wallHpAfter !== undefined) {
      bulletMsg.wallHpAfter = wallHpAfter;
    }
    this.broadcast(bulletMsg);
  }

  reset() {
    this._resetTimer = null;
    if (this._resetAllEliminated) {
      this.roundId = 0;
      this._resetAllEliminated = false;
    }
    this.newMaze();
    this.broadcast({ type: 'newRound', ...this.snapshot() });
  }

  _endOverheat(p) {
    p.overheated = false;
    p.overheatedUntil = 0;
    p.burstUsedMs = 0;
    if (p._overheatTimer) {
      clearTimeout(p._overheatTimer);
      p._overheatTimer = null;
    }
  }

  _fireStateMessage(p) {
    return {
      type: 'fireState',
      id: p.id,
      overheated: p.overheated,
      overheatedUntil: p.overheated ? p.overheatedUntil : 0,
      burstUsedMs: p.burstUsedMs,
      nextBurstCapacityMs: p.nextBurstCapacityMs, // opportunity for the next burst
      appliedLockoutMs: p.appliedLockoutMs,       // lockout that is currently in effect
      nextLockoutMs: p.nextLockoutMs,             // lockout the next overheat will use
      depleted: !!p.depleted,
      serverTime: Date.now(),
    };
  }

  _ghostAt(x, y) {
    for (const g of this.ghosts.values()) {
      if (g.x === x && g.y === y) return g;
    }
    return null;
  }

  _checkGhostPlayerCollision() {
    const victims = new Set();
    for (const g of this.ghosts.values()) {
      for (const p of this.players.values()) {
        if (p.eliminated) continue;
        if (p.x === g.x && p.y === g.y) victims.add(p);
      }
    }
    let any = false;
    for (const p of victims) {
      if (!p.eliminated) {
        p.eliminated = true;
        this.broadcast({ type: 'playerEliminated', id: p.id });
        any = true;
      }
    }
    if (any) this.syncGhosts();
    this._maybeEndRoundAllEliminated();
  }

  _maybeEndRoundAllEliminated() {
    if (this.state !== 'playing') return;
    if (this.players.size === 0) return;
    for (const p of this.players.values()) {
      if (!p.eliminated) return;
    }
    this._resetAllEliminated = true;
    this.state = 'finished';
    this.winnerId = null;
    this.broadcast({
      type: 'gameOver',
      winnerId: null,
      winner: null,
      reason: 'allEliminated',
      resetInMs: RESET_DELAY_MS,
    });
    if (this._resetTimer) clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => this.reset(), RESET_DELAY_MS);
  }

  _tickGhosts() {
    if (this.state !== 'playing' || this.ghosts.size === 0) return;
    this._checkGhostPlayerCollision();
    if (this.state !== 'playing') return;
    const now = Date.now();
    const { grid, width, height } = this.maze;

    // Snapshot so syncGhosts / collision never mutates the Map mid-iteration.
    const ghostsList = [...this.ghosts.values()];

    for (const g of ghostsList) {
      if (!this.ghosts.has(g.id)) continue;

      const targets = [];
      for (const p of this.players.values()) {
        if (p.eliminated) continue;
        if (!axisAlignedLos(grid, g.x, g.y, p.x, p.y)) continue;
        targets.push(p);
      }

      const chasing = targets.length > 0;
      const moveCooldownMs = chasing
        ? GHOST_MOVE_COOLDOWN_CHASE_MS
        : GHOST_MOVE_COOLDOWN_PATROL_MS;
      if (now - g.lastMoveAt < moveCooldownMs) continue;

      let nx = g.x;
      let ny = g.y;
      let moved = false;

      if (targets.length) {
        const distFromGhost = bfsDistances(grid, width, height, g.x, g.y);
        let best = null;
        let bestD = Infinity;
        for (const p of targets) {
          const d = distFromGhost[p.y][p.x];
          if (d < 0) continue;
          if (d < bestD || (d === bestD && (!best || p.id < best.id))) {
            bestD = d;
            best = p;
          }
        }
        if (best && bestD > 0) {
          const distT = bfsDistances(grid, width, height, best.x, best.y);
          const dHere = distT[g.y][g.x];
          let pick = null;
          let pickRank = Infinity;
          if (dHere >= 0) {
            let pickDirIdx = Infinity;
            for (const dir of DIR_ORDER) {
              const [dx, dy] = DIR_DELTAS[dir];
              const tx = g.x + dx;
              const ty = g.y + dy;
              if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
              if (grid[ty][tx] === 1) continue;
              const dn = distT[ty][tx];
              if (dn < 0) continue;
              const dirIdx = DIR_ORDER.indexOf(dir);
              if (
                dn < dHere &&
                (pick == null || dn < pickRank || (dn === pickRank && dirIdx < pickDirIdx))
              ) {
                pickRank = dn;
                pickDirIdx = dirIdx;
                pick = { tx, ty, dir };
              }
            }
          }
          if (pick) {
            nx = pick.tx;
            ny = pick.ty;
            g.facing = pick.dir;
            moved = true;
          }
        }
      }

      if (!moved) {
        const opts = [];
        for (const dir of DIR_ORDER) {
          const [dx, dy] = DIR_DELTAS[dir];
          const tx = g.x + dx;
          const ty = g.y + dy;
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          if (grid[ty][tx] === 1) continue;
          if (tx === g.prevX && ty === g.prevY) continue;
          opts.push({ tx, ty, dir });
        }
        if (!opts.length) {
          for (const dir of DIR_ORDER) {
            const [dx, dy] = DIR_DELTAS[dir];
            const tx = g.x + dx;
            const ty = g.y + dy;
            if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
            if (grid[ty][tx] === 1) continue;
            opts.push({ tx, ty, dir });
          }
        }
        if (opts.length) {
          const pick = opts[Math.floor(Math.random() * opts.length)];
          nx = pick.tx;
          ny = pick.ty;
          g.facing = pick.dir;
          moved = true;
        }
      }

      g.lastMoveAt = now;
      if (moved) {
        g.prevX = g.x;
        g.prevY = g.y;
        g.x = nx;
        g.y = ny;
        this.broadcast({
          type: 'ghostMoved',
          id: g.id,
          x: g.x,
          y: g.y,
          facing: g.facing,
        });
        this._checkGhostPlayerCollision();
        if (this.state !== 'playing') return;
      }
    }
  }
}

function serializeGhost(g) {
  return {
    id: g.id,
    x: g.x,
    y: g.y,
    facing: g.facing || 'right',
    hp: g.hp,
  };
}

function serializePlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    x: p.x,
    y: p.y,
    facing: p.facing || 'right',
    overheated: !!p.overheated,
    overheatedUntil: p.overheated ? p.overheatedUntil : 0,
    nextBurstCapacityMs: p.nextBurstCapacityMs ?? BURST_CAPACITY_MS_BASE,
    nextLockoutMs: p.nextLockoutMs ?? OVERHEAT_LOCKOUT_MS_BASE,
    depleted: !!p.depleted,
    eliminated: !!p.eliminated,
  };
}

module.exports = { GameManager, MAX_PLAYERS_PER_ROOM };
