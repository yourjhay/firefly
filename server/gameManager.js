const { generateMaze } = require('./mazeGenerator');

const PLAYER_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1',
  '#22d3ee', '#e11d48',
];

const MOVE_COOLDOWN_MS = 70;
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

class GameManager {
  // broadcast(msg, exceptId?) is the transport hook. Caller fans the JSON
  // payload out to every connected client (optionally skipping one).
  constructor({ broadcast, cols = 10, rows = 10 } = {}) {
    this.broadcast = broadcast || (() => {});
    this.cols = cols;
    this.rows = rows;
    this.players = new Map();
    this.state = 'playing';
    this.winnerId = null;
    this.colorIndex = 0;
    this.roundId = 0;
    this._resetTimer = null;
    this.newMaze();
  }

  newMaze() {
    this.maze = generateMaze(this.cols, this.rows);
    this.wallHp = this._buildWallHp();
    this.state = 'playing';
    this.winnerId = null;
    this.roundId += 1;
    for (const p of this.players.values()) {
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

  addPlayer(id) {
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
      _overheatTimer: null,
    };
    this.players.set(id, player);
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
      if (this._resetTimer) {
        clearTimeout(this._resetTimer);
        this._resetTimer = null;
      }
      this.roundId = 0;
      this.colorIndex = 0;
      this.state = 'playing';
      this.winnerId = null;
      this.newMaze();
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
    };
  }

  move(id, dir) {
    if (this.state !== 'playing') return;
    const p = this.players.get(id);
    if (!p) return;
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
    if (!p) return;
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
  };
}

module.exports = { GameManager };
