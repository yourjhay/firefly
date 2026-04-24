// App entry: wires network events into the renderer and HUD.
(function () {
  const ui = {
    status: document.getElementById('status'),
    roundLabel: document.getElementById('roundLabel'),
    playerInfo: document.getElementById('playerInfo'),
    playerCount: document.getElementById('playerCount'),
    banner: document.getElementById('banner'),
    serverBtn: document.getElementById('serverBtn'),
    firePill: document.getElementById('firePill'),
    spectatorPill: document.getElementById('spectatorPill'),
    roomPill: document.getElementById('roomPill'),
    sessionModal: document.getElementById('sessionModal'),
    sessionError: document.getElementById('sessionError'),
    joinCode: document.getElementById('joinCode'),
  };

  const hostBtn = document.getElementById('hostBtn');
  const joinBtn = document.getElementById('joinBtn');

  function showSessionModal() {
    if (ui.sessionModal) ui.sessionModal.classList.remove('hidden');
  }

  function clearSessionError() {
    if (ui.sessionError) {
      ui.sessionError.classList.add('hidden');
      ui.sessionError.textContent = '';
    }
  }

  function hideSessionModal() {
    if (ui.sessionModal) ui.sessionModal.classList.add('hidden');
  }

  function setSessionErrorMsg(msg) {
    if (!ui.sessionError) return;
    ui.sessionError.textContent = msg;
    ui.sessionError.classList.remove('hidden');
  }

  function normalizeJoinCode(raw) {
    return String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function isValidJoinCode(s) {
    return /^[A-Z]{2}\d{4}$/.test(s);
  }

  // Fire/overheat state (for HUD + fire button styling).
  const fire = {
    overheated: false,
    overheatedUntil: 0,
    serverOffsetMs: 0, // serverTime - clientTime; used to normalize timers
    lockoutMs: 10000,
    burstCapacityMs: 2000, // opportunity remaining for the next burst
    depleted: false,        // true: no firing possible for the rest of the round
  };
  let firePillTimer = null;
  const fireBtn = document.querySelector('[data-action="fire"]');

  function updateFirePill() {
    if (!ui.firePill) return;
    if (fire.depleted) return; // static message, no countdown
    if (fire.overheated) {
      const now = Date.now() + fire.serverOffsetMs;
      const remaining = Math.max(0, fire.overheatedUntil - now);
      if (remaining <= 0) {
        fire.overheated = false;
        applyFireUi();
        return;
      }
      const secs = (remaining / 1000).toFixed(1);
      const opp = (fire.burstCapacityMs / 1000).toFixed(1);
      ui.firePill.textContent = `● Cooling ${secs}s — next burst ${opp}s`;
    }
  }

  function applyFireUi() {
    if (ui.firePill) {
      ui.firePill.classList.toggle('overheated', fire.overheated && !fire.depleted);
      ui.firePill.classList.toggle('ready', !fire.overheated && !fire.depleted);
      ui.firePill.classList.toggle('depleted', fire.depleted);
      if (fire.depleted) {
        ui.firePill.textContent = '✕ No bullets left this round';
      } else {
        ui.firePill.textContent = fire.overheated ? '● Cooling…' : '● Ready';
      }
    }
    if (fireBtn) {
      fireBtn.classList.toggle('overheated', fire.overheated && !fire.depleted);
      fireBtn.classList.toggle('depleted', fire.depleted);
      fireBtn.disabled = fire.depleted;
    }
    if (firePillTimer) {
      clearInterval(firePillTimer);
      firePillTimer = null;
    }
    if (fire.overheated && !fire.depleted) {
      firePillTimer = setInterval(updateFirePill, 100);
      updateFirePill();
    }
  }

  const game = {
    self: null,
    roomCode: null,
    players: new Map(),
    ghosts: new Map(),
    roundId: 0,
    state: 'connecting',
    selfEliminated: false,
  };
  window.gameEliminated = false;

  function setSelfEliminated(elim) {
    game.selfEliminated = !!elim;
    window.gameEliminated = !!elim;
    if (ui.spectatorPill) {
      ui.spectatorPill.classList.toggle('hidden', !elim);
      ui.spectatorPill.textContent = elim
        ? 'Spectating — drag the map to look around'
        : 'Spectating';
    }
  }

  function buildInviteUrl(roomCode) {
    const u = new URL(window.location.href);
    u.searchParams.set('code', roomCode);
    u.hash = '';
    return u.toString();
  }

  async function copyCurrentInviteLink() {
    const code = game.roomCode;
    if (!code || !ui.roomPill) return;
    const url = buildInviteUrl(code);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        showBanner('Invite link copied.', 2200);
        return;
      }
    } catch {
      // clipboard denied or unavailable
    }
    window.prompt('Copy invite link:', url);
  }

  // Match client/renderer + server: crack threshold (for first-crack SFX only).
  const SFX_WALL_HP = 5;
  const SFX_BULLET_DMG = 0.5;
  const SFX_CRACK_HITS = 3;
  function wallShowsCracks(hp) {
    if (hp == null || hp <= 0 || hp === -1) return false;
    return SFX_WALL_HP - hp + 1e-6 >= SFX_CRACK_HITS * SFX_BULLET_DMG;
  }

  let bannerTimeout = null;

  function setStatus(text, extra) {
    ui.status.textContent = extra ? `${text} — ${extra}` : text;
  }

  function showBanner(html, ms) {
    ui.banner.innerHTML = html;
    ui.banner.classList.remove('hidden');
    if (bannerTimeout) clearTimeout(bannerTimeout);
    if (ms) {
      bannerTimeout = setTimeout(() => ui.banner.classList.add('hidden'), ms);
    }
  }

  function hideBanner() {
    ui.banner.classList.add('hidden');
    if (bannerTimeout) {
      clearTimeout(bannerTimeout);
      bannerTimeout = null;
    }
  }

  function updateHud() {
    ui.playerCount.textContent = `Players: ${game.players.size}`;
    ui.roundLabel.textContent = `Round ${game.roundId}`;
    if (game.self) {
      const dot = `<span style="color:${game.self.color}">●</span>`;
      if (game.selfEliminated) {
        ui.playerInfo.innerHTML = `You: ${dot} ${game.self.name} <span class="muted">(out)</span>`;
      } else {
        ui.playerInfo.innerHTML = `You: ${dot} ${game.self.name}`;
      }
    }
  }

  ui.serverBtn.addEventListener('click', () => {
    const current = window.Net.getServerUrl() || window.Net.resolveServerUrl();
    const input = window.prompt(
      'WebSocket server URL (e.g. ws://ws.rjhon.net/ws):\nLeave blank to reset to default.',
      current
    );
    if (input === null) return;
    const trimmed = input.trim();
    game.self = null;
    game.roomCode = null;
    window.Net.switchServer(trimmed || null);
    game.players = new Map();
    game.ghosts = new Map();
    setSelfEliminated(false);
    game.state = 'connecting';
    if (ui.roomPill) ui.roomPill.classList.add('hidden');
    hideBanner();
    window.Renderer.teardown();
    setStatus('Lobby');
    showSessionModal();
  });

  if (hostBtn) {
    hostBtn.addEventListener('click', () => {
      clearSessionError();
      window.Net.beginCreateSession();
    });
  }

  if (joinBtn && ui.joinCode) {
    joinBtn.addEventListener('click', () => {
      const code = normalizeJoinCode(ui.joinCode.value);
      if (!isValidJoinCode(code)) {
        setSessionErrorMsg('Enter a code like FL1234 (2 letters + 4 digits).');
        return;
      }
      clearSessionError();
      window.Net.beginJoinSession(code);
    });
  }

  if (ui.joinCode) {
    ui.joinCode.addEventListener('input', () => {
      let v = ui.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (v.length > 6) v = v.slice(0, 6);
      ui.joinCode.value = v;
    });
  }

  if (ui.roomPill) {
    ui.roomPill.addEventListener('click', () => {
      copyCurrentInviteLink();
    });
  }

  window.Net.on('status', ({ connected, url, connecting, left }) => {
    if (left) {
      setStatus('Lobby');
      return;
    }
    if (!game.self) {
      if (connected) setStatus('Joining…', url);
      else if (connecting) setStatus('Connecting…', url);
      else setStatus('Disconnected — retrying…', url);
      return;
    }
    if (connected) setStatus('Connected', url);
    else if (connecting) setStatus('Connecting…', url);
    else setStatus('Disconnected — retrying…', url);
  });

  window.Net.on('sessionError', (msg) => {
    const reason = msg && msg.code;
    const map = {
      NOT_FOUND: 'No room with that code.',
      BAD_REQUEST: 'Invalid code. Use 2 letters and 4 digits (e.g. FL1234).',
      ALREADY_IN_SESSION: 'Already in a session. Refresh the page to start over.',
      NOT_IN_SESSION: 'Not in a room yet.',
      ROOM_FULL: 'That room already has 13 players.',
    };
    setSessionErrorMsg(map[reason] || `Could not join (${reason || 'error'}).`);
    showSessionModal();
  });

  window.Net.on('init', (data) => {
    game.self = data.you;
    game.roundId = data.roundId;
    game.state = data.state;
    game.players = new Map(data.players.map((p) => [p.id, p]));
    game.ghosts = new Map((data.ghosts || []).map((g) => [g.id, g]));
    const meInit = data.players.find((p) => p.id === game.self.id);
    setSelfEliminated(meInit && meInit.eliminated);

    hideSessionModal();
    game.roomCode = data.roomCode || null;
    if (data.roomCode && ui.roomPill) {
      ui.roomPill.textContent = `Room ${data.roomCode}`;
      ui.roomPill.classList.remove('hidden');
      window.Net.setResumeRoomCode(data.roomCode);
    }

    if (data.fire) {
      fire.serverOffsetMs = (data.fire.serverTime || 0) - Date.now();
      fire.lockoutMs = data.fire.lockoutBaseMs || fire.lockoutMs;
      fire.burstCapacityMs =
        data.fire.burstCapacityBaseMs || fire.burstCapacityMs;
    }

    window.Renderer.init(game.self.id);
    window.Renderer.renderAll({
      maze: data.maze,
      players: data.players,
      ghosts: data.ghosts || [],
      wallHp: data.wallHp,
      roundId: data.roundId,
      spectatorFullVision: game.selfEliminated,
    });

    // Apply any pre-existing fire state (e.g. mid-lockout/depleted reconnect).
    fire.depleted = false;
    data.players.forEach((p) => {
      if (p.overheated || p.depleted) {
        window.Renderer.setPlayerOverheated(p.id, true);
      }
      if (p.id === game.self.id) {
        fire.overheated = !!p.overheated;
        fire.overheatedUntil = p.overheatedUntil || 0;
        fire.depleted = !!p.depleted;
        if (typeof p.nextBurstCapacityMs === 'number') {
          fire.burstCapacityMs = p.nextBurstCapacityMs;
        }
        if (typeof p.nextLockoutMs === 'number') {
          fire.lockoutMs = p.nextLockoutMs;
        }
      }
    });
    applyFireUi();

    setStatus(data.state === 'finished' ? 'Round over' : 'Playing');
    updateHud();

    if (game.selfEliminated) {
      window.Renderer.finalizeSpectatorCamera();
    }

    if (data.state === 'finished') {
      if (data.winnerId) {
        const winner = game.players.get(data.winnerId);
        if (winner) {
          showBanner(
            `<span class="accent">${winner.name}</span> wins! Next round starting…`,
            0
          );
        }
      } else {
        showBanner(
          '<span class="accent">Everyone was caught</span><br/><small style="font-weight:400;color:#9ba0b4">Round 1 starting soon…</small>',
          0
        );
      }
    } else {
      hideBanner();
    }
  });

  window.Net.on('playerJoined', ({ player }) => {
    if (!game.self || !player) return;
    game.players.set(player.id, player);
    window.Renderer.addPlayer(player);
    if (player.overheated || player.depleted) {
      window.Renderer.setPlayerOverheated(player.id, true);
    }
    updateHud();
  });

  window.Net.on('playerLeft', ({ id }) => {
    if (!game.self) return;
    game.players.delete(id);
    window.Renderer.removePlayer(id);
    updateHud();
  });

  window.Net.on('playerMoved', ({ id, x, y, facing }) => {
    if (!game.self) return;
    const p = game.players.get(id);
    if (p) {
      p.x = x;
      p.y = y;
      if (facing) p.facing = facing;
    }
    window.Renderer.updatePlayerPosition(id, x, y, false, facing);
  });

  window.Net.on('playerFaced', ({ id, facing }) => {
    if (!game.self) return;
    const p = game.players.get(id);
    if (p) p.facing = facing;
    window.Renderer.setPlayerFacing(id, facing);
  });

  window.Net.on('bullet', (evt) => {
    if (game.self && evt.shooterId === game.self.id) {
      window.Synth.playShoot();
    }
    if (evt.hitKind === 'wall') {
      window.Synth.playWallHit();
      if (!evt.destroyed && evt.wallHpAfter != null) {
        const hp = evt.wallHpAfter;
        const prevHp = hp + SFX_BULLET_DMG;
        if (wallShowsCracks(hp) && !wallShowsCracks(prevHp)) {
          window.Synth.playCrack();
        }
      }
    }
    if (evt.hitKind === 'ghost') {
      if (evt.ghostId != null) {
        if (evt.destroyed) game.ghosts.delete(evt.ghostId);
        else {
          const g = game.ghosts.get(evt.ghostId);
          if (g && typeof evt.ghostHpAfter === 'number') g.hp = evt.ghostHpAfter;
        }
        if (game.self) {
          window.Renderer.setGhostHp(evt.ghostId, evt.ghostHpAfter, evt.destroyed);
        }
      }
      if (!evt.destroyed) window.Synth.playWallHit();
    }
    if (!game.self) return;
    window.Renderer.spawnBullet(evt);
  });

  window.Net.on('fireState', (evt) => {
    if (!game.self || !evt) return;
    if (typeof evt.serverTime === 'number') {
      fire.serverOffsetMs = evt.serverTime - Date.now();
    }
    const isSelf = game.self && evt.id === game.self.id;
    // Grey out barrel if the remote player is locked out OR has run dry.
    window.Renderer.setPlayerOverheated(
      evt.id,
      !!evt.overheated || !!evt.depleted
    );
    if (isSelf) {
      fire.overheated = !!evt.overheated;
      fire.overheatedUntil = evt.overheatedUntil || 0;
      fire.depleted = !!evt.depleted;
      if (typeof evt.nextLockoutMs === 'number') {
        fire.lockoutMs = evt.nextLockoutMs;
      }
      if (typeof evt.nextBurstCapacityMs === 'number') {
        fire.burstCapacityMs = evt.nextBurstCapacityMs;
      }
      applyFireUi();
    }
  });

  window.Net.on('gameOver', (data) => {
    if (!game.self) return;
    game.state = 'finished';
    const resetInMs = data && data.resetInMs;
    const secs = Math.round((resetInMs || 5000) / 1000);
    if (!data || !data.winnerId) {
      showBanner(
        `<span class="accent">Everyone was caught</span><br/><small style="font-weight:400;color:#9ba0b4">Round 1 in ${secs}s…</small>`,
        0
      );
      setStatus('Round over');
      return;
    }
    window.Synth.playWin();
    const winner = data.winner;
    const isYou = winner && game.self && winner.id === game.self.id;
    const name = winner ? winner.name : 'Someone';
    const color = winner ? winner.color : '#fff';
    showBanner(
      `${isYou ? 'You win!' : `<span style="color:${color}">●</span> <span class="accent">${name}</span> wins!`}<br/><small style="font-weight:400;color:#9ba0b4">New round in ${secs}s…</small>`,
      0
    );
    setStatus('Round over');
  });

  window.Net.on('newRound', (data) => {
    if (!game.self) return;
    game.state = data.state;
    game.roundId = data.roundId;
    game.players = new Map(data.players.map((p) => [p.id, p]));
    game.ghosts = new Map((data.ghosts || []).map((g) => [g.id, g]));
    setSelfEliminated(false);
    if (data.fire) {
      fire.serverOffsetMs = (data.fire.serverTime || 0) - Date.now();
      fire.lockoutMs = data.fire.lockoutBaseMs || fire.lockoutMs;
      fire.burstCapacityMs =
        data.fire.burstCapacityBaseMs || fire.burstCapacityMs;
    }
    fire.overheated = false;
    fire.overheatedUntil = 0;
    fire.depleted = false;
    applyFireUi();

    window.Renderer.renderAll({
      maze: data.maze,
      players: data.players,
      ghosts: data.ghosts || [],
      wallHp: data.wallHp,
      roundId: data.roundId,
      spectatorFullVision: false,
    });
    hideBanner();
    setStatus('Playing');
    updateHud();
  });

  window.Net.on('ghostMoved', (evt) => {
    if (!game.self || !evt) return;
    const g = game.ghosts.get(evt.id);
    if (g) {
      g.x = evt.x;
      g.y = evt.y;
      if (evt.facing) g.facing = evt.facing;
    }
    window.Renderer.updateGhostPosition(evt.id, evt.x, evt.y, false, evt.facing);
  });

  window.Net.on('ghostSpawned', ({ ghost }) => {
    if (!game.self || !ghost) return;
    game.ghosts.set(ghost.id, ghost);
    window.Renderer.addGhost(ghost);
  });

  window.Net.on('ghostRemoved', ({ id }) => {
    if (!game.self) return;
    game.ghosts.delete(id);
    window.Renderer.removeGhost(id);
  });

  window.Net.on('playerEliminated', ({ id }) => {
    if (!game.self) return;
    const p = game.players.get(id);
    if (p) p.eliminated = true;
    if (id === game.self.id) {
      setSelfEliminated(true);
      window.Renderer.enterSpectatorView();
      updateHud();
    }
  });

  const params = new URLSearchParams(window.location.search);
  const urlCode = params.get('code');
  if (urlCode && ui.joinCode) {
    const c = normalizeJoinCode(urlCode);
    ui.joinCode.value = c;
    if (isValidJoinCode(c)) {
      window.Net.beginJoinSession(c);
    } else {
      setSessionErrorMsg('Invalid ?code= in link. Use FL1234 (2 letters + 4 digits).');
    }
  }
})();
