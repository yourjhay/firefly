// Simple procedural synth SFX (Web Audio API). Unlocks after first user gesture.
(function () {
  let ctx = null;

  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  function resume() {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  if (typeof document !== 'undefined') {
    const unlock = () => {
      resume();
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true, passive: true });
  }

  // Short bright zap — shot fired
  function playShoot() {
    const c = getCtx();
    if (!c) return;
    resume();
    const t0 = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(1400, t0);
    o.frequency.exponentialRampToValueAtTime(320, t0 + 0.05);
    g.gain.setValueAtTime(0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + 0.07);
  }

  // Mid thud — impact on solid
  function playWallHit() {
    const c = getCtx();
    if (!c) return;
    resume();
    const t0 = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(110, t0);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.1);
    g.gain.setValueAtTime(0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + 0.12);
  }

  // Shatter / crack
  function playCrack() {
    const c = getCtx();
    if (!c) return;
    resume();
    const t0 = c.currentTime;
    const dur = 0.09;
    const n = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    src.buffer = n;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2000;
    f.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.18, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(c.destination);
    const o2 = c.createOscillator();
    const g2 = c.createGain();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(90, t0);
    g2.gain.setValueAtTime(0.08, t0);
    g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    o2.connect(g2);
    g2.connect(c.destination);
    src.start(t0);
    o2.start(t0);
    src.stop(t0 + dur);
    o2.stop(t0 + 0.06);
  }

  // Short victory fanfare (ascending 5th + octave)
  function playWin() {
    const c = getCtx();
    if (!c) return;
    resume();
    const t0 = c.currentTime;
    const freqs = [392, 523, 659, 784];
    const step = 0.11;
    freqs.forEach((freq, i) => {
      const t = t0 + i * step;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + 0.25);
    });
  }

  window.Synth = {
    resume,
    playShoot,
    playWallHit,
    playCrack,
    playWin,
  };
})();
