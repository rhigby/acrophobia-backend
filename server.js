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

app.get("/api/me", (req, res) => {
  if (req.session?.username) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});

const bcrypt = require("bcrypt");

// Register user
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hashed]
    );

    // Initialize session
    req.session.username = username;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Failed to save session" });
      res.json({ success: true });
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "User already exists or DB error" });
  }
});

// Login user
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing credentials" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.username = username;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Failed to save session" });
      res.json({ success: true });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "DB error" });
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

const io = new Server(server, {
  cors: {
    origin: safeOriginCheck,
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

function createAcronym(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function emitToRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

function getRoomStats() {
  const stats = {};
  for (const roomName in rooms) {
    stats[roomName] = {
      players: rooms[roomName].players.length,
      round: rooms[roomName].round || 0,
    };
  }
  return stats;
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;
  room.round = 1;
  room.scores = {};
  runRound(roomId);
}

function runRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.phase = "submit";
  room.entries = [];
  room.votes = {};
  room.acronym = createAcronym(room.round + 2);
  room.roundStartTime = Date.now();
  emitToRoom(roomId, "round_number", room.round);
  emitToRoom(roomId, "phase", room.phase);
  emitToRoom(roomId, "acronym", room.acronym);
  emitToRoom(roomId, "letter_beep");
  setTimeout(() => emitToRoom(roomId, "acronym_ready"), 2000);
  setTimeout(() => startVoting(roomId), 60000);
}

function startVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.phase = "vote";
  emitToRoom(roomId, "phase", "vote");
  const shuffled = [...room.entries].sort(() => Math.random() - 0.5);
  emitToRoom(roomId, "entries", shuffled);
  setTimeout(() => showResults(roomId), 30000);
}

function showResults(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.phase = "results";
  const voteCounts = {};
  const voteTimestamps = [];
  for (const [user, entryId] of Object.entries(room.votes)) {
    voteCounts[entryId] = (voteCounts[entryId] || 0) + 1;
    const entry = room.entries.find((e) => e.id === entryId);
    if (entry) {
      voteTimestamps.push({ id: entryId, username: entry.username, time: (entry.elapsed || 0) / 1000 });
    }
  }
  const sortedEntries = room.entries.sort((a, b) => voteCounts[b.id] - voteCounts[a.id]);
  const winner = sortedEntries[0]?.id;
  const fastest = [...room.entries].sort((a, b) => a.elapsed - b.elapsed)[0]?.id;
  const votersForWinner = Object.entries(room.votes)
    .filter(([_, entryId]) => entryId === winner)
    .map(([voter]) => voter);
  emitToRoom(roomId, "votes", voteCounts);
  emitToRoom(roomId, "phase", "results");
  emitToRoom(roomId, "highlight_results", { winner, fastest, voters: votersForWinner });
  emitToRoom(roomId, "results_metadata", { timestamps: voteTimestamps });

  if (room.round < MAX_ROUNDS) {
    room.round++;
    emitToRoom(roomId, "phase", "next_round_overlay");
    setTimeout(() => runRound(roomId), 10000);
  } else {
    emitToRoom(roomId, "phase", "game_over");
  }
}

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

  socket.on("login_cookie", ({ username }, callback) => {
    if (!username) return callback({ success: false });
    socket.request.session.username = username;
    socket.request.session.save();
    socket.data.username = username;
    userSockets.set(username, socket.id);
    activeUsers.set(username, "lobby");
    userRooms[username] = "lobby";
    io.emit("active_users", Array.from(activeUsers.entries()).map(([u, r]) => ({ username: u, room: r })));
    callback({ success: true });
  });

  socket.on("join_room", ({ room }, callback) => {
    const session = socket.request.session;
    const username = session?.username;
    if (!username) return callback?.({ success: false, message: "Unauthorized – not logged in" });

    if (!rooms[room]) {
      rooms[room] = {
        players: [],
        scores: {},
        phase: "waiting",
        round: 0,
        entries: [],
        votes: {},
        acronym: ""
      };
    }

    const r = rooms[room];
    if (r.players.find(p => p.username === username)) {
      return callback?.({ success: false, message: "User already in room" });
    }

    if (r.players.length >= MAX_PLAYERS) {
      return callback?.({ success: false, message: "Room is full" });
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.username = username;
    r.players.push({ id: socket.id, username });

    emitToRoom(room, "players", r.players);
    callback?.({ success: true });

    if (r.players.length >= 2 && r.phase === "waiting") {
      startGame(room);
    }
  });

  socket.on("submit_entry", ({ room, username, text }) => {
    const roomData = rooms[room];
    if (!roomData) return;
    if (roomData.entries.find(e => e.username === username)) return;
    const id = `${Date.now()}-${Math.random()}`;
    const elapsed = Date.now() - roomData.roundStartTime;
    const entry = { id, username, text, time: Date.now(), elapsed };
    roomData.entries.push(entry);
    const submittedUsernames = roomData.entries.map(e => e.username);
    emitToRoom(room, "submitted_users", submittedUsernames);
    socket.emit("entry_submitted", { id, text });
    io.to(room).emit("entries", roomData.entries);
  });

  socket.on("vote_entry", ({ room, username, entryId }) => {
    const roomData = rooms[room];
    if (!roomData) return;
    const entry = roomData.entries.find(e => e.id === entryId);
    if (!entry || entry.username === username) return;
    roomData.votes[username] = entryId;
    socket.emit("vote_confirmed", entryId);
    io.to(room).emit("votes", roomData.votes);
  });

  socket.on("private_message", ({ to, message }) => {
    const from = socket.data.username;
    const toSocketId = userSockets.get(to);
    if (toSocketId) {
      io.to(toSocketId).emit("private_message", { from, to, text: message });
      socket.emit("private_message_ack", { from, to, text: message });
    }
  });

  socket.on("leave_room", () => {
    const room = socket.data.room;
    const username = socket.data.username;
    if (room && rooms[room]) {
      rooms[room].players = rooms[room].players.filter((p) => p.username !== username);
      socket.leave(room);
      emitToRoom(room, "players", rooms[room].players);
      if (rooms[room].players.length === 0) {
        delete rooms[room];
      }
    }
  });

  socket.on("disconnect", () => {
    const username = socket.data?.username;
    if (username) {
      userSockets.delete(username);
      activeUsers.set(username, "lobby");
    }
    const room = socket.data?.room;
    if (room && rooms[room]) {
      rooms[room].players = rooms[room].players.filter((p) => p.id !== socket.id);
      emitToRoom(room, "players", rooms[room].players);
      if (rooms[room].players.length === 0) {
        delete rooms[room];
      }
    }
    io.emit("active_users", Array.from(activeUsers.entries()).map(([u, r]) => ({ username: u, room: r })));
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

server.listen(3001, () => console.log("✅ Unified Acrophobia backend with full gameplay running on port 3001"));







































  

