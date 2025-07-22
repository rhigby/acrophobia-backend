// backend/server.js
require("dotenv").config();

const cookieParser = require("cookie-parser");
const express = require("express");
const activeUsers = new Map();
const userRooms = {}; // Track each user's current room
const roomRounds = {};
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

const userSockets = new Map();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://acrophobia-play.onrender.com",
    credentials: true
  }
});
app.use(cors({
  origin: "https://acrophobia-play.onrender.com",
  credentials: true
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.options("*", cors({
  origin: [
    "https://acrophobia-bhnj.onrender.com",
    "https://acrophobia-play.onrender.com"
  ],
  credentials: true
}));

app.use(cookieParser());
app.use(express.json());

app.get("/api/me", (req, res) => {
  const username = req.cookies?.acrophobia_user;
  if (username) {
    res.json({ username });
  } else {
    res.status(401).json({ error: "Not logged in" });
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
    callback(new Error("Invalid origin"));
  }
}

const messages = [];

app.post("/api/messages", express.json(), async (req, res) => {

 const username = req.cookies?.acrophobia_user || "Guest";
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
      reply_to: replyTo,
      replies: [] // ✅ Prevent frontend crashes
    };

    io.emit("new_message", message);
    res.status(201).json(message); // ✅ Optimistic update ready
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Database insert failed" });
  }
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

app.get("/api/stats", async (req, res) => {
  try {
    const totalPlayersRes = await pool.query("SELECT COUNT(*) FROM users");

    const gamesTodayRes = await pool.query(`
      SELECT COUNT(*) FROM user_stats 
      WHERE CURRENT_DATE = (SELECT CURRENT_DATE)
    `);

    const topPlayerRes = await pool.query(`
      SELECT username, total_points 
      FROM user_stats 
      ORDER BY total_points DESC 
      LIMIT 1
    `);

    const roomsLive = Object.keys(rooms).length;

    const topPlayerRaw = topPlayerRes.rows[0];
    const topPlayer = topPlayerRaw
      ? { name: topPlayerRaw.username, score: topPlayerRaw.total_points }
      : { name: "N/A", score: 0 };

    res.json({
      totalPlayers: parseInt(totalPlayersRes.rows[0].count, 10),
      gamesToday: parseInt(gamesTodayRes.rows[0].count, 10),
      topPlayer,
      roomsLive
    });
  } catch (err) {
    console.error("Failed to fetch stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function initDb() {
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

  await pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    username TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    reply_to INTEGER REFERENCES messages(id) ON DELETE CASCADE
  );
`);
}

initDb().catch(console.error);

function getActiveUserList() {
  return Array.from(activeUsers.entries()).map(([username, room]) => ({
    username,
    room
  }));
}
const rooms = {};
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 5;

function createAcronym(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function emitToRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

function startCountdown(roomId, seconds, onComplete) {
  let time = seconds;
  const interval = setInterval(() => {
    if (!rooms[roomId]) return clearInterval(interval);
    if (time <= 10) emitToRoom(roomId, "beep");
    emitToRoom(roomId, "countdown", time);
    time--;
    if (time < 0) {
      clearInterval(interval);
      onComplete();
    }
  }, 1000);
}

function revealAcronymLetters(roomId, acronym, callback) {
  let index = 0;
  const interval = setInterval(() => {
    if (!rooms[roomId]) return clearInterval(interval);

    // ✅ Emit the current portion of the acronym
    emitToRoom(roomId, "acronym", acronym.substring(0, index + 1));

    // ✅ Emit the letter sound (replaces original "beep")
    emitToRoom(roomId, "letter_beep");

    index++;

    if (index >= acronym.length) {
      clearInterval(interval);
      emitToRoom(roomId, "acronym_ready"); // Done revealing
      callback();
    }
  }, 2000);
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;
  console.log(`🚀 Starting game for room: ${roomId}`);
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
  emitToRoom(roomId, "players", room.players);

  revealAcronymLetters(roomId, room.acronym, () => {
    room.roundStartTime = Date.now();
    startCountdown(roomId, 60, () => startVoting(roomId));
  });
}

function startVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.phase = "vote";
  emitToRoom(roomId, "phase", "vote");
  const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);

for (const socketId of roomSockets) {
  const playerSocket = io.sockets.sockets.get(socketId);
  if (!playerSocket) continue;

  // Shuffle the entries uniquely for each socket
  const shuffledEntries = [...room.entries].sort(() => Math.random() - 0.5);

  playerSocket.emit("entries", shuffledEntries);
}

  startCountdown(roomId, 30, () => showResults(roomId));
}

async function saveUserStats(username, points, isWinner, isFastest, votedForWinner) {
  try {
    await pool.query(
      `INSERT INTO user_stats (username, games_played, total_points, total_wins, fastest_submission_ms, voted_for_winner_count)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE SET
         games_played = user_stats.games_played + 1,
         total_points = user_stats.total_points + EXCLUDED.total_points,
         total_wins = user_stats.total_wins + EXCLUDED.total_wins,
         fastest_submission_ms = LEAST(user_stats.fastest_submission_ms, EXCLUDED.fastest_submission_ms),
         voted_for_winner_count = user_stats.voted_for_winner_count + EXCLUDED.voted_for_winner_count;`,
      [username, points, isWinner ? 1 : 0, isFastest || 10000, votedForWinner ? 1 : 0]
    );
  } catch (err) {
    console.error("Failed to update user_stats:", err);
  }
}

// ... rest unchanged

function calculateAndEmitResults(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  for (const vote of Object.values(room.votes)) {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }

  let highestVotes = 0;
  let winningEntryId = null;
  const firstVoteEntry = room.entries.find(entry => voteCounts[entry.id]);

  for (const entry of room.entries) {
    const count = voteCounts[entry.id] || 0;
    if (!room.scores[entry.username]) room.scores[entry.username] = 0;
    room.scores[entry.username] += count;

    if (count > highestVotes) {
      highestVotes = count;
      winningEntryId = entry.id;
    }
  }

  if (firstVoteEntry) {
    room.scores[firstVoteEntry.username] += 3;
  }

  if (winningEntryId && highestVotes > 0) {
    const winnerEntry = room.entries.find(e => e.id === winningEntryId);
    if (winnerEntry) room.scores[winnerEntry.username] += 5;
  }

  const votersOfWinner = [];
  for (const [voter, entryId] of Object.entries(room.votes)) {
    if (entryId === winningEntryId) {
      if (!room.scores[voter]) room.scores[voter] = 0;
      room.scores[voter] += 1;
      votersOfWinner.push(voter);
    }
  }

  room.phase = "results";
  emitToRoom(roomId, "votes", voteCounts);
  emitToRoom(roomId, "scores", room.scores);
  emitToRoom(roomId, "highlight_results", {
    fastest: firstVoteEntry?.id,
    winner: winningEntryId,
    voters: votersOfWinner
  });
  emitToRoom(roomId, "results_metadata", {
  timestamps: room.entries.map(entry => ({
    id: entry.id,
    username: entry.username,
    text: entry.text,
    time: (entry.elapsed / 1000).toFixed(2)  // ✅ seconds with decimals
  }))
});
  emitToRoom(roomId, "phase", "results");

  for (const entry of room.entries) {
    const isWinner = entry.id === winningEntryId;
    const isFastest = firstVoteEntry && entry.id === firstVoteEntry.id;
    const votedForWinner = votersOfWinner.includes(entry.username);
    saveUserStats(entry.username, room.scores[entry.username], isWinner, isFastest ? entry.elapsed : null, votedForWinner);
  }
}

function showResults(roomId) {
  calculateAndEmitResults(roomId);

  startCountdown(roomId, 30, () => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.round < MAX_ROUNDS) {
      room.round++;
      emitToRoom(roomId, "phase", "next_round_overlay");
      emitToRoom(roomId, "round_number", room.round);
      setTimeout(() => runRound(roomId), 10000);
    } else {
      emitToRoom(roomId, "phase", "game_over");
      setTimeout(() => {
        room.phase = "waiting";
        room.round = 0;
        room.entries = [];
        room.votes = {};
        room.acronym = "";
        room.scores = {};
        emitToRoom(roomId, "phase", "waiting");
        emitToRoom(roomId, "players", room.players);
        if (room.players.length >= 2) {
          startGame(roomId);
        }
      }, 30000);
    }
  });
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

// ✅ Middleware to extract username from cookie
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie;
  if (!cookieHeader) return next();
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(c => {
      const [key, ...v] = c.trim().split("=");
      return [key, decodeURIComponent(v.join("="))];
    })
  );
  const username = cookies.acrophobia_user;
  if (username) {
    socket.data.username = username;
  }
  next();
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id, "user:", socket.data.username);
   socket.on("check_session", (callback) => {
    const username = extractUsernameFromSocket(socket);
    if (username) {
      callback({ authenticated: true, username });
    } else {
      callback({ authenticated: false });
    }
  });

  console.log("User connected:", socket.id);

  socket.on("whoami", (cb) => {
    const username = socket.data?.username;
    cb({ username });
  });


  socket.on("login", async ({ username, password }, callback) => {
  if (!username || !password) {
    return callback({ success: false, message: "Missing credentials" });
  }

  try {
    const userResult = await pool.query(
      `SELECT * FROM users WHERE username = $1 AND password = $2`,
      [username, password]
    );

    if (userResult.rows.length === 0) {
      return callback({ success: false, message: "Invalid credentials" });
    }

    // ✅ Set in-memory reference
    socket.data.username = username;
    userSockets.set(username, socket.id);
    activeUsers.set(username, "lobby");
    userRooms[username] = "lobby";

    // ✅ Notify all users of new login
    io.emit("active_users", getActiveUserList());

    // ✅ Send confirmation to client
    callback({ success: true });

    // Optionally send stats after login
    const statsRes = await pool.query(
      `SELECT * FROM user_stats WHERE username = $1`,
      [username]
    );

    if (statsRes.rows.length > 0) {
      socket.emit("user_stats", statsRes.rows[0]);
    }
  } catch (err) {
    console.error("Login error:", err);
    callback({ success: false, message: "Server error during login" });
  }
});


  socket.on("register", async ({ username, email, password }, callback) => {
  try {
    // Check if username or email already exists
    const userCheck = await pool.query(
      `SELECT * FROM users WHERE username = $1 OR email = $2`,
      [username, email]
    );

    if (userCheck.rows.length > 0) {
      return callback({ success: false, message: "Username or email already exists" });
    }

    // Insert new user
    await pool.query(
      `INSERT INTO users (username, email, password) VALUES ($1, $2, $3)`,
      [username, email, password]
    );

    // Create initial stats
    await pool.query(`INSERT INTO user_stats (username) VALUES ($1)`, [username]);

    // ✅ Set in-memory identity for socket
    socket.data.username = username;
    userSockets.set(username, socket.id);
    activeUsers.set(username, "lobby");
    userRooms[username] = "lobby";

    // Broadcast active users list
    io.emit("active_users", getActiveUserList());

    // Return success
    callback({ success: true });
  } catch (err) {
    console.error("Registration error:", err);
    callback({ success: false, message: "Server error" });
  }
});


  socket.on("private_message", ({ to, message }) => {
  const from = socket.data?.username;
  if (!from || !to || !message) {
    console.warn("❌ Missing fields in private_message:", { from, to, message });
    return;
  }

  const recipientSocketId = userSockets.get(to);

  const payload = {
    from,
    to,
    text: message,
    private: true
  };

  if (recipientSocketId) {
    io.to(recipientSocketId).emit("private_message", payload);
    socket.emit("private_message_ack", payload); // ✅ Acknowledge only if delivered
  } else {
    console.warn(`⚠️ Recipient ${to} not online.`);
  }
});


socket.on("chat_message", ({ room, text }) => {
  const username = socket.data?.username;
  if (!username || !text || !room) return;
  io.to(room).emit("chat_message", { username, text });
});

  socket.on("join_room", ({ room }, callback) => {
  io.emit("room_list", getRoomStats());

  const username = socket.data?.username;
  if (!username) {
    return callback?.({ success: false, message: "Unauthorized – not logged in" });
  }

  activeUsers.set(username, room);
  io.emit("active_users", getActiveUserList());

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

  r.players.push({ id: socket.id, username });

  emitToRoom(room, "players", r.players);

  if (r.players.length >= 2 && r.phase === "waiting") {
    startGame(room);
  }

  callback?.({ success: true });
});


  socket.on("submit_entry", ({ room, text }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  const username = socket.data?.username;
  if (!username || roomData.entries.find(e => e.username === username)) return;

  const id = `${Date.now()}-${Math.random()}`;
  const elapsed = Date.now() - roomData.roundStartTime;
  const entry = { id, username, text, time: Date.now(), elapsed };

  roomData.entries.push(entry);

  const submittedUsernames = roomData.entries.map(e => e.username);
  emitToRoom(room, "submitted_users", submittedUsernames);

  socket.emit("entry_submitted", { id, text });
  io.to(room).emit("entries", roomData.entries);
});


  socket.on("vote_entry", ({ room, entryId }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  const username = socket.data?.username;
  if (!username) return;

  const entry = roomData.entries.find(e => e.id === entryId);
  if (!entry) return;

  if (entry.username === username) {
    socket.emit("error_message", "You cannot vote for your own entry.");
    return;
  }

  roomData.votes[username] = entryId;
  socket.emit("vote_confirmed", entryId);
  io.to(room).emit("votes", roomData.votes);
});


socket.on("leave_room", () => {
    const room = socket.data?.room;
    const username = socket.data?.username;
    if (room && rooms[room]) {
      rooms[room].players = rooms[room].players.filter(p => p.id !== socket.id);
      emitToRoom(room, "players", rooms[room].players);
      socket.leave(room);
      socket.data.room = null;
      activeUsers.set(username, "lobby");
      io.emit("active_users", getActiveUserList());
    }
  });
  
  socket.on("disconnect", () => {
    const username = socket.data?.username;
    if (username) {
      userSockets.delete(username);
    }
    const room = socket.data?.room;

    if (username) {
      userRooms[username] = "lobby";
      activeUsers.set(username, "lobby");
    }

    if (room && rooms[room]) {
      rooms[room].players = rooms[room].players.filter((p) => p.id !== socket.id);
      emitToRoom(room, "players", rooms[room].players);

      if (rooms[room].players.length === 0) {
        console.log(`Room ${room} is now empty. Deleting room.`);
        delete rooms[room];
        delete roomRounds?.[room];
      }
    }

    io.emit("active_users", getActiveUserList());
  });
});

setInterval(() => {
  const userList = [];

  io.sockets.sockets.forEach((socket) => {
    const username = socket.data?.username;
    const room = socket.data?.room;
    if (username) {
      userList.push({
        username,
        room: room || "lobby"
      });
    }
  });

  io.emit("active_users", userList);
}, 5000);

setInterval(() => {
  const stats = {};
  for (const roomName in rooms) {
    stats[roomName] = {
      players: rooms[roomName].players.length,
      round: rooms[roomName].round || 0,
    };
  }
  io.emit("room_list", stats);
}, 1000);

server.listen(3001, () => console.log("✅ Acrophobia backend running on port 3001"));














































  

