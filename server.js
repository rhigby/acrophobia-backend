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

// PostgreSQL Pool Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

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

  emitToRoom(roomId, "round_number", room.round);
  emitToRoom(roomId, "phase", room.phase);
  emitToRoom(roomId, "acronym", room.acronym);
  emitToRoom(roomId, "players", room.players);

  startCountdown(roomId, 60, () => startVoting(roomId));
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

function calculateAndEmitResults(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  for (const vote of Object.values(room.votes)) {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }

  let highestVotes = 0;
  let winningEntryId = null;
  const entryFirstVotes = new Set();
  const submitTimes = room.entries.map(e => e.time);
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
      time: ((entry.time - submitTimes[0]) / 1000).toFixed(2)
    }))
  });
  emitToRoom(roomId, "phase", "results");

  // Store stats
  for (const entry of room.entries) {
    const isWinner = entry.id === winningEntryId;
    const isFastest = firstVoteEntry && entry.id === firstVoteEntry.id;
    const votedForWinner = votersOfWinner.includes(entry.username);
    saveUserStats(entry.username, room.scores[entry.username], isWinner, isFastest ? (entry.time - submitTimes[0]) : null, votedForWinner);
  }
}

function showResults(roomId) {
  calculateAndEmitResults(roomId);

  startCountdown(roomId, 10, () => {
    emitToRoom(roomId, "phase", "intermission");
    startCountdown(roomId, 30, () => {
      const room = rooms[roomId];
      if (!room) return;
      if (room.round < MAX_ROUNDS) {
        room.round++;
        runRound(roomId);
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
  });
}

io.on("connection", (socket) => {
  socket.on("join_room", ({ room, username }) => {
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

    if (r.players.length >= MAX_PLAYERS) {
      socket.emit("room_full");
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.username = username;
    r.players.push({ id: socket.id, username });

    console.log(`[JOIN] ${username} joined ${room}`);
    emitToRoom(room, "players", r.players);

    if (r.players.length >= 2 && r.phase === "waiting") {
      startGame(room);
    }
  });

  socket.on("submit_entry", ({ room, username, text }) => {
    if (!rooms[room]) return;
    const id = `${Date.now()}-${Math.random()}`;
    rooms[room].entries.push({ id, username, text, time: Date.now() });
    socket.emit("entry_submitted", { id, text });
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
});

server.listen(3001, () => console.log("✅ Acrophobia backend running on port 3001"));






























  

