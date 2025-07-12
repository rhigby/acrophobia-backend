// backend/server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors({
  origin: "https://acrophobia-play.onrender.com",
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://acrophobia-play.onrender.com",
    methods: ["GET", "POST"]
  }
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
    emitToRoom(roomId, "acronym", acronym.substring(0, index + 1));
    emitToRoom(roomId, "beep");
    index++;
    if (index >= acronym.length) {
      clearInterval(interval);
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
    startCountdown(roomId, 60, () => startVoting(roomId));
  });
}

function startVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.phase = "vote";
  emitToRoom(roomId, "phase", "vote");
  emitToRoom(roomId, "entries", room.entries);

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
      time: (entry.elapsed / 1000).toFixed(2)
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

io.on("connection", (socket) => {

  socket.on("join_room", ({ room, username }) => {
  if (!rooms[room]) {
    rooms[room] = {
      players: [],
      scores: {},
      phase: "waiting",   // <-- must be set to allow game start
      round: 0,
      entries: [],
      votes: {},
      acronym: ""
    };
  }

  const r = rooms[room];

  if (r.players.length >= MAX_PLAYERS) {
    socket.emit("room_full");
    return;
  }

  socket.join(room);
  socket.data.room = room;
  socket.data.username = username;
  r.players.push({ id: socket.id, username });

  emitToRoom(room, "players", r.players);

  if (r.players.length >= 2 && r.phase === "waiting") {
    startGame(room);
  }
});

  socket.on("chat_message", ({ room, from, message, to }) => {
  if (!rooms[room]) return;
  if (to) {
    // Private message
    const recipient = rooms[room].players.find(p => p.username === to);
    if (recipient) {
      io.to(recipient.id).emit("chat_message", { from, message, isPrivate: true });
    }
  } else {
    // Public message
    emitToRoom(room, "chat_message", { from, message, isPrivate: false });
  }
});


 socket.on("submit_entry", ({ room, username, text }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  const id = `${Date.now()}-${Math.random()}`;
  const elapsed = Date.now() - (roomData.roundStartTime || Date.now());
  const entry = { id, username, text, time: Date.now(), elapsed };

  roomData.entries.push(entry);

  // 👇 Only notify the submitting player:
  socket.emit("entry_submitted", { id, text });

  // ✅ Optionally: emit to everyone if you want real-time entries shown:
  io.to(room).emit("entries", roomData.entries);
});


  socket.on("vote_entry", ({ room, username, entryId }) => {
    if (!rooms[room]) return;
    rooms[room].votes[username] = entryId;
    socket.emit("vote_confirmed", entryId);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    rooms[room].players = rooms[room].players.filter((p) => p.id !== socket.id);
    emitToRoom(room, "players", rooms[room].players);
  });

  socket.on("register", async ({ username, email, password }, callback) => {
    try {
      const userCheck = await pool.query(`SELECT * FROM users WHERE username = $1 OR email = $2`, [username, email]);
      if (userCheck.rows.length > 0) {
        return callback({ success: false, message: "Username or email already exists" });
      }

      await pool.query(`INSERT INTO users (username, email, password) VALUES ($1, $2, $3)`, [username, email, password]);
      await pool.query(`INSERT INTO user_stats (username) VALUES ($1)`, [username]);

      socket.data.username = username;
      callback({ success: true });
    } catch (err) {
      console.error("Registration error:", err);
      callback({ success: false, message: "Server error during registration" });
    }
  });

  socket.on("login", async ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, message: "Username and password required" });
    }

    try {
      const res = await pool.query(`SELECT * FROM users WHERE username = $1 AND password = $2`, [username, password]);
      if (res.rows.length === 0) {
        return callback({ success: false, message: "Invalid credentials" });
      }

      socket.data.username = username;
      callback({ success: true });

      const stats = await pool.query(`SELECT * FROM user_stats WHERE username = $1`, [username]);
      if (stats.rows.length) {
        socket.emit("user_stats", stats.rows[0]);
      }
    } catch (err) {
      console.error("Login failed:", err);
      callback({ success: false, message: "Server error during login" });
    }
  });
});

server.listen(3001, () => console.log("✅ Acrophobia backend running on port 3001"));



































  

