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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  }
});

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

app.get("/api/me", (req, res) => {
  if (req.session?.username) {
    return res.json({ username: req.session.username });
  } else {
    return res.status(401).json({ error: "Not logged in" });
  }
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
    await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hash]
    );
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

    const attachReplies = (msg) => ({
      ...msg,
      replies: repliesMap[msg.id] || []
    });

    res.json(topLevel.map(attachReplies));
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/api/messages", async (req, res) => {
  const username = req.session?.username || "Guest";
  const { title, content, replyTo = null } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO messages (title, content, username, reply_to) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, timestamp`,
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
    const gamesTodayRes = await pool.query(
      `SELECT COUNT(*) FROM user_stats WHERE CURRENT_DATE = CURRENT_DATE`
    );
    const top10Daily = await pool.query(
      `SELECT username, total_points FROM user_stats ORDER BY total_points DESC LIMIT 10`
    );

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

io.on("connection", (socket) => {
  const req = socket.request;
  const username = req.session?.username || null;

  if (username) {
    activeUsers.set(username, socket.id);
    userSockets.set(socket.id, username);
  }

  const broadcastUsers = () => {
    const users = [...activeUsers.keys()].map(u => ({ username: u, room: userRooms[u] || null }));
    io.emit("active_users", users);
  };

  broadcastUsers();

  socket.on("join_room", ({ room }) => {
    if (rooms[room]?.length >= MAX_PLAYERS) {
      socket.emit("room_full");
      return;
    }
    socket.join(room);
    userRooms[username] = room;
    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].includes(username)) {
      rooms[room].push(username);
    }
    io.to(room).emit("players", rooms[room].map(name => ({ username: name })));
    broadcastUsers();
  });

  socket.on("leave_room", () => {
    const room = userRooms[username];
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u !== username);
      io.to(room).emit("players", rooms[room].map(name => ({ username: name })));
    }
    delete userRooms[username];
    socket.leave(room);
    broadcastUsers();
  });

  socket.on("chat_message", ({ room, text }) => {
    io.to(room).emit("chat_message", { username, text });
  });

  socket.on("private_message", ({ to, message }) => {
    if (!username) return;
    const targetSocketId = activeUsers.get(to);
    const payload = { from: username, to, text: message };
    if (targetSocketId) {
      io.to(targetSocketId).emit("private_message", payload);
    }
    socket.emit("private_message_ack", payload);
  });

  socket.on("disconnect", () => {
    activeUsers.delete(username);
    userSockets.delete(socket.id);
    const room = userRooms[username];
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u !== username);
      io.to(room).emit("players", rooms[room].map(name => ({ username: name })));
    }
    delete userRooms[username];
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});










































  

