const crypto = require('crypto');
const { GameManager } = require('./gameManager');

// Host invite codes use two letters + four digits. Omit W/A/S/D so codes
// never echo movement keys when read aloud or copied.
const INVITE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.replace(/[WASD]/g, '');

/**
 * In-memory rooms keyed by invite code (e.g. FL1234).
 * Restarting the Node process clears all sessions.
 */
class SessionManager {
  constructor({ cols, rows } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.sessions = new Map();
    this.socketsByRoom = new Map();
  }

  normalizeCode(raw) {
    if (raw == null || typeof raw !== 'string') return '';
    return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  isValidCodeFormat(code) {
    return /^[A-Z]{2}\d{4}$/.test(code);
  }

  generateCode() {
    const nL = INVITE_LETTERS.length;
    for (let attempt = 0; attempt < 100; attempt++) {
      const a = INVITE_LETTERS[crypto.randomInt(0, nL)];
      const b = INVITE_LETTERS[crypto.randomInt(0, nL)];
      const n = crypto.randomInt(0, 10000);
      const code = `${a}${b}${String(n).padStart(4, '0')}`;
      if (!this.sessions.has(code)) return code;
    }
    // Extremely unlikely: fall back to longer suffix
    return `ZZ${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`.slice(0, 6);
  }

  createSession() {
    const code = this.generateCode();
    const game = new GameManager({
      broadcast: (msg, exceptId) => this.broadcastTo(code, msg, exceptId),
      cols: this.cols,
      rows: this.rows,
    });
    this.sessions.set(code, { game });
    this.socketsByRoom.set(code, new Map());
    return { code, game };
  }

  /**
   * @param {string} rawCode
   * @returns {GameManager | null}
   */
  getGameForJoin(rawCode) {
    const code = this.normalizeCode(rawCode);
    if (!this.isValidCodeFormat(code)) return null;
    const entry = this.sessions.get(code);
    return entry ? entry.game : null;
  }

  registerSocket(code, playerId, ws) {
    const map = this.socketsByRoom.get(code);
    if (map) map.set(playerId, ws);
  }

  unregisterSocket(code, playerId) {
    const map = this.socketsByRoom.get(code);
    if (map) map.delete(playerId);
  }

  broadcastTo(code, msg, exceptId) {
    const map = this.socketsByRoom.get(code);
    if (!map) return;
    const payload = JSON.stringify(msg);
    for (const [pid, sock] of map) {
      if (pid === exceptId) continue;
      if (sock.readyState === sock.OPEN) sock.send(payload);
    }
  }

  /**
   * After the last player leaves, remove the room so the code can be reused.
   * @param {string} code
   */
  destroySessionIfEmpty(code) {
    const entry = this.sessions.get(code);
    if (!entry) return;
    if (entry.game.players.size > 0) return;
    this.sessions.delete(code);
    this.socketsByRoom.delete(code);
  }
}

module.exports = { SessionManager };
