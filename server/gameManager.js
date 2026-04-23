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

// Firing budget: each player can fire for a total of BURST_CAPACITY_MS in a
// burst before overheating. Overheating locks them out for OVERHEAT_LOCKOUT_MS.
// Between shots, the burst slowly regenerates (BURST_CAPACITY_MS of budget
// over OVERHEAT_LOCKOUT_MS of idle time → full recovery in 10s).
const BURST_CAPACITY_MS = 2000;
const OVERHEAT_LOCKOUT_MS = 10000;
const BURST_RECOVERY_RATE = BURST_CAPACITY_MS / OVERHEAT_LOCKOUT_MS; // 0.2 ms/ms

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
      if (p._overheatTimer) {
        clearTimeout(p._overheatTimer);
        p._overheatTimer = null;
      }
    }
  }

  // 2D array mirroring the maze grid. Path tiles have 0 HP (not applicable),
  // outer-border walls are Infinity (indestructible), everything else starts
  // with WALL_HP_DEFAULT. Kept server-only — clients never see HP values.
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
      players: Array.from(this.players.values()).map(serializePlayer),
      state: this.state,
      winnerId: this.winnerId,
      roundId: this.roundId,
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
    if (now - (p.lastFireAt || 0) < FIRE_COOLDOWN_MS) return;
    p.lastFireAt = now;

    const delta = DIR_DELTAS[p.facing || 'right'];
    const [dx, dy] = delta;

    let cx = p.x;
    let cy = p.y;
    let hit = { x: cx, y: cy };
    let hitKind = 'maxRange';
    let destroyed = false;

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
          } else {
            this.wallHp[ny][nx] = newHp;
          }
          hitKind = 'wall';
        }
        break;
      }
      cx = nx;
      cy = ny;
      hit = { x: cx, y: cy };
    }

    this.broadcast({
      type: 'bullet',
      shooterId: id,
      color: p.color,
      from: { x: p.x, y: p.y },
      to: hit,
      dir: p.facing,
      hitKind,
      destroyed,
    });
  }

  reset() {
    this._resetTimer = null;
    this.newMaze();
    this.broadcast({ type: 'newRound', ...this.snapshot() });
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
  };
}

module.exports = { GameManager };
