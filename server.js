// backend/server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {};

function createAcronym(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  room.round = 1;
  room.phase = "submit";
  room.entries = [];
  room.votes = {};
  room.scores = room.scores || {};

  const length = room.round + 2; // 3,4,5,6,7
  room.acronym = createAcronym(length);

  io.to(roomId).emit("round_number", room.round);
  io.to(roomId).emit("phase", room.phase);
  io.to(roomId).emit("acronym", room.acronym);

  startCountdown(roomId, 60, () => startVoting(roomId));
}

function startVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.phase = "vote";
  io.to(roomId).emit("phase", "vote");
  io.to(roomId).emit("entries", room.entries);

  startCountdown(roomId, 30, () => showResults(roomId));
}

function showResults(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.phase = "results";
  const voteCounts = {};
  for (const vote of Object.values(room.votes)) {
    if (!voteCounts[vote]) voteCounts[vote] = 0;
    voteCounts[vote]++;
  }

  for (const [id, entry] of room.entries.map((e, i) => [e.id, e])) {
    if (!voteCounts[id]) voteCounts[id] = 0;
  }

  for (const entry of room.entries) {
    if (!room.scores[entry.username]) room.scores[entry.username] = 0;
    room.scores[entry.username] += voteCounts[entry.id] || 0;
  }

  io.to(roomId).emit("votes", voteCounts);
  io.to(roomId).emit("scores", room.scores);
  io.to(roomId).emit("phase", "results");

  setTimeout(() => {
    if (room.round < 5) {
      room.round++;
      room.phase = "submit";
      room.entries = [];
      room.votes = {};
      const length = room.round + 2;
      room.acronym = createAcronym(length);
      io.to(roomId).emit("round_number", room.round);
      io.to(roomId).emit("phase", "submit");
      io.to(roomId).emit("acronym", room.acronym);
      startCountdown(roomId, 60, () => startVoting(roomId));
    }
  }, 8000);
}

function startCountdown(roomId, seconds, callback) {
  const room = rooms[roomId];
  if (!room) return;
  let remaining = seconds;
  const interval = setInterval(() => {
    if (remaining <= 10) io.to(roomId).emit("beep");
    io.to(roomId).emit("countdown", remaining);
    remaining--;
    if (remaining < 0) {
      clearInterval(interval);
      callback();
    }
  }, 1000);
}

io.on("connection", (socket) => {
  socket.on("join_room", ({ room, username }) => {
    if (!rooms[room]) {
      rooms[room] = {
        players: [],
        entries: [],
        votes: {},
        scores: {},
        round: 0,
        phase: "waiting"
      };
    }
    const r = rooms[room];
    if (r.players.length >= 10) {
      socket.emit("room_full");
      return;
    }
    socket.join(room);
    socket.data.room = room;
    socket.data.username = username;
    r.players.push({ id: socket.id, username });

    if (r.players.length >= 2 && r.phase === "waiting") {
      startGame(room);
    }
  });

  socket.on("submit_entry", ({ room, username, text }) => {
    const entry = {
      id: `${Date.now()}-${Math.random()}`,
      username,
      text
    };
    rooms[room]?.entries.push(entry);
  });

  socket.on("vote_entry", ({ room, username, entryId }) => {
    rooms[room].votes[username] = entryId;
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    rooms[room].players = rooms[room].players.filter(
      (p) => p.id !== socket.id
    );
  });
});

server.listen(3001, () => console.log("Server running on port 3001"));
















  

