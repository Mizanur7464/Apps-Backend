// This script is obsolete after migrating to PostgreSQL. No action needed.

// Node.js script to add 'status' column to spin_wheel_config if not exists
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('vouchers.sqlite');

db.serialize(() => {
  db.all("PRAGMA table_info(spin_wheel_config);", (err, columns) => {
    if (err) {
      console.error('Error reading table info:', err);
      db.close();
      return;
    }
    const hasStatus = columns.some(col => col.name === 'status');
    if (hasStatus) {
      console.log("'status' column already exists.");
      db.close();
      return;
    }
    db.run("ALTER TABLE spin_wheel_config ADD COLUMN status TEXT DEFAULT 'active';", (err) => {
      if (err) {
        console.error('Error adding status column:', err);
      } else {
        console.log("'status' column added successfully.");
      }
      db.close();
    });
  });
}); 