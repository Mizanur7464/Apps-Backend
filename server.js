import express from 'express';
import sqlite3 from 'sqlite3';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(bodyParser.json());

// Use /tmp/vouchers.sqlite on Heroku, ./vouchers.sqlite locally
const dbPath = process.env.PORT ? '/tmp/vouchers.sqlite' : './vouchers.sqlite';
let db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Create tables (drop if exist to wipe old data)
db.serialize(() => {
  db.run('DROP TABLE IF EXISTS referrals');
  db.run('DROP TABLE IF EXISTS vouchers');
  db.run('DROP TABLE IF EXISTS voucher_campaigns');
  db.run('DROP TABLE IF EXISTS spin_wheel_config');
  db.run('DROP TABLE IF EXISTS referral_rewards');

  db.run(`CREATE TABLE referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer TEXT NOT NULL,
    referred TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    value TEXT,
    prize TEXT,
    status TEXT,
    claimedAt TEXT
  )`);
  db.run(`CREATE TABLE voucher_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE spin_wheel_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize_label TEXT NOT NULL,
    win_chance REAL NOT NULL,
    campaign_id INTEGER,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES voucher_campaigns(id)
  )`);
  db.run(`CREATE TABLE referral_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Helper functions for query (to match sqlite's db.get/db.all/db.run)
function dbGet(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function dbRun(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Add a new voucher (for grabbing)
app.post('/api/vouchers', async (req, res) => {
  const { username, value, prize, status, claimedAt, campaignId } = req.body;
  try {
    // If this is a campaign voucher, check quantity
    if (campaignId) {
      // Count how many vouchers have been claimed for this campaign
      const countRow = await dbGet('SELECT COUNT(*) as count FROM vouchers WHERE value = (SELECT content FROM voucher_campaigns WHERE id = $1)', [campaignId]);
      const campaign = await dbGet('SELECT * FROM voucher_campaigns WHERE id = $1', [campaignId]);
      if (countRow.count >= campaign.quantity) {
        return res.status(400).json({ error: 'Out of stock' });
      }
    }
    await dbRun('INSERT INTO vouchers (username, value, prize, status, claimedAt) VALUES ($1, $2, $3, $4, $5)', [username, value, prize, status, claimedAt]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-referrers', async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT referrer, COUNT(*) as referrals
      FROM referrals
      GROUP BY referrer
      ORDER BY referrals DESC, referrer ASC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin APIs for dashboard ---
// Get all vouchers
app.get('/api/admin/vouchers', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM vouchers ORDER BY claimedAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all referrals
app.get('/api/admin/referrals', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM referrals ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all unique users (from vouchers and referrals)
app.get('/api/admin/users', async (req, res) => {
  try {
    const voucherUsers = await dbAll('SELECT DISTINCT username FROM vouchers WHERE username IS NOT NULL');
    const referrerUsers = await dbAll('SELECT DISTINCT referrer as username FROM referrals');
    const referredUsers = await dbAll('SELECT DISTINCT referred as username FROM referrals');
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
    const rows = await dbAll('SELECT * FROM vouchers WHERE username = $1', [username]);
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
      await dbRun('UPDATE vouchers SET status = $1, claimedAt = $2 WHERE id = $3', [status, new Date().toISOString(), id]);
    } else if (status === 'Void') {
      await dbRun('UPDATE vouchers SET status = $1, claimedAt = NULL WHERE id = $2', [status, id]);
    } else {
      await dbRun('UPDATE vouchers SET status = $1 WHERE id = $2', [status, id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Voucher Campaigns ---
app.get('/api/admin/voucher-campaigns', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM voucher_campaigns ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/voucher-campaigns', async (req, res) => {
  const { content, quantity, status } = req.body;
  try {
    await dbRun('INSERT INTO voucher_campaigns (content, quantity, status) VALUES ($1, $2, $3)', [content, quantity, status]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Add DELETE endpoint for voucher campaigns
app.delete('/api/admin/voucher-campaigns/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dbRun('DELETE FROM voucher_campaigns WHERE id = $1', [id]);
    if (result.rowCount > 0) {
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
    const rows = await dbAll("SELECT * FROM spin_wheel_config WHERE status = 'active' ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/spin-wheel', async (req, res) => {
  const { prizes } = req.body; // prizes: [{prize_label, win_chance, campaign_id, status}]
  try {
    await dbRun('DELETE FROM spin_wheel_config');
    for (const prize of prizes) {
      await dbRun('INSERT INTO spin_wheel_config (prize_label, win_chance, campaign_id, status) VALUES ($1, $2, $3, $4)', [prize.prize_label, prize.win_chance, prize.campaign_id || null, prize.status || 'active']);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Referral Reward ---
app.get('/api/admin/referral-reward', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM referral_rewards ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/referral-reward', async (req, res) => {
  const { content, status } = req.body;
  try {
    await dbRun('INSERT INTO referral_rewards (content, status) VALUES ($1, $2)', [content, status]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- Admin: Referral Reward DELETE ---
app.delete('/api/admin/referral-reward/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dbRun('DELETE FROM referral_rewards WHERE id = $1', [id]);
    if (result.rowCount > 0) {
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
    await dbRun('UPDATE spin_wheel_config SET status = $1 WHERE id = $2', [status, id]);
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
    const campaign = await dbGet('SELECT * FROM voucher_campaigns WHERE id = $1', [campaignId]);
    if (!campaign) return res.json({ count: 0 });
    const row = await dbGet('SELECT COUNT(*) as count FROM vouchers WHERE value = $1', [campaign.content]);
    res.json({ count: row.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});