// backend/server.js
require("dotenv").config();
const session = require("express-session");
const cookieParser = require("cookie-parser");
const express = require("express");
const activeUsers = new Set();
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");
const sessionMiddleware = session({
  secret: "secret-key",
  resave: false,
  saveUninitialized: true,
  cookie: {
    sameSite: "none", // important for cross-origin
    secure: true
  }
});
const app = express();

const allowedOrigins = [
  "https://acrophobia-play.onrender.com",
  "http://localhost:3000"
];

app.use(cookieParser());
app.use(sessionMiddleware);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

// ✅ Create the HTTP server BEFORE passing it to Socket.IO
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by Socket.IO CORS"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});
io.engine.use(sessionMiddleware); 
// 1. First attach the session middleware
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
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
}

initDb().catch(console.error);

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


io.on("connection", (socket) => {

  socket.on("check_session", (callback) => {
  const session = socket.request.session;
  if (session && session.username) {
    callback({ authenticated: true, username: session.username });
  } else {
    callback({ authenticated: false });
  }
});

// ✅ Move this OUTSIDE of check_session
socket.on("login_cookie", ({ username }, callback) => {
  if (!username) return callback({ success: false });

  const session = socket.request.session;
  session.username = username;
  session.save();
  callback({ success: true, username });
});



 console.log("User connected:", socket.id);

  // Login event
  socket.on("login", async ({ username, password }, callback) => {
    activeUsers.add(username);
    console.log("Login received:", username);
    if (!username || !password) {
      return callback({ success: false, message: "Missing credentials" });
    }

    try {
      const res = await pool.query(
        `SELECT * FROM users WHERE username = $1 AND password = $2`,
        [username, password]
      );

      if (res.rows.length === 0) {
        return callback({ success: false, message: "Invalid credentials" });
      }

      socket.request.session.username = username;
      socket.request.session.save();
      callback({ success: true });

      // Optional: send stats if desired
      const stats = await pool.query(`SELECT * FROM user_stats WHERE username = $1`, [username]);
      if (stats.rows.length) {
        socket.emit("user_stats", stats.rows[0]);
      }

    } catch (err) {
      console.error("Login failed:", err);
      callback({ success: false, message: "Server error" });
    }
  });

  // Register event
  socket.on("register", async ({ username, email, password }, callback) => {
    try {
      const userCheck = await pool.query(
        `SELECT * FROM users WHERE username = $1 OR email = $2`,
        [username, email]
      );

      if (userCheck.rows.length > 0) {
        return callback({ success: false, message: "Username or email already exists" });
      }

      await pool.query(
        `INSERT INTO users (username, email, password) VALUES ($1, $2, $3)`,
        [username, email, password]
      );

      await pool.query(`INSERT INTO user_stats (username) VALUES ($1)`, [username]);

      socket.request.session.username = username;
      socket.request.session.save();
      activeUsers.add(username);
      callback({ success: true });

    } catch (err) {
      console.error("Registration error:", err);
      callback({ success: false, message: "Server error" });
    }
  });

socket.on("chat_message", ({ room, username, text }) => {
  io.to(room).emit("chat_message", { username, text });
});
  socket.on("join_room", ({ room }, callback) => {
  io.emit("room_list", getRoomStats());
  const session = socket.request.session;
  const username = session?.username;

  if (!username) {
    return callback?.({ success: false, message: "Unauthorized – not logged in" });
  }

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

  // Check if user is already in room
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

  if (r.players.length >= 2 && r.phase === "waiting") {
    startGame(room);
  }

  callback?.({ success: true });
});




 socket.on("submit_entry", ({ room, username, text }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  // ✅ Prevent duplicate submission from same user
  if (roomData.entries.find(e => e.username === username)) return;

  const id = `${Date.now()}-${Math.random()}`;
  const elapsed = Date.now() - roomData.roundStartTime;
  const entry = { id, username, text, time: Date.now(), elapsed };

  roomData.entries.push(entry);

  // ✅ Broadcast updated list of who has submitted
  const submittedUsernames = roomData.entries.map(e => e.username);
  emitToRoom(room, "submitted_users", submittedUsernames);

  socket.emit("entry_submitted", { id, text });

  // ✅ Emit updated entries to all (optional — frontend may not need this)
  io.to(room).emit("entries", roomData.entries);
});



  socket.on("vote_entry", ({ room, username, entryId }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  const entry = roomData.entries.find(e => e.id === entryId);
  if (!entry) return;

  // 🚫 Prevent voting for your own entry
  if (entry.username === username) {
    socket.emit("error_message", "You cannot vote for your own entry.");
    return;
  }

  roomData.votes[username] = entryId;
  socket.emit("vote_confirmed", entryId);
  io.to(room).emit("votes", roomData.votes);
});


  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    const username = socket.data?.username;
    if (username) activeUsers.delete(username); // ✅ REMOVE from active users
    // Remove player from room
  rooms[room].players = rooms[room].players.filter((p) => p.id !== socket.id);

  // Broadcast updated players
  emitToRoom(room, "players", rooms[room].players);

  // ✅ If no players are left, delete the room
  if (rooms[room].players.length === 0) {
    console.log(`Room ${room} is now empty. Deleting room.`);
    delete rooms[room];
    delete roomRounds?.[room]; // if using roomRounds
  }

  
  });

  
});
setInterval(() => {
  io.emit("active_users", Array.from(activeUsers));
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



































  

