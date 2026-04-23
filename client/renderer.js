// Kaboom-based renderer: draws walls, goal tile, and players. Smoothly lerps
// player sprites toward their authoritative server positions, and animates
// bullets + wall destruction as broadcast by the server.
(function () {
  const TILE = 32; // logical tile size (the canvas is CSS-scaled to fit)
  const lerp = (a, b, t) => a + (b - a) * t;

  // Match server/gameManager.js (for crack threshold after 3 hits).
  const WALL_HP_DEFAULT = 5;
  const BULLET_DAMAGE = 0.5;
  const CRACKS_AFTER_HITS = 3;

  const state = {
    k: null,
    mazeLayer: [],
    goal: null,
    playerEntities: new Map(),
    playerBarrels: new Map(), // playerId -> barrel entity
    wallEntities: new Map(),  // "x,y" -> wall entity
    wallCrackEntities: new Map(), // "x,y" -> array of crack child entities
    roundId: 0,
    fogTiles: new Map(),      // "x,y" -> fog entity
    visible: new Map(),       // "x,y" -> fog opacity; replaced each reveal step
    currentMaze: null,        // reference to the latest maze grid (for LOS reveal)
    selfId: null,
    tileSize: TILE,
    mazeWidth: 0,
    mazeHeight: 0,
  };

  const FACING_ANGLE = { right: 0, down: 90, left: 180, up: 270 };

  // Tuned to land initial visibility near 5% of the maze (see simulation).
  const FOG_VISION_RADIUS = 5; // LOS raycast reach (blocked by walls)
  const FOG_GLOW_RADIUS = 3;   // small halo that always reveals (ignores walls)
  const FOG_FEATHER = 1.75;    // width (in tiles) of the soft gradient at each radius edge

  function shouldShowWallCracks(hp) {
    if (hp == null || hp <= 0 || hp === -1) return false;
    return WALL_HP_DEFAULT - hp + 1e-6 >= CRACKS_AFTER_HITS * BULLET_DAMAGE;
  }

  function hash01(x, y, r, salt) {
    const n =
      Math.sin((x + 1) * 12.9898 + (y + 1) * 78.233 + (r + 1) * 19.123 + salt * 4.141) *
      43758.5453;
    return n - Math.floor(n);
  }

  function removeWallCrackAt(key) {
    const ents = state.wallCrackEntities.get(key);
    if (ents) {
      ents.forEach((e) => e.destroy());
      state.wallCrackEntities.delete(key);
    }
  }

  function setWallCrackVisual(x, y, hp) {
    const k = state.k;
    if (!k) return;
    const key = `${x},${y}`;
    removeWallCrackAt(key);
    if (!shouldShowWallCracks(hp)) return;

    const T = state.tileSize;
    const r = state.roundId;
    const lines = [];
    for (let i = 0; i < 3; i++) {
      const angDeg = (hash01(x, y, r, i * 3) - 0.5) * 150;
      const len = 7 + hash01(x, y, r, i * 3 + 1) * 12;
      const ox = hash01(x, y, r, i * 3 + 2) * (T - 6) + 3;
      const oy = hash01(x, y, r, i * 3 + 3) * (T - 6) + 3;
      lines.push(
        k.add([
          k.rect(2, len),
          k.pos(x * T + ox, y * T + oy),
          k.anchor('center'),
          k.rotate(angDeg),
          k.color(20, 22, 38),
          k.opacity(0.88),
          k.z(3),
          'wallCrack',
        ])
      );
    }
    state.wallCrackEntities.set(key, lines);
  }

  function init(selfId) {
    state.selfId = selfId;
  }

  function teardown() {
    const el = document.getElementById('game');
    if (el) el.innerHTML = '';
    state.k = null;
    state.goal = null;
    state.playerEntities.clear();
    state.playerBarrels.clear();
    state.wallEntities.clear();
    state.fogTiles.clear();
    state.visible = new Map();
    state.currentMaze = null;
    state.selfId = null;
    state.mazeWidth = 0;
    state.mazeHeight = 0;
  }

  function setupKaboomFor(maze) {
    state.mazeWidth = maze.width;
    state.mazeHeight = maze.height;
    const w = maze.width * TILE;
    const h = maze.height * TILE;

    const container = document.getElementById('game');
    // Remove any previously created Kaboom canvases (e.g. on re-init).
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    // eslint-disable-next-line no-undef
    const k = kaboom({
      canvas,
      width: w,
      height: h,
      background: [15, 16, 30],
      crisp: true,
      global: false,
    });

    state.k = k;
    state.tileSize = TILE;

    // Lerp player entities toward their target positions each frame.
    k.onUpdate(() => {
      state.playerEntities.forEach((ent) => {
        if (ent.targetX == null) return;
        ent.pos.x = lerp(ent.pos.x, ent.targetX, 0.3);
        ent.pos.y = lerp(ent.pos.y, ent.targetY, 0.3);
      });
    });
  }

  function buildMaze(maze, wallHp) {
    const k = state.k;
    if (!k) return;

    // Clear old entities.
    k.get('wallCrack').forEach((e) => e.destroy());
    state.wallCrackEntities.clear();
    k.get('wall').forEach((e) => e.destroy());
    k.get('path').forEach((e) => e.destroy());
    k.get('goal').forEach((e) => e.destroy());
    state.wallEntities.clear();

    const T = state.tileSize;

    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        // Always paint a path tile as the background so that when a wall is
        // later destroyed, the floor color is already there.
        k.add([
          k.rect(T, T),
          k.pos(x * T, y * T),
          k.color(22, 24, 44),
          'path',
        ]);
        if (maze.grid[y][x] === 1) {
          const wall = k.add([
            k.rect(T, T),
            k.pos(x * T, y * T),
            k.color(44, 46, 78),
            k.outline(1, k.rgb(28, 30, 54)),
            k.z(1),
            'wall',
            { gx: x, gy: y },
          ]);
          state.wallEntities.set(`${x},${y}`, wall);
          if (wallHp && wallHp[y] && wallHp[y][x] != null) {
            setWallCrackVisual(x, y, wallHp[y][x]);
          }
        }
      }
    }

    // Start marker (subtle).
    k.add([
      k.rect(T - 8, T - 8),
      k.pos(maze.start.x * T + 4, maze.start.y * T + 4),
      k.color(60, 80, 140),
      k.opacity(0.45),
      'path',
    ]);

    // Goal tile with a pulsing glow.
    const goal = k.add([
      k.rect(T - 6, T - 6),
      k.pos(maze.goal.x * T + 3, maze.goal.y * T + 3),
      k.color(247, 201, 72),
      k.outline(2, k.rgb(255, 230, 140)),
      k.z(2),
      'goal',
      { t: 0 },
    ]);
    goal.onUpdate(() => {
      goal.t += k.dt();
      const pulse = 0.7 + 0.3 * Math.sin(goal.t * 4);
      goal.color = k.rgb(247 * pulse, 201 * pulse, 72 * pulse);
    });

    buildFog(maze);
  }

  function buildFog(maze) {
    const k = state.k;
    if (!k) return;
    const T = state.tileSize;

    // Clear any previous fog state.
    k.get('fog').forEach((e) => e.destroy());
    state.fogTiles.clear();
    state.visible.clear();
    state.currentMaze = maze;

    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const fog = k.add([
          k.rect(T, T),
          k.pos(x * T, y * T),
          k.color(8, 9, 18),
          k.opacity(1),
          k.z(25),
          'fog',
          { gx: x, gy: y },
        ]);
        state.fogTiles.set(`${x},${y}`, fog);
      }
    }
  }

  // Compute the per-tile fog opacity (0 = fully lit, 1 = fully fogged) from the
  // player's current position. Tiles that aren't in the returned map should be
  // treated as fully fogged. Combines a small unconditional halo with a
  // line-of-sight raycast; both have a feathered edge so the visible area
  // fades smoothly into darkness instead of popping at a hard circle.
  function computeVisible(cx, cy) {
    const visible = new Map();
    const maze = state.currentMaze;
    if (!maze) return visible;
    const grid = maze.grid;
    const W = maze.width;
    const H = maze.height;

    // Maps a distance `d` in tiles to a fog opacity. Between `hard` (fully
    // lit) and `edge` (fully fogged) we linearly blend; inside `hard` it's
    // clear, outside `edge` it's fully fogged.
    function opacityAt(d, hard, edge) {
      if (d <= hard) return 0;
      if (d >= edge) return 1;
      return (d - hard) / (edge - hard);
    }

    // Mark a tile with its fog opacity, keeping the brighter (lower-opacity)
    // contribution when multiple passes overlap on the same tile.
    function mark(x, y, op) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      if (op >= 1) return;
      const key = `${x},${y}`;
      const cur = visible.get(key);
      if (cur === undefined || op < cur) visible.set(key, op);
    }

    // Halo (ignores walls) — feathered from FOG_GLOW_RADIUS outward.
    const gHard = Math.max(0, FOG_GLOW_RADIUS - FOG_FEATHER);
    const gEdge = FOG_GLOW_RADIUS + FOG_FEATHER;
    const gri = Math.ceil(gEdge);
    for (let dy = -gri; dy <= gri; dy++) {
      for (let dx = -gri; dx <= gri; dx++) {
        const d = Math.hypot(dx, dy);
        if (d >= gEdge) continue;
        mark(cx + dx, cy + dy, opacityAt(d, gHard, gEdge));
      }
    }

    // LOS raycasting — 360 rays, wall-occluded, out to the feathered edge.
    const vHard = Math.max(FOG_GLOW_RADIUS, FOG_VISION_RADIUS - FOG_FEATHER);
    const vEdge = FOG_VISION_RADIUS + FOG_FEATHER;
    for (let i = 0; i < 360; i++) {
      const a = (i / 360) * Math.PI * 2;
      const ddx = Math.cos(a);
      const ddy = Math.sin(a);
      let fx = cx + 0.5;
      let fy = cy + 0.5;
      let dist = 0;
      while (dist < vEdge) {
        fx += ddx * 0.25;
        fy += ddy * 0.25;
        dist += 0.25;
        const tx = Math.floor(fx);
        const ty = Math.floor(fy);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) break;
        const d = Math.hypot(tx - cx, ty - cy);
        if (d >= vEdge) break;
        mark(tx, ty, opacityAt(d, vHard, vEdge));
        if (grid[ty][tx] === 1) break;
      }
    }

    return visible;
  }

  // Light the tiles visible from (cx, cy) and re-fog everything else. Unlike
  // the old "persistent reveal" behavior, previously-seen-but-now-outside
  // tiles go dark again — the player only sees a traveling, feathered halo.
  function revealFrom(cx, cy) {
    const next = computeVisible(cx, cy);

    // Re-fog tiles that were lit last frame but aren't anymore.
    state.visible.forEach((_, key) => {
      if (!next.has(key)) {
        const fog = state.fogTiles.get(key);
        if (fog) fog.opacity = 1;
      }
    });

    // Apply new opacities for currently-lit tiles (includes feather band).
    next.forEach((op, key) => {
      const fog = state.fogTiles.get(key);
      if (fog) fog.opacity = op;
    });

    state.visible = next;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function addPlayer(p) {
    const k = state.k;
    if (!k) return;
    if (state.playerEntities.has(p.id)) {
      updatePlayerPosition(p.id, p.x, p.y, true);
      return;
    }
    const T = state.tileSize;
    const [r, g, b] = hexToRgb(p.color || '#ffffff');

    const isSelf = p.id === state.selfId;
    const px = p.x * T + T / 2;
    const py = p.y * T + T / 2;

    // Phase offset so multiple players don't pulse in lock-step.
    const phase = Math.random() * Math.PI * 2;
    // Self-player gets a slightly brighter, bigger halo to help you spot yourself.
    const glowIntensity = isSelf ? 1.25 : 1.0;

    // Halo "spread" beyond the player radius is halved vs. the previous look,
    // so the aura is tighter and more subtle.
    const outerSpread = 1 + 0.275 * glowIntensity; // was ~1.55
    const innerSpread = 1 + 0.05 * glowIntensity;  // was ~1.10

    // Outer halo (soft, low opacity).
    const haloOuter = k.add([
      k.circle(T / 2),
      k.pos(px, py),
      k.anchor('center'),
      k.color(r, g, b),
      k.opacity(0.18 * glowIntensity),
      k.scale(1),
      k.z(8),
      'playerGlow',
      { playerId: p.id, phase, speed: 2.4, baseScale: outerSpread, amp: 0.11 },
    ]);

    // Inner halo (tighter, brighter, pulses slightly faster).
    const haloInner = k.add([
      k.circle(T / 2),
      k.pos(px, py),
      k.anchor('center'),
      k.color(
        Math.min(255, r + 40),
        Math.min(255, g + 40),
        Math.min(255, b + 40)
      ),
      k.opacity(0.35 * glowIntensity),
      k.scale(1),
      k.z(9),
      'playerGlow',
      { playerId: p.id, phase: phase + Math.PI / 2, speed: 3.2, baseScale: innerSpread, amp: 0.07 },
    ]);

    const ent = k.add([
      k.circle(T / 2 - 4),
      k.pos(px, py),
      k.anchor('center'),
      k.color(r, g, b),
      k.outline(isSelf ? 3 : 2, isSelf ? k.rgb(255, 255, 255) : k.rgb(0, 0, 0)),
      k.z(10),
      'player',
      {
        playerId: p.id,
        targetX: px,
        targetY: py,
        trailT: 0,
        facing: p.facing || 'right',
      },
    ]);

    // Facing barrel: a short rectangle that sticks out of the player circle
    // in the direction they'll fire. Anchor 'left' means the base sits at
    // the entity position and the barrel extends outward.
    const barrel = k.add([
      k.rect(T / 2 - 2, 3),
      k.pos(px, py),
      k.anchor('left'),
      k.rotate(FACING_ANGLE[p.facing || 'right']),
      k.color(255, 255, 255),
      k.opacity(0.85),
      k.z(10.5),
      'playerBarrel',
      { playerId: p.id },
    ]);
    barrel.onUpdate(() => {
      barrel.pos.x = ent.pos.x;
      barrel.pos.y = ent.pos.y;
      barrel.angle = FACING_ANGLE[ent.facing] ?? 0;
    });
    state.playerBarrels.set(p.id, barrel);

    // Trailing glow: spawn fading ghost dots behind the player while moving.
    const TRAIL_INTERVAL = 0.035; // seconds between dots
    const TRAIL_LIFE = 0.55;      // seconds before fully gone
    const TRAIL_RADIUS = (T / 2 - 4) * 0.85;

    ent.onUpdate(() => {
      const dx = ent.targetX - ent.pos.x;
      const dy = ent.targetY - ent.pos.y;
      const moving = Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6;
      ent.trailT += k.dt();
      if (!moving) return;
      if (ent.trailT < TRAIL_INTERVAL) return;
      ent.trailT = 0;

      const trail = k.add([
        k.circle(TRAIL_RADIUS),
        k.pos(ent.pos.x, ent.pos.y),
        k.anchor('center'),
        k.color(r, g, b),
        k.opacity(0.5 * glowIntensity),
        k.scale(1),
        k.z(7),
        'playerTrail',
        { playerId: p.id, age: 0, life: TRAIL_LIFE },
      ]);
      trail.onUpdate(() => {
        trail.age += k.dt();
        const t = Math.min(1, trail.age / trail.life);
        trail.opacity = 0.5 * glowIntensity * (1 - t);
        const s = 1 - 0.55 * t; // shrink as it fades
        trail.scale = k.vec2(s, s);
        if (trail.age >= trail.life) trail.destroy();
      });
    });

    // Keep halos locked to the (lerping) player position and animate pulse.
    const animateHalo = (halo, baseOpacity) => {
      halo.onUpdate(() => {
        const t = k.time() * halo.speed + halo.phase;
        const s = halo.baseScale + halo.amp * Math.sin(t);
        halo.scale = k.vec2(s, s);
        halo.opacity = baseOpacity * (0.75 + 0.35 * (0.5 + 0.5 * Math.sin(t)));
        halo.pos.x = ent.pos.x;
        halo.pos.y = ent.pos.y;
      });
    };
    animateHalo(haloOuter, 0.22 * glowIntensity);
    animateHalo(haloInner, 0.4 * glowIntensity);

    // Label (first 4 chars of ID).
    const label = k.add([
      k.text(p.name || p.id.slice(0, 4), { size: 10, font: 'sans-serif' }),
      k.pos(px, py - T / 2 - 2),
      k.anchor('bot'),
      k.color(255, 255, 255),
      k.z(11),
      'playerLabel',
      { playerId: p.id },
    ]);
    label.onUpdate(() => {
      label.pos.x = ent.pos.x;
      label.pos.y = ent.pos.y - T / 2 - 2;
    });

    state.playerEntities.set(p.id, ent);
  }

  function removePlayer(id) {
    const ent = state.playerEntities.get(id);
    if (ent) ent.destroy();
    state.playerEntities.delete(id);
    const barrel = state.playerBarrels.get(id);
    if (barrel) barrel.destroy();
    state.playerBarrels.delete(id);
    if (state.k) {
      state.k
        .get('playerLabel')
        .filter((l) => l.playerId === id)
        .forEach((l) => l.destroy());
      state.k
        .get('playerGlow')
        .filter((g) => g.playerId === id)
        .forEach((g) => g.destroy());
      state.k
        .get('playerTrail')
        .filter((t) => t.playerId === id)
        .forEach((t) => t.destroy());
    }
  }

  function updatePlayerPosition(id, x, y, snap = false, facing = null) {
    const ent = state.playerEntities.get(id);
    if (!ent) return;
    const T = state.tileSize;
    ent.targetX = x * T + T / 2;
    ent.targetY = y * T + T / 2;
    if (facing) ent.facing = facing;
    if (snap) {
      ent.pos.x = ent.targetX;
      ent.pos.y = ent.targetY;
    }
    // Extend fog reveal whenever the self-player moves.
    if (id === state.selfId) revealFrom(x, y);
  }

  function setPlayerFacing(id, facing) {
    const ent = state.playerEntities.get(id);
    if (!ent) return;
    ent.facing = facing;
  }

  function setPlayerOverheated(id, overheated) {
    const barrel = state.playerBarrels.get(id);
    if (barrel) {
      if (overheated) {
        barrel.color = state.k.rgb(100, 116, 139);
        barrel.opacity = 0.55;
      } else {
        barrel.color = state.k.rgb(255, 255, 255);
        barrel.opacity = 0.85;
      }
    }
  }

  // Animate a bullet from `from` tile to `to` tile. If `destroyed` is true,
  // the wall at `to` is removed on bullet arrival.
  function spawnBullet({ shooterId, color, from, to, hitKind, wallHpAfter, destroyed }) {
    const k = state.k;
    if (!k) return;
    const T = state.tileSize;
    const [r, g, b] = hexToRgb(color || '#ffffff');

    const fromPx = { x: from.x * T + T / 2, y: from.y * T + T / 2 };
    const toPx = { x: to.x * T + T / 2, y: to.y * T + T / 2 };
    const dx = toPx.x - fromPx.x;
    const dy = toPx.y - fromPx.y;
    const dist = Math.hypot(dx, dy);

    // Bullet speed ~ 11 tiles/sec (353 px/sec at TILE=32), capped so the
    // slowest shots still feel snappy.
    const SPEED = 11 * T;
    const duration = Math.max(0.05, dist / SPEED);

    const bullet = k.add([
      k.circle(4),
      k.pos(fromPx.x, fromPx.y),
      k.anchor('center'),
      k.color(r, g, b),
      k.outline(2, k.rgb(255, 255, 255)),
      k.z(15),
      'bullet',
      { shooterId, age: 0, duration, fromPx, toPx },
    ]);

    // Trailing streak behind the bullet.
    bullet.onUpdate(() => {
      bullet.age += k.dt();
      const t = Math.min(1, bullet.age / bullet.duration);
      bullet.pos.x = fromPx.x + (toPx.x - fromPx.x) * t;
      bullet.pos.y = fromPx.y + (toPx.y - fromPx.y) * t;
      if (t >= 1) {
        onBulletArrived(
          bullet.pos.x,
          bullet.pos.y,
          to,
          hitKind,
          wallHpAfter,
          destroyed,
          [r, g, b]
        );
        bullet.destroy();
      }
    });
  }

  function onBulletArrived(px, py, gridPos, hitKind, wallHpAfter, destroyed, rgb) {
    const k = state.k;
    if (!k) return;
    const T = state.tileSize;

    if (!destroyed && hitKind === 'wall' && wallHpAfter != null && gridPos) {
      setWallCrackVisual(gridPos.x, gridPos.y, wallHpAfter);
    }

    // Impact flash — short-lived expanding ring in the shooter's color.
    const flash = k.add([
      k.circle(T / 3),
      k.pos(px, py),
      k.anchor('center'),
      k.color(rgb[0], rgb[1], rgb[2]),
      k.opacity(0.9),
      k.scale(0.5),
      k.z(14),
      'bulletFlash',
      { age: 0, life: 0.25 },
    ]);
    flash.onUpdate(() => {
      flash.age += k.dt();
      const t = Math.min(1, flash.age / flash.life);
      flash.scale = k.vec2(0.5 + 1.2 * t);
      flash.opacity = 0.9 * (1 - t);
      if (flash.age >= flash.life) flash.destroy();
    });

    if (destroyed && gridPos) {
      const key = `${gridPos.x},${gridPos.y}`;
      removeWallCrackAt(key);
      const wall = state.wallEntities.get(key);
      if (wall) {
        wall.destroy();
        state.wallEntities.delete(key);
      }
      // Keep the client's LOS grid in sync so future reveals can see through.
      if (state.currentMaze) {
        state.currentMaze.grid[gridPos.y][gridPos.x] = 0;
      }

      // Debris burst: a few small specks flying outward.
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.4;
        const speed = 60 + Math.random() * 80;
        const debris = k.add([
          k.rect(3, 3),
          k.pos(px, py),
          k.anchor('center'),
          k.color(rgb[0], rgb[1], rgb[2]),
          k.opacity(0.9),
          k.z(13),
          'bulletDebris',
          {
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            age: 0,
            life: 0.35,
          },
        ]);
        debris.onUpdate(() => {
          debris.age += k.dt();
          const dt = k.dt();
          debris.pos.x += debris.vx * dt;
          debris.pos.y += debris.vy * dt;
          debris.opacity = 0.9 * (1 - debris.age / debris.life);
          if (debris.age >= debris.life) debris.destroy();
        });
      }
    }
  }

  function renderAll(data) {
    if (!state.k) setupKaboomFor(data.maze);
    else if (
      data.maze.width !== state.mazeWidth ||
      data.maze.height !== state.mazeHeight
    ) {
      setupKaboomFor(data.maze);
    }

    state.roundId = data.roundId != null ? data.roundId : 0;
    buildMaze(data.maze, data.wallHp);

    // Reset players.
    state.playerEntities.forEach((ent) => ent.destroy());
    state.playerEntities.clear();
    state.playerBarrels.forEach((b) => b.destroy());
    state.playerBarrels.clear();
    if (state.k) {
      state.k.get('playerLabel').forEach((l) => l.destroy());
      state.k.get('playerGlow').forEach((g) => g.destroy());
      state.k.get('playerTrail').forEach((t) => t.destroy());
      state.k.get('playerBarrel').forEach((b) => b.destroy());
      state.k.get('bullet').forEach((b) => b.destroy());
      state.k.get('bulletFlash').forEach((b) => b.destroy());
      state.k.get('bulletDebris').forEach((b) => b.destroy());
    }
    data.players.forEach((p) => addPlayer(p));

    // Initial fog reveal around the self-player's spawn position.
    const me = data.players.find((p) => p.id === state.selfId);
    if (me) revealFrom(me.x, me.y);
  }

  window.Renderer = {
    init,
    teardown,
    renderAll,
    addPlayer,
    removePlayer,
    updatePlayerPosition,
    setPlayerFacing,
    setPlayerOverheated,
    spawnBullet,
    revealFrom,
  };
})();
