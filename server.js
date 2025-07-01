import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const MONGODB_URI = process.env.MONGODB_URI;

// CORS config: allow only frontend origins
const allowedOrigins = [
  'https://apps-frontend-pi.vercel.app',
  'https://apps-frontend-6pys1v3kd-mizanurs-projects-24e9ba9d.vercel.app',
  'https://apps-frontend-git-main-mizanurs-projects-24e9ba9d.vercel.app',
  'http://localhost:3000',
  'https://apps-frontend-pj4ygfytk-mizanurs-projects-24e9ba9d.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));
app.use(bodyParser.json());

let db, vouchers, referrals, voucher_campaigns, spin_wheel_config, referral_rewards, spin_wheel_active;

async function main() {
  const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db();
  vouchers = db.collection('vouchers');
  referrals = db.collection('referrals');
  voucher_campaigns = db.collection('voucher_campaigns');
  spin_wheel_config = db.collection('spin_wheel_config');
  referral_rewards = db.collection('referral_rewards');
  spin_wheel_active = db.collection('spin_wheel_active');
  console.log('Connected to MongoDB');

  // Add a new voucher (for grabbing)
  app.post('/api/vouchers', async (req, res) => {
    const { username, value, prize, status, claimedAt, campaignId } = req.body;
    try {
      if (campaignId) {
        const campaign = await voucher_campaigns.findOne({ _id: new ObjectId(campaignId) });
        if (!campaign) return res.status(400).json({ error: 'Campaign not found' });
        const count = await vouchers.countDocuments({ value: campaign.content });
        if (count >= campaign.quantity) {
          return res.status(400).json({ error: 'Out of stock' });
        }
      }
      await vouchers.insertOne({ username, value, prize, status, claimedAt });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/top-referrers', async (req, res) => {
    try {
      const rows = await referrals.aggregate([
        { $group: { _id: '$referrer', referrals: { $sum: 1 } } },
        { $sort: { referrals: -1, _id: 1 } },
        { $limit: 10 },
        { $project: { referrer: '$_id', referrals: 1, _id: 0 } }
      ]).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Admin APIs for dashboard ---
  app.get('/api/admin/vouchers', async (req, res) => {
    try {
      const rows = await vouchers.find({}).sort({ claimedAt: -1 }).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/referrals', async (req, res) => {
    try {
      const rows = await referrals.find({}).sort({ created_at: -1 }).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/users', async (req, res) => {
    try {
      const voucherUsers = await vouchers.distinct('username', { username: { $ne: null } });
      const referrerUsers = await referrals.distinct('referrer');
      const referredUsers = await referrals.distinct('referred');
      const allUsers = [...voucherUsers, ...referrerUsers, ...referredUsers].filter(Boolean);
      const uniqueUsers = Array.from(new Set(allUsers));
      res.json(uniqueUsers);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/my-vouchers', async (req, res) => {
    const { username } = req.query;
    try {
      const rows = await vouchers.find({ username }).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/voucher/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    try {
      let update = { status };
      if (status === 'Issued') update.claimedAt = new Date().toISOString();
      if (status === 'Void') update.claimedAt = null;
      const result = await vouchers.updateOne({ _id: new ObjectId(id) }, { $set: update });
      res.json({ success: result.modifiedCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Admin: Voucher Campaigns ---
  app.get('/api/admin/voucher-campaigns', async (req, res) => {
    try {
      const rows = await voucher_campaigns.find({}).sort({ created_at: -1 }).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/admin/voucher-campaigns', async (req, res) => {
    const { content, quantity, status } = req.body;
    try {
      await voucher_campaigns.insertOne({ content, quantity, status, created_at: new Date().toISOString() });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete('/api/admin/voucher-campaigns/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await voucher_campaigns.deleteOne({ _id: new ObjectId(id) });
      res.json({ success: result.deletedCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Admin: Spin Wheel Config ---
  app.get('/api/admin/spin-wheel', async (req, res) => {
    try {
      // Return ALL configs, not just active
      const rows = await spin_wheel_config.find({}).sort({ created_at: -1 }).toArray();
      let configVersion = null;
      if (rows.length > 0) configVersion = rows[0].created_at;
      res.json({ configVersion, prizes: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/admin/spin-wheel', async (req, res) => {
    const { prizes } = req.body;
    try {
      await spin_wheel_config.deleteMany({});
      const now = new Date().toISOString();
      const docs = prizes.map(prize => ({ ...prize, created_at: now, status: prize.status || 'active' }));
      await spin_wheel_config.insertMany(docs);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.put('/api/admin/spin-wheel/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    try {
      const result = await spin_wheel_config.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
      res.json({ success: result.modifiedCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Admin: Referral Reward ---
  app.get('/api/admin/referral-reward', async (req, res) => {
    try {
      const rows = await referral_rewards.find({}).sort({ created_at: -1 }).toArray();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/admin/referral-reward', async (req, res) => {
    const { content, status } = req.body;
    try {
      await referral_rewards.insertOne({ content, status, created_at: new Date().toISOString() });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete('/api/admin/referral-reward/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await referral_rewards.deleteOne({ _id: new ObjectId(id) });
      res.json({ success: result.deletedCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get count of claimed vouchers for a campaign
  app.get('/api/vouchers/count', async (req, res) => {
    const { campaignId } = req.query;
    if (!campaignId) return res.json({ count: 0 });
    try {
      const campaign = await voucher_campaigns.findOne({ _id: new ObjectId(campaignId) });
      if (!campaign) return res.json({ count: 0 });
      const count = await vouchers.countDocuments({ value: campaign.content });
      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a voucher by id
  app.delete('/api/admin/vouchers/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await vouchers.deleteOne({ _id: new ObjectId(id) });
      res.json({ success: result.deletedCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Spin Wheel: Set active config (Start)
  app.post('/api/admin/spin-wheel/:id/start', async (req, res) => {
    const { id } = req.params;
    try {
      await spin_wheel_active.deleteMany({}); // Only one active at a time
      await spin_wheel_active.insertOne({ activeSpinConfigId: new ObjectId(id) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // --- Spin Wheel: Unset active config (Stop)
  app.post('/api/admin/spin-wheel/stop', async (req, res) => {
    try {
      await spin_wheel_active.deleteMany({});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Spin Wheel: Get active config for users
  app.get('/api/spin-wheel/active', async (req, res) => {
    try {
      const prizes = await spin_wheel_config.find({ status: 'active' }).toArray();
      if (!prizes || prizes.length === 0) {
        // Return default rewards if no active config
        return res.json({
          activeSpinConfigId: null,
          prizes: [
            { prize_label: "Better luck next time", win_chance: 100 },
            { prize_label: "Try again", win_chance: 0 }
          ]
        });
      }
      res.json({ activeSpinConfigId: prizes[0]._id, prizes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Spin Wheel: Start all configs (campaign)
  app.post('/api/admin/spin-wheel/start', async (req, res) => {
    try {
      await spin_wheel_config.updateMany({}, { $set: { status: 'active' } });
      res.json({ success: true, message: "Spin is now started. Admin rewards are active." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // --- Spin Wheel: Stop all configs (campaign)
  app.post('/api/admin/spin-wheel/stop', async (req, res) => {
    try {
      await spin_wheel_config.updateMany({}, { $set: { status: 'inactive' } });
      res.json({ success: true, message: "Spin is now stopped. Default rewards will be shown." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});