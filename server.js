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
    sameSite: "none",
    secure: true,
    domain: ".onrender.com",
    path: "/"
  }
});

const allowedOrigins = [
  "https://acrophobia-play.onrender.com",
  "https://acrophobia-bhnj.onrender.com",
  "http://localhost:5173"
];

function safeOriginCheck(origin, callback) {
  if (!origin) return callback(null, true);
  try {
    const parsedOrigin = new URL(origin).origin;
    if (allowedOrigins.includes(parsedOrigin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  } catch (err) {
    console.warn("Invalid origin format:", origin);
    callback(new Error("Invalid origin"));
  }
}

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());

// API Routes
app.get("/api/me", (req, res) => {
  if (req.session?.username) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: "Not logged in" });
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
  const result = await pool.query("SELECT * FROM messages ORDER BY timestamp DESC");
  const messages = result.rows;
  const topLevel = messages.filter(m => !m.reply_to);
  const repliesMap = {};
  for (const m of messages) {
    if (m.reply_to) {
      if (!repliesMap[m.reply_to]) repliesMap[m.reply_to] = [];
      repliesMap[m.reply_to].push(m);
    }
  }
  const attachReplies = msg => ({ ...msg, replies: repliesMap[msg.id] || [] });
  res.json(topLevel.map(attachReplies));
});

app.post("/api/messages", async (req, res) => {
  const { title, content, replyTo } = req.body;
  const username = req.session?.username || "Guest";
  const result = await pool.query(
    `INSERT INTO messages (title, content, username, reply_to) VALUES ($1, $2, $3, $4) RETURNING *`,
    [title, content, username, replyTo || null]
  );
  const msg = result.rows[0];
  io.emit("new_message", msg);
  res.status(201).json({ success: true });
});

app.put("/api/messages/:id", async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  await pool.query("UPDATE messages SET title = $1, content = $2 WHERE id = $3", [title, content, id]);
  res.json({ success: true });
});

app.delete("/api/messages/:id", async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM messages WHERE id = $1", [id]);
  res.json({ success: true });
});

app.post("/api/messages/:id/like", async (req, res) => {
  const { id } = req.params;
  await pool.query("UPDATE messages SET likes = COALESCE(likes, 0) + 1 WHERE id = $1", [id]);
  res.json({ success: true });
});

const io = new Server(server, {
  cors: {
    origin: safeOriginCheck,
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("check_session", (callback) => {
    const session = socket.request.session;
    if (session?.username) {
      callback({ authenticated: true, username: session.username });
    } else {
      callback({ authenticated: false });
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      username TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      reply_to INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      likes INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stats (
      username TEXT PRIMARY KEY REFERENCES users(username),
      total_points INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      voted_for_winner_count INTEGER DEFAULT 0,
      fastest_submission_ms INTEGER
    );
  `);
}

initDb();

server.listen(3001, () => console.log("✅ Unified Acrophobia backend running on port 3001"));




































  

