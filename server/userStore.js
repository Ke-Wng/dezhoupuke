/**
 * User Store — JSON file-based persistence for user accounts, stats, and achievements
 * Supports registered users and guest players
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

// ===== Daily Check-in Rewards (by consecutive streak) =====
const CHECKIN_REWARDS = [
  { day: 1, chips: 50,  label: '第1天' },
  { day: 2, chips: 80,  label: '第2天' },
  { day: 3, chips: 100, label: '第3天' },
  { day: 4, chips: 150, label: '第4天' },
  { day: 5, chips: 200, label: '第5天' },
  { day: 6, chips: 300, label: '第6天' },
  { day: 7, chips: 500, label: '第7天 (满勤!)' },
];

// ===== Achievement Definitions =====
const ACHIEVEMENTS = {
  first_win:       { name: '初次胜利', desc: '赢得第一手牌', icon: '🏆' },
  ten_wins:        { name: '十胜将军', desc: '累计赢得10手牌', icon: '🎖️' },
  fifty_wins:      { name: '半百英雄', desc: '累计赢得50手牌', icon: '⭐' },
  hundred_wins:    { name: '百战百胜', desc: '累计赢得100手牌', icon: '💎' },
  royal_flush:     { name: '皇家降临', desc: '获得皇家同花顺', icon: '👑' },
  straight_flush:  { name: '同花顺子', desc: '获得同花顺', icon: '🌟' },
  four_kind:       { name: '四条天王', desc: '获得四条', icon: '🔥' },
  full_house:      { name: '葫芦娃', desc: '获得葫芦', icon: '🏠' },
  flush:           { name: '同花达人', desc: '获得同花', icon: '♠' },
  all_in_5:        { name: '全押狂人', desc: '累计All-in 5次', icon: '💰' },
  all_in_20:       { name: '赌神附体', desc: '累计All-in 20次', icon: '🎰' },
  big_pot:         { name: '大赢家', desc: '赢得超过500筹码的底池', icon: '💵' },
  huge_pot:        { name: '超级赢家', desc: '赢得超过2000筹码的底池', icon: '🤑' },
  play_50:         { name: '身经百战', desc: '累计打满50手牌', icon: '📊' },
  play_200:        { name: '牌桌老手', desc: '累计打满200手牌', icon: '🎓' },
  win_streak_3:    { name: '三连胜', desc: '连续赢得3手牌', icon: '🔥' },
  win_streak_5:    { name: '五连胜', desc: '连续赢得5手牌', icon: '⚡' },
  comeback:        { name: '绝地翻盘', desc: '筹码低于500时赢回超过1000', icon: '🔄' },
  bluff_master:    { name: '诈唬大师', desc: '用高牌赢下一手', icon: '🎭' },
  first_game:      { name: '初入江湖', desc: '完成第一局游戏', icon: '🃏' },
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
      return { error: '昵称需要1-12个字符' };
    }
    if (!password || password.length < 4) {
      return { error: '密码至少4个字符' };
    }
    if (this.users.has(username)) {
      return { error: '该昵称已被注册' };
    }

    const user = {
      username,
      passwordHash: this._hashPassword(password),
      createdAt: Date.now(),
      lastLogin: Date.now(),
      chips: 1000,  // Starting chips
      lastCheckin: null,  // Date string "YYYY-MM-DD"
      checkinStreak: 0,
      checkinHistory: [],  // Array of date strings
      avatar: '🦊',  // Selected avatar emoji
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
    if (!user) return { error: '用户不存在' };
    if (user.passwordHash !== this._hashPassword(password)) {
      return { error: '密码错误' };
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
      name: (name || '游客').slice(0, 12),
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

  // ===== Daily Check-in =====
  checkin(username) {
    const user = this.users.get(username);
    if (!user) return { error: '用户不存在' };

    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastCheckin = user.lastCheckin || '';

    if (lastCheckin === today) {
      return { error: '今天已经签到过了', alreadyCheckedIn: true, streak: user.checkinStreak || 0 };
    }

    // Calculate streak
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let streak = 0;
    if (lastCheckin === yesterday) {
      streak = (user.checkinStreak || 0) + 1;
    } else if (lastCheckin !== today) {
      streak = 1; // Reset streak if missed a day
    }
    if (streak > 7) streak = ((streak - 1) % 7) + 1; // Cycle through 7-day rewards

    // Get reward
    const reward = CHECKIN_REWARDS[Math.min(streak - 1, CHECKIN_REWARDS.length - 1)];

    // Apply
    user.chips = (user.chips || 1000) + reward.chips;
    user.lastCheckin = today;
    user.checkinStreak = streak;
    if (!user.checkinHistory) user.checkinHistory = [];
    user.checkinHistory.push(today);
    if (user.checkinHistory.length > 90) user.checkinHistory = user.checkinHistory.slice(-90); // Keep 90 days

    this._save();

    return {
      success: true,
      streak,
      reward: reward.chips,
      rewardLabel: reward.label,
      totalChips: user.chips,
      // Last 7 days for calendar display
      recentDays: CHECKIN_REWARDS.map((r, i) => ({
        day: r.day,
        chips: r.chips,
        label: r.label,
        completed: i < streak,
        current: i === streak - 1,
      })),
    };
  }

  // ===== Get Check-in Info (without performing checkin) =====
  getCheckinInfo(username) {
    const user = this.users.get(username);
    if (!user) return null;

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lastCheckin = user.lastCheckin || '';
    const alreadyCheckedIn = lastCheckin === today;

    let nextStreak = (user.checkinStreak || 0);
    if (lastCheckin === yesterday && !alreadyCheckedIn) nextStreak++;
    else if (!alreadyCheckedIn) nextStreak = 1;
    if (nextStreak > 7) nextStreak = ((nextStreak - 1) % 7) + 1;

    return {
      alreadyCheckedIn,
      streak: user.checkinStreak || 0,
      chips: user.chips || 1000,
      lastCheckin,
      recentDays: CHECKIN_REWARDS.map((r, i) => ({
        day: r.day,
        chips: r.chips,
        label: r.label,
        completed: alreadyCheckedIn ? i < (user.checkinStreak || 0) : false,
        current: alreadyCheckedIn ? i === (user.checkinStreak || 0) - 1 : false,
      })),
    };
  }

  // ===== Add/Remove Chips =====
  adjustChips(username, amount) {
    const user = this.users.get(username);
    if (!user) return false;
    user.chips = Math.max(0, (user.chips || 1000) + amount);
    this._save();
    return user.chips;
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
      chips: user.chips || 1000,
      lastCheckin: user.lastCheckin || null,
      checkinStreak: user.checkinStreak || 0,
      avatar: user.avatar || '🦊',
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
