import express from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 5001;

console.log('Server starting...');

app.use(cors());
app.use(bodyParser.json());

// Use /tmp/vouchers.sqlite on Render/Heroku, ./vouchers.sqlite locally
const dbPath = process.env.PORT ? '/tmp/vouchers.sqlite' : './vouchers.sqlite';
let db = new Database(dbPath);

console.log('Connected to SQLite database.');

// Create tables (drop if exist to wipe old data)
db.exec('DROP TABLE IF EXISTS referrals');
db.exec('DROP TABLE IF EXISTS vouchers');
db.exec('DROP TABLE IF EXISTS voucher_campaigns');
db.exec('DROP TABLE IF EXISTS spin_wheel_config');
db.exec('DROP TABLE IF EXISTS referral_rewards');

db.exec(`CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer TEXT NOT NULL,
  referred TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  value TEXT,
  prize TEXT,
  status TEXT,
  claimedAt TEXT
)`);
db.exec(`CREATE TABLE voucher_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE spin_wheel_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prize_label TEXT NOT NULL,
  win_chance REAL NOT NULL,
  campaign_id INTEGER,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES voucher_campaigns(id)
)`);
db.exec(`CREATE TABLE referral_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Add a new voucher (for grabbing)
app.post('/api/vouchers', async (req, res) => {
  const { username, value, prize, status, claimedAt, campaignId } = req.body;
  try {
    // If this is a campaign voucher, check quantity
    if (campaignId) {
      // Count how many vouchers have been claimed for this campaign
      const countRow = db.prepare('SELECT COUNT(*) as count FROM vouchers WHERE value = (SELECT content FROM voucher_campaigns WHERE id = ?)').get(campaignId);
      const campaign = db.prepare('SELECT * FROM voucher_campaigns WHERE id = ?').get(campaignId);
      if (countRow.count >= campaign.quantity) {
        return res.status(400).json({ error: 'Out of stock' });
      }
    }
    db.prepare('INSERT INTO vouchers (username, value, prize, status, claimedAt) VALUES (?, ?, ?, ?, ?)').run(username, value, prize, status, claimedAt);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-referrers', async (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT referrer, COUNT(*) as referrals
      FROM referrals
      GROUP BY referrer
      ORDER BY referrals DESC, referrer ASC
      LIMIT 10
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin APIs for dashboard ---
// Get all vouchers
app.get('/api/admin/vouchers', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM vouchers ORDER BY claimedAt DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all referrals
app.get('/api/admin/referrals', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM referrals ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all unique users (from vouchers and referrals)
app.get('/api/admin/users', async (req, res) => {
  try {
    const voucherUsers = db.prepare('SELECT DISTINCT username FROM vouchers WHERE username IS NOT NULL').all();
    const referrerUsers = db.prepare('SELECT DISTINCT referrer as username FROM referrals').all();
    const referredUsers = db.prepare('SELECT DISTINCT referred as username FROM referrals').all();
    // Combine and deduplicate
    const allUsers = [...voucherUsers, ...referrerUsers, ...referredUsers]
      .map(u => u.username)
      .filter(Boolean);
    const uniqueUsers = Array.from(new Set(allUsers));
    res.json(uniqueUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get vouchers for a specific user
app.get('/api/my-vouchers', async (req, res) => {
  const { username } = req.query;
  try {
    const rows = db.prepare('SELECT * FROM vouchers WHERE username = ?').all(username);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update voucher status by id
app.put('/api/voucher/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  try {
    if (status === 'Issued') {
      db.prepare('UPDATE vouchers SET status = ?, claimedAt = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    } else if (status === 'Void') {
      db.prepare('UPDATE vouchers SET status = ?, claimedAt = NULL WHERE id = ?').run(status, id);
    } else {
      db.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run(status, id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Voucher Campaigns ---
app.get('/api/admin/voucher-campaigns', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM voucher_campaigns ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/voucher-campaigns', async (req, res) => {
  const { content, quantity, status } = req.body;
  try {
    db.prepare('INSERT INTO voucher_campaigns (content, quantity, status) VALUES (?, ?, ?)').run(content, quantity, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Add DELETE endpoint for voucher campaigns
app.delete('/api/admin/voucher-campaigns/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = db.prepare('DELETE FROM voucher_campaigns WHERE id = ?').run(id);
    if (result.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Campaign not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Spin Wheel Config ---
app.get('/api/admin/spin-wheel', async (req, res) => {
  try {
    // Only return active prizes
    const rows = db.prepare("SELECT * FROM spin_wheel_config WHERE status = 'active' ORDER BY created_at DESC").all();
    // Get the latest created_at as config version
    let configVersion = null;
    if (rows.length > 0) {
      configVersion = rows[0].created_at;
    }
    res.json({ configVersion, prizes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/spin-wheel', async (req, res) => {
  const { prizes } = req.body; // prizes: [{prize_label, win_chance, campaign_id, status}]
  try {
    db.prepare('DELETE FROM spin_wheel_config').run();
    const now = new Date().toISOString();
    for (const prize of prizes) {
      db.prepare('INSERT INTO spin_wheel_config (prize_label, win_chance, campaign_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(prize.prize_label, prize.win_chance, prize.campaign_id || null, prize.status || 'active', now);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Referral Reward ---
app.get('/api/admin/referral-reward', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM referral_rewards ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/referral-reward', async (req, res) => {
  const { content, status } = req.body;
  try {
    db.prepare('INSERT INTO referral_rewards (content, status) VALUES (?, ?)').run(content, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- Admin: Referral Reward DELETE ---
app.delete('/api/admin/referral-reward/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = db.prepare('DELETE FROM referral_rewards WHERE id = ?').run(id);
    if (result.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Reward not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Spin Wheel Prize Status Update ---
app.put('/api/admin/spin-wheel/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  try {
    db.prepare('UPDATE spin_wheel_config SET status = ? WHERE id = ?').run(status, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get count of claimed vouchers for a campaign
app.get('/api/vouchers/count', async (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.json({ count: 0 });
  try {
    const campaign = db.prepare('SELECT * FROM voucher_campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.json({ count: 0 });
    const row = db.prepare('SELECT COUNT(*) as count FROM vouchers WHERE value = ?').get(campaign.content);
    res.json({ count: row.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});