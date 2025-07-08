// backend/server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({
  origin: "https://acrophobia-play.onrender.com",
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https://acrophobia-backend-2.onrender.com/socket.io/?EIO=4&transport=polling&t=pq4a501s. (Reason: CORS header ‘Access-Control-Allow-Origin’ does not match ‘https://acrophobia-frontend.onrender.com’).

Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https://acrophobia-backend-2.onrender.com/socket.io/?EIO=4&transport=polling&t=pq90rdsw. (Reason: CORS header ‘Access-Control-Allow-Origin’ does not match ‘https://acrophobia-frontend.onrender.com’).
const io = new Server(server, {
  cors: {
    origin: "https://acrophobia-play.onrender.com",
    methods: ["GET", "POST"]
  }
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

function showResults(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  for (const vote of Object.values(room.votes)) {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }

  for (const entry of room.entries) {
    if (!room.scores[entry.username]) room.scores[entry.username] = 0;
    room.scores[entry.username] += voteCounts[entry.id] || 0;
  }

  room.phase = "results";
  emitToRoom(roomId, "votes", voteCounts);
  emitToRoom(roomId, "scores", room.scores);
  emitToRoom(roomId, "phase", "results");

  setTimeout(() => {
    if (room.round < MAX_ROUNDS) {
      room.round++;
      runRound(roomId);
    } else {
      emitToRoom(roomId, "phase", "game_over");
      // ⏳ 30-second intermission before restarting
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
  }, 8000);
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
        votes: [],
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
      r.phase = "submit";
      startGame(room);
    }
  });

  socket.on("submit_entry", ({ room, username, text }) => {
    if (!rooms[room]) return;
    const id = `${Date.now()}-${Math.random()}`;
    rooms[room].entries.push({ id, username, text });
  });

  socket.on("vote_entry", ({ room, username, entryId }) => {
    if (!rooms[room]) return;
    rooms[room].votes[username] = entryId;
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    rooms[room].players = rooms[room].players.filter((p) => p.id !== socket.id);
    emitToRoom(room, "players", rooms[room].players);
  });
});

server.listen(3001, () => console.log("✅ Acrophobia backend running on port 3001"));




















  

