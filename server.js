// backend/server.js
require("dotenv").config();
const session = require("express-session");
const cookieParser = require("cookie-parser");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");

const activeUsers = new Map();
const userSockets = new Map();
const userRooms = {};
const rooms = {};
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const sessionMiddleware = session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: "secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    domain: process.env.NODE_ENV === "production" ? ".onrender.com" : undefined,
    path: "/"
  }
});

const allowedOrigins = [
  "https://acrophobia-play.onrender.com",
  "https://acrophobia-bhnj.onrender.com",
  "http://localhost:5173"
];

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true
  }
});

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

app.get("/api/me", (req, res) => {
  console.log("SESSION CHECK:", req.session);
  if (req.session?.username) {
    return res.json({ username: req.session.username });
  } else {
    return res.status(401).json({ error: "Not logged in" });
  }
});

app.get("/api/debug-session", (req, res) => {
  res.json({
    username: req.session.username || null,
    cookie: req.headers.cookie || "no cookie header",
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
  const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  if (result.rows.length === 0) return res.status(401).json({ error: "Invalid login" });
  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid password" });
  req.session.username = username;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: "Session save failed" });
    res.json({ success: true });
  });
});

app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, email, password) VALUES ($1, $2, $3)", [username, email, hash]);
    await pool.query("INSERT INTO user_stats (username) VALUES ($1)", [username]);
    req.session.username = username;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: "Session save failed" });
      res.json({ success: true });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login-cookie", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });
  req.session.username = username;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: "Failed to save session" });
    res.json({ success: true });
  });
});

app.get("/api/messages", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM messages ORDER BY timestamp DESC`);
    const allMessages = result.rows;
    const topLevel = allMessages.filter(m => !m.reply_to);
    const repliesMap = {};
    for (const msg of allMessages) {
      if (msg.reply_to) {
        if (!repliesMap[msg.reply_to]) repliesMap[msg.reply_to] = [];
        repliesMap[msg.reply_to].push(msg);
      }
    }
    const attachReplies = (msg) => ({ ...msg, replies: repliesMap[msg.id] || [] });
    res.json(topLevel.map(attachReplies));
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/api/messages", async (req, res) => {
  const username = req.session?.username || "Guest";
  const { title, content, replyTo = null } = req.body;
  if (!title || !content) return res.status(400).json({ error: "Missing fields" });
  try {
    const result = await pool.query(
      `INSERT INTO messages (title, content, username, reply_to) VALUES ($1, $2, $3, $4) RETURNING id, timestamp`,
      [title, content, username, replyTo]
    );
    const message = {
      id: result.rows[0].id,
      title,
      content,
      username,
      timestamp: result.rows[0].timestamp,
      reply_to: replyTo
    };
    io.emit("new_message", message);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Database insert failed" });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const totalPlayersRes = await pool.query("SELECT COUNT(*) FROM users");
    const gamesTodayRes = await pool.query(`SELECT COUNT(*) FROM user_stats WHERE CURRENT_DATE = CURRENT_DATE`);
    const top10Daily = await pool.query(`SELECT username, total_points FROM user_stats ORDER BY total_points DESC LIMIT 10`);
    const roomsLive = Object.keys(rooms).length;
    res.json({
      totalPlayers: parseInt(totalPlayersRes.rows[0].count, 10),
      gamesToday: parseInt(gamesTodayRes.rows[0].count, 10),
      roomsLive,
      top10Daily: top10Daily.rows,
      top10Weekly: top10Daily.rows
    });
  } catch (err) {
    console.error("Failed to fetch stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Full gameplay logic merged:
const { wireGameLogic } = require("./game-logic");
wireGameLogic(io, pool, activeUsers, userSockets, userRooms, rooms);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});












































  

