// Keyboard (WASD/arrows) and on-screen touch dpad. Holding a direction
// repeats the move at a fixed interval so movement feels continuous.
// Spacebar (or the on-screen fire button) triggers a bullet.
(function () {
  const REPEAT_MS = 110;
  const FIRE_REPEAT_MS = 300; // slightly longer than server cooldown (280ms)

  const held = new Set();
  let repeatTimer = null;
  let lastDir = null;

  const KEYMAP = {
    arrowup: 'up',
    w: 'up',
    arrowdown: 'down',
    s: 'down',
    arrowleft: 'left',
    a: 'left',
    arrowright: 'right',
    d: 'right',
  };

  function currentDir() {
    if (lastDir && held.has(lastDir)) return lastDir;
    return held.size ? [...held][held.size - 1] : null;
  }

  function startRepeat() {
    if (repeatTimer) return;
    repeatTimer = setInterval(() => {
      const dir = currentDir();
      if (!dir) return;
      if (window.Net) window.Net.sendMove(dir);
    }, REPEAT_MS);
  }

  function stopRepeat() {
    if (held.size === 0 && repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
      lastDir = null;
    }
  }

  function press(dir) {
    if (!dir) return;
    lastDir = dir;
    if (!held.has(dir)) {
      held.add(dir);
      if (window.Net) window.Net.sendMove(dir);
    }
    startRepeat();
  }

  function release(dir) {
    if (!dir) return;
    held.delete(dir);
    if (lastDir === dir) lastDir = null;
    stopRepeat();
  }

  // Fire (spacebar) with auto-repeat while held.
  let fireHeld = false;
  let fireTimer = null;

  function fireOnce() {
    if (window.Net) window.Net.sendFire();
  }

  function startFireRepeat() {
    if (fireTimer) return;
    fireTimer = setInterval(() => {
      if (fireHeld) fireOnce();
    }, FIRE_REPEAT_MS);
  }

  function stopFireRepeat() {
    if (fireTimer) {
      clearInterval(fireTimer);
      fireTimer = null;
    }
  }

  // Keyboard handlers.
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (!fireHeld) {
        fireHeld = true;
        fireOnce();
        startFireRepeat();
      }
      return;
    }
    if (e.repeat) return;
    const dir = KEYMAP[e.key.toLowerCase()];
    if (!dir) return;
    e.preventDefault();
    press(dir);
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      fireHeld = false;
      stopFireRepeat();
      return;
    }
    const dir = KEYMAP[e.key.toLowerCase()];
    if (!dir) return;
    release(dir);
  });

  // Clear state if window loses focus (so a key doesn't "stick").
  window.addEventListener('blur', () => {
    held.clear();
    stopRepeat();
    fireHeld = false;
    stopFireRepeat();
  });

  // Touch / pointer dpad.
  function bindTouchControls() {
    const buttons = document.querySelectorAll('#touchControls .btn');
    buttons.forEach((btn) => {
      if (btn.dataset.action === 'fire') {
        const fireStart = (e) => {
          e.preventDefault();
          if (!fireHeld) {
            fireHeld = true;
            fireOnce();
            startFireRepeat();
          }
        };
        const fireEnd = (e) => {
          e.preventDefault();
          fireHeld = false;
          stopFireRepeat();
        };
        btn.addEventListener('touchstart', fireStart, { passive: false });
        btn.addEventListener('touchend', fireEnd);
        btn.addEventListener('touchcancel', fireEnd);
        btn.addEventListener('mousedown', fireStart);
        btn.addEventListener('mouseup', fireEnd);
        btn.addEventListener('mouseleave', fireEnd);
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        return;
      }
      const dir = btn.dataset.dir;
      const start = (e) => {
        e.preventDefault();
        press(dir);
      };
      const end = (e) => {
        e.preventDefault();
        release(dir);
      };
      btn.addEventListener('touchstart', start, { passive: false });
      btn.addEventListener('touchend', end);
      btn.addEventListener('touchcancel', end);
      btn.addEventListener('mousedown', start);
      btn.addEventListener('mouseup', end);
      btn.addEventListener('mouseleave', end);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTouchControls);
  } else {
    bindTouchControls();
  }

  window.Controls = { press, release };
})();
