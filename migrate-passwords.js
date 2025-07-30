require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const pool = new Pool({
  connectionString: 'postgresql://rhigby:BfI5vv9ku0VMqL9AMaRrthSgGPPmiZ9g@dpg-d1oqrjffte5s73blbq2g-a.oregon-postgres.render.com/acrophobia',
  ssl: { rejectUnauthorized: false }
});

async function migratePasswords() {
  try {
    // Get all users
    const result = await pool.query("SELECT username, password FROM users");
    const users = result.rows;

    for (const user of users) {
      const { username, password } = user;

      // If already hashed (starts with $2b$), skip
      if (password.startsWith("$2b$")) {
        console.log(`✅ [${username}] already hashed`);
        continue;
      }

      // Hash the plain-text password
      const hashed = await bcrypt.hash(password, 10);

      // Update DB
      await pool.query(
        "UPDATE users SET password = $1 WHERE username = $2",
        [hashed, username]
      );

      console.log(`🔐 Updated password for [${username}]`);
    }

    console.log("✅ Migration complete.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  }
}

migratePasswords();
