// backend/game-logic.js

function wireGameLogic(io, pool, activeUsers, userSockets, userRooms, rooms) {
  const MAX_PLAYERS = 10;
  const MAX_ROUNDS = 5;

  function emitToRoom(roomId, event, data) {
    io.to(roomId).emit(event, data);
  }

  function createAcronym(length) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
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
      emitToRoom(roomId, "letter_beep");
      index++;
      if (index >= acronym.length) {
        clearInterval(interval);
        emitToRoom(roomId, "acronym_ready");
        callback();
      }
    }, 2000);
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
      const shuffledEntries = [...room.entries].sort(() => Math.random() - 0.5);
      playerSocket.emit("entries", shuffledEntries);
    }

    startCountdown(roomId, 30, () => showResults(roomId));
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

    if (firstVoteEntry) room.scores[firstVoteEntry.username] += 3;
    if (winningEntryId && highestVotes > 0) {
      const winnerEntry = room.entries.find(e => e.id === winningEntryId);
      if (winnerEntry) room.scores[winnerEntry.username] += 5;
    }

    for (const [voter, entryId] of Object.entries(room.votes)) {
      if (entryId === winningEntryId) {
        if (!room.scores[voter]) room.scores[voter] = 0;
        room.scores[voter] += 1;
      }
    }

    emitToRoom(roomId, "votes", voteCounts);
    emitToRoom(roomId, "scores", room.scores);
    emitToRoom(roomId, "phase", "results");

    setTimeout(() => {
      if (room.round < MAX_ROUNDS) {
        room.round++;
        runRound(roomId);
      } else {
        emitToRoom(roomId, "phase", "game_over");
        room.phase = "waiting";
        room.round = 0;
        room.entries = [];
        room.votes = {};
        room.acronym = "";
        room.scores = {};
      }
    }, 10000);
  }

  function showResults(roomId) {
    calculateAndEmitResults(roomId);
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
    const session = socket.request.session;
    const username = session?.username;

    if (username) {
      userSockets.set(username, socket.id);
      activeUsers.set(username, "lobby");
      userRooms[username] = "lobby";
      io.emit("active_users", Array.from(activeUsers.entries()).map(([u, r]) => ({ username: u, room: r })));
    }

    socket.on("join_room", ({ room }, callback) => {
      if (!username) return callback({ success: false });
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

      if (rooms[room].players.length >= MAX_PLAYERS) return callback({ success: false, message: "Room full" });

      socket.join(room);
      socket.data.room = room;
      rooms[room].players.push({ id: socket.id, username });
      emitToRoom(room, "players", rooms[room].players);

      if (rooms[room].players.length >= 2 && rooms[room].phase === "waiting") {
        startGame(room);
      }

      callback({ success: true });
    });

    socket.on("submit_entry", ({ room, username, text }) => {
      const roomData = rooms[room];
      if (!roomData) return;
      if (roomData.entries.find(e => e.username === username)) return;
      const entry = {
        id: `${Date.now()}-${Math.random()}`,
        username,
        text,
        time: Date.now(),
        elapsed: Date.now() - roomData.roundStartTime
      };
      roomData.entries.push(entry);
      emitToRoom(room, "submitted_users", roomData.entries.map(e => e.username));
    });

    socket.on("vote_entry", ({ room, username, entryId }) => {
      const roomData = rooms[room];
      if (!roomData) return;
      const entry = roomData.entries.find(e => e.id === entryId);
      if (!entry || entry.username === username) return;
      roomData.votes[username] = entryId;
      socket.emit("vote_confirmed", entryId);
    });

    socket.on("disconnect", () => {
      if (username) {
        userSockets.delete(username);
        activeUsers.delete(username);
        io.emit("active_users", Array.from(activeUsers.entries()).map(([u, r]) => ({ username: u, room: r })));
      }
    });
  });
}

module.exports = { wireGameLogic };
