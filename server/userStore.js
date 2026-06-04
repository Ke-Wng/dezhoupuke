/**
 * User Store 鈥?JSON file-based persistence for user accounts, stats, and achievements
 * Supports registered users and guest players
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

// ===== Achievement Definitions =====
const ACHIEVEMENTS = {
  first_win:       { name: 'First Win', desc: 'Win your first hand', icon: 'WIN' },
  ten_wins:        { name: 'Ten Wins', desc: 'Win 10 hands', icon: '10W' },
  fifty_wins:      { name: 'Fifty Wins', desc: 'Win 50 hands', icon: '50W' },
  hundred_wins:    { name: 'Hundred Wins', desc: 'Win 100 hands', icon: '100W' },
  royal_flush:     { name: 'Royal Flush', desc: 'Make a royal flush', icon: 'RF' },
  straight_flush:  { name: 'Straight Flush', desc: 'Make a straight flush', icon: 'SF' },
  four_kind:       { name: 'Four of a Kind', desc: 'Make four of a kind', icon: '4K' },
  full_house:      { name: 'Full House', desc: 'Make a full house', icon: 'FH' },
  flush:           { name: 'Flush', desc: 'Make a flush', icon: 'FL' },
  all_in_5:        { name: 'All-in x5', desc: 'Go all-in 5 times', icon: 'A5' },
  all_in_20:       { name: 'All-in x20', desc: 'Go all-in 20 times', icon: 'A20' },
  big_pot:         { name: 'Big Pot', desc: 'Win a pot over 500', icon: 'P500' },
  huge_pot:        { name: 'Huge Pot', desc: 'Win a pot over 2000', icon: 'P2K' },
  play_50:         { name: 'Play 50', desc: 'Play 50 hands', icon: 'G50' },
  play_200:        { name: 'Play 200', desc: 'Play 200 hands', icon: 'G200' },
  win_streak_3:    { name: 'Win Streak 3', desc: 'Win 3 hands in a row', icon: 'S3' },
  win_streak_5:    { name: 'Win Streak 5', desc: 'Win 5 hands in a row', icon: 'S5' },
  comeback:        { name: 'Comeback', desc: 'Win back over 1000 from under 500', icon: 'CB' },
  bluff_master:    { name: 'Bluff Master', desc: 'Win with high card', icon: 'BM' },
  first_game:      { name: 'First Game', desc: 'Finish your first game', icon: 'G1' },
};

class UserStore {
  constructor() {
    this.users = new Map();  // username -> userData
    this.tokens = new Map(); // token -> username
    this.guestStats = new Map(); // guestId -> stats (in-memory only)
    this._load();
  }

  // ===== Persistence =====
  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const u of data) {
          this.users.set(u.username, u);
        }
        console.log(`[UserStore] Loaded ${this.users.size} users`);
      }
    } catch (err) {
      console.error('[UserStore] Load error:', err.message);
    }
  }

  _save() {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = [...this.users.values()];
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[UserStore] Save error:', err.message);
    }
  }

  _hashPassword(password) {
    return crypto.createHash('sha256').update(password + 'poker_salt_2024').digest('hex');
  }

  _generateToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  // ===== Registration =====
  register(username, password) {
    username = (username || '').trim();
    if (!username || username.length < 1 || username.length > 12) {
      return { error: 'Username must be 1-12 characters' };
    }
    if (!password || password.length < 4) {
      return { error: 'Password must be at least 4 characters' };
    }
    if (this.users.has(username)) {
      return { error: 'Username already registered' };
    }

    const user = {
      username,
      passwordHash: this._hashPassword(password),
      createdAt: Date.now(),
      lastLogin: Date.now(),
      avatar: 'A',  // Selected avatar emoji
      avatarColor: '#4fc3f7',  // Selected color
      stats: {
        handsPlayed: 0,
        handsWon: 0,
        totalWon: 0,
        totalLost: 0,
        biggestPot: 0,
        bestHand: '',
        bestHandRank: -1,
        allIns: 0,
        winStreak: 0,
        bestWinStreak: 0,
        currentStreak: 0,
      },
      achievements: [],
      gamesPlayed: 0,
    };

    this.users.set(username, user);
    const token = this._generateToken();
    this.tokens.set(token, username);
    this._save();

    return { token, username, profile: this._sanitize(user) };
  }

  // ===== Login =====
  login(username, password) {
    username = (username || '').trim();
    const user = this.users.get(username);
    if (!user) return { error: 'User not found' };
    if (user.passwordHash !== this._hashPassword(password)) {
      return { error: 'Incorrect password' };
    }

    user.lastLogin = Date.now();
    const token = this._generateToken();
    this.tokens.set(token, username);
    this._save();

    return { token, username, profile: this._sanitize(user) };
  }

  // ===== Token Validation =====
  validateToken(token) {
    if (!token) return null;
    const username = this.tokens.get(token);
    if (!username) return null;
    const user = this.users.get(username);
    if (!user) return null;
    return { username, profile: this._sanitize(user) };
  }

  // ===== Guest Mode =====
  createGuest(name) {
    const id = 'guest_' + crypto.randomBytes(4).toString('hex');
    const guest = {
      id,
      name: (name || 'Guest').slice(0, 12),
      isGuest: true,
      stats: {
        handsPlayed: 0, handsWon: 0, totalWon: 0,
      },
    };
    this.guestStats.set(id, guest);
    return guest;
  }

  // ===== Record Game Result =====
  recordGame(username, data) {
    const user = this.users.get(username);
    if (!user) return { newAchievements: [] };

    const s = user.stats;
    s.handsPlayed++;
    user.gamesPlayed = (user.gamesPlayed || 0) + 1;

    if (data.won) {
      s.handsWon++;
      s.totalWon += data.amount || 0;
      s.currentStreak = (s.currentStreak || 0) + 1;
      if (s.currentStreak > (s.bestWinStreak || 0)) {
        s.bestWinStreak = s.currentStreak;
      }
      if ((data.amount || 0) > s.biggestPot) {
        s.biggestPot = data.amount || 0;
      }
    } else {
      s.totalLost += data.amount || 0;
      s.currentStreak = 0;
    }

    if (data.allIn) s.allIns = (s.allIns || 0) + 1;

    if (data.handRank > s.bestHandRank) {
      s.bestHandRank = data.handRank;
      s.bestHand = data.handName || '';
    }

    // Check achievements
    const newAchievements = this._checkAchievements(user, data);
    this._save();

    return { newAchievements, profile: this._sanitize(user) };
  }


  // ===== Update Avatar =====
  updateAvatar(username, avatar, color) {
    const user = this.users.get(username);
    if (!user) return null;
    if (avatar) user.avatar = avatar;
    if (color) user.avatarColor = color;
    this._save();
    return { avatar: user.avatar, avatarColor: user.avatarColor };
  }

  // ===== Achievement Checking =====
  _checkAchievements(user, data) {
    const s = user.stats;
    const newOnes = [];

    function check(id, condition) {
      if (condition && !user.achievements.includes(id)) {
        user.achievements.push(id);
        newOnes.push({ id, ...ACHIEVEMENTS[id] });
      }
    }

    // Win-based
    check('first_win', data.won && s.handsWon >= 1);
    check('ten_wins', s.handsWon >= 10);
    check('fifty_wins', s.handsWon >= 50);
    check('hundred_wins', s.handsWon >= 100);

    // Hand type
    check('royal_flush', data.handRank === 9);
    check('straight_flush', data.handRank === 8);
    check('four_kind', data.handRank === 7);
    check('full_house', data.handRank === 6);
    check('flush', data.handRank === 5);

    // All-in
    check('all_in_5', s.allIns >= 5);
    check('all_in_20', s.allIns >= 20);

    // Pot size
    check('big_pot', data.won && data.amount >= 500);
    check('huge_pot', data.won && data.amount >= 2000);

    // Play count
    check('play_50', s.handsPlayed >= 50);
    check('play_200', s.handsPlayed >= 200);

    // Win streak
    check('win_streak_3', s.currentStreak >= 3);
    check('win_streak_5', s.currentStreak >= 5);

    // Comeback
    check('comeback', data.won && data.stackBefore < 500 && data.amount >= 1000);

    // Bluff master (won with high card)
    check('bluff_master', data.won && data.handRank === 0);

    // First game
    check('first_game', s.handsPlayed >= 1);

    return newOnes;
  }

  // ===== Get Profile =====
  getProfile(username) {
    const user = this.users.get(username);
    if (!user) return null;
    return this._sanitize(user);
  }

  // ===== Leaderboard =====
  getLeaderboard(sortBy = 'totalWon', limit = 20) {
    const list = [...this.users.values()];
    list.sort((a, b) => (b.stats[sortBy] || 0) - (a.stats[sortBy] || 0));
    return list.slice(0, limit).map((u, i) => ({
      rank: i + 1,
      name: u.username,
      handsPlayed: u.stats.handsPlayed,
      handsWon: u.stats.handsWon,
      winRate: u.stats.handsPlayed > 0 ? Math.round(u.stats.handsWon / u.stats.handsPlayed * 100) : 0,
      totalWon: u.stats.totalWon,
      biggestPot: u.stats.biggestPot,
      bestHand: u.stats.bestHand || '-',
      allIns: u.stats.allIns || 0,
      achievementCount: u.achievements.length,
    }));
  }

  // Remove private fields
  _sanitize(user) {
    return {
      username: user.username,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      avatar: user.avatar || 'A',
      avatarColor: user.avatarColor || '#4fc3f7',
      stats: { ...user.stats },
      achievements: user.achievements.map(id => ({ id, ...ACHIEVEMENTS[id] })),
      gamesPlayed: user.gamesPlayed || 0,
    };
  }

  // Get all achievement definitions
  static getAllAchievements() {
    return ACHIEVEMENTS;
  }
}

module.exports = { UserStore, ACHIEVEMENTS };
