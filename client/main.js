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
  };

  // Fire/overheat state (for HUD + fire button styling).
  const fire = {
    overheated: false,
    overheatedUntil: 0,
    serverOffsetMs: 0, // serverTime - clientTime; used to normalize timers
    lockoutMs: 10000,
  };
  let firePillTimer = null;
  const fireBtn = document.querySelector('[data-action="fire"]');

  function updateFirePill() {
    if (!ui.firePill) return;
    if (fire.overheated) {
      const now = Date.now() + fire.serverOffsetMs;
      const remaining = Math.max(0, fire.overheatedUntil - now);
      if (remaining <= 0) {
        fire.overheated = false;
        applyFireUi();
        return;
      }
      const secs = (remaining / 1000).toFixed(1);
      ui.firePill.textContent = `● Cooling ${secs}s`;
    }
  }

  function applyFireUi() {
    if (ui.firePill) {
      ui.firePill.classList.toggle('overheated', fire.overheated);
      ui.firePill.classList.toggle('ready', !fire.overheated);
      ui.firePill.textContent = fire.overheated ? '● Cooling…' : '● Ready';
    }
    if (fireBtn) {
      fireBtn.classList.toggle('overheated', fire.overheated);
    }
    if (firePillTimer) {
      clearInterval(firePillTimer);
      firePillTimer = null;
    }
    if (fire.overheated) {
      firePillTimer = setInterval(updateFirePill, 100);
      updateFirePill();
    }
  }

  const game = {
    self: null,
    players: new Map(),
    roundId: 0,
    state: 'connecting',
  };

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
      ui.playerInfo.innerHTML = `You: <span style="color:${game.self.color}">●</span> ${game.self.name}`;
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
    window.Net.switchServer(trimmed || null);
  });

  window.Net.on('status', ({ connected, url, connecting }) => {
    if (connected) setStatus('Connected', url);
    else if (connecting) setStatus('Connecting…', url);
    else setStatus('Disconnected — retrying…', url);
  });

  window.Net.on('init', (data) => {
    game.self = data.you;
    game.roundId = data.roundId;
    game.state = data.state;
    game.players = new Map(data.players.map((p) => [p.id, p]));

    if (data.fire) {
      fire.serverOffsetMs = (data.fire.serverTime || 0) - Date.now();
      fire.lockoutMs = data.fire.lockoutMs || fire.lockoutMs;
    }

    window.Renderer.init(game.self.id);
    window.Renderer.renderAll({ maze: data.maze, players: data.players });

    // Apply any pre-existing overheat state (e.g. mid-lockout reconnect).
    data.players.forEach((p) => {
      if (p.overheated) {
        window.Renderer.setPlayerOverheated(p.id, true);
        if (p.id === game.self.id) {
          fire.overheated = true;
          fire.overheatedUntil = p.overheatedUntil || 0;
        }
      }
    });
    applyFireUi();

    setStatus(data.state === 'finished' ? 'Round over' : 'Playing');
    updateHud();

    if (data.state === 'finished' && data.winnerId) {
      const winner = game.players.get(data.winnerId);
      if (winner) {
        showBanner(
          `<span class="accent">${winner.name}</span> wins! Next round starting…`,
          0
        );
      }
    } else {
      hideBanner();
    }
  });

  window.Net.on('playerJoined', ({ player }) => {
    if (!player) return;
    game.players.set(player.id, player);
    window.Renderer.addPlayer(player);
    if (player.overheated) window.Renderer.setPlayerOverheated(player.id, true);
    updateHud();
  });

  window.Net.on('playerLeft', ({ id }) => {
    game.players.delete(id);
    window.Renderer.removePlayer(id);
    updateHud();
  });

  window.Net.on('playerMoved', ({ id, x, y, facing }) => {
    const p = game.players.get(id);
    if (p) {
      p.x = x;
      p.y = y;
      if (facing) p.facing = facing;
    }
    window.Renderer.updatePlayerPosition(id, x, y, false, facing);
  });

  window.Net.on('playerFaced', ({ id, facing }) => {
    const p = game.players.get(id);
    if (p) p.facing = facing;
    window.Renderer.setPlayerFacing(id, facing);
  });

  window.Net.on('bullet', (evt) => {
    window.Renderer.spawnBullet(evt);
  });

  window.Net.on('fireState', (evt) => {
    if (!evt) return;
    if (typeof evt.serverTime === 'number') {
      fire.serverOffsetMs = evt.serverTime - Date.now();
    }
    if (typeof evt.lockoutMs === 'number') fire.lockoutMs = evt.lockoutMs;
    const isSelf = game.self && evt.id === game.self.id;
    window.Renderer.setPlayerOverheated(evt.id, !!evt.overheated);
    if (isSelf) {
      fire.overheated = !!evt.overheated;
      fire.overheatedUntil = evt.overheatedUntil || 0;
      applyFireUi();
    }
  });

  window.Net.on('gameOver', ({ winner, resetInMs }) => {
    game.state = 'finished';
    const isYou = winner && game.self && winner.id === game.self.id;
    const name = winner ? winner.name : 'Someone';
    const color = winner ? winner.color : '#fff';
    showBanner(
      `${isYou ? 'You win!' : `<span style="color:${color}">●</span> <span class="accent">${name}</span> wins!`}<br/><small style="font-weight:400;color:#9ba0b4">New round in ${Math.round(
        (resetInMs || 5000) / 1000
      )}s…</small>`,
      0
    );
    setStatus('Round over');
  });

  window.Net.on('newRound', (data) => {
    game.state = data.state;
    game.roundId = data.roundId;
    game.players = new Map(data.players.map((p) => [p.id, p]));
    if (data.fire) {
      fire.serverOffsetMs = (data.fire.serverTime || 0) - Date.now();
      fire.lockoutMs = data.fire.lockoutMs || fire.lockoutMs;
    }
    fire.overheated = false;
    fire.overheatedUntil = 0;
    applyFireUi();

    window.Renderer.renderAll({ maze: data.maze, players: data.players });
    hideBanner();
    setStatus('Playing');
    updateHud();
  });

  window.Net.connect();
})();
