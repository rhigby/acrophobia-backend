// backend/server.js
require("dotenv").config();
const {
  containsInappropriate,
  roomSettings,
  getThemeForRoom
} = require("./utils/profanityFilter");
const bcrypt = require("bcrypt");

const express = require("express");
const router = express.Router();
const activeUsers = new Map();
const userRooms = {}; // Track each user's current room
const roomRounds = {};
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const userSockets = new Map();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://acrophobia-play-now.onrender.com",
    credentials: true
  }
});
const path = require("path");
const { spawn } = require("child_process");
const roomBots = {};



const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});
const allowedOrigins = [
  "https://acrophobia-play-now.onrender.com",
  "https://acrophobia-bhnj.onrender.com",
  "http://localhost:5173"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));


app.use(express.json());

app.use(router);

app.get("/api/me", async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });

  const result = await pool.query(`SELECT username FROM sessions WHERE token = $1`, [token]);
  if (result.rows.length === 0) return res.status(401).json({ error: "Invalid token" });

  res.json({ username: result.rows[0].username });
});

function cleanupRoomIfEmpty(room) {
  const roomData = rooms[room];
  if (!roomData) return;

  const realPlayers = roomData.players.filter(p => !p.username.includes("-bot"));

  if (realPlayers.length === 0) {
    console.log(`🧹 Resetting room ${room} (no real players left)`);

    // Kill any bots
    if (roomBots[room]) {
      roomBots[room].forEach(botProc => botProc.kill());
      delete roomBots[room];
    }

    // Remove room and related data
    delete rooms[room];
    delete roomSettings[room];
    delete roomRounds[room];

    // Clean up any user mappings pointing to the deleted room
    for (const [username, assignedRoom] of Object.entries(userRooms)) {
      if (assignedRoom === room) {
        delete userRooms[username];
        activeUsers.delete(username);
      }
    }

    emitRoomStats();
  }
}



function launchBot(botName, room) {
  if (roomBots[room]?.some(proc => proc.spawnargs.includes(botName))) {
    console.log(`⚠️ Bot ${botName} already running in ${room}`);
    return;
  }

  const botPath = path.join(__dirname, "bots", "test-bot.js");
  const bot = spawn("node", [botPath, botName, room], {
    cwd: __dirname,
    env: { ...process.env, BOT_NAME: botName, ROOM: room }
  });

  if (!roomBots[room]) roomBots[room] = [];
  roomBots[room].push(bot);

  bot.stdout.on("data", (data) => {
    const message = data.toString().trim();
    console.log(`[${botName}]: ${message}`);

    // 💬 Detect chat messages sent from the bot
    if (message.startsWith("[BOT_CHAT]")) {
      const chatText = message.replace("[BOT_CHAT]", "").trim();

      io.to(room).emit("chat_message", {
        username: botName,
        text: chatText,
        isBot: true
      });
    }
  });

  bot.stderr.on("data", (data) => {
    console.error(`[${botName} ERROR]: ${data}`);
  });

  bot.on("close", (code) => {
    console.log(`[${botName}] exited with code ${code}`);
  });
}




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

router.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const existing = await pool.query(
      "SELECT username FROM users WHERE username = $1 OR email = $2",
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Username or email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    //const hashedPassword = password;

    await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hashedPassword]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === "23505") {
      // Unique constraint violation
      return res.status(409).json({ message: "Username or email already exists" });
    }

    console.error("Registration error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;

app.post("/api/login-token", express.json(), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  const userResult = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);

  if (userResult.rows.length === 0) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const user = userResult.rows[0];
  const passwordMatch = await bcrypt.compare(password, user.password);

  if (!passwordMatch) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = uuidv4();
  await pool.query(`INSERT INTO sessions (token, username) VALUES ($1, $2)`, [token, username]);

  res.json({ success: true, token });
});


app.post("/api/update-profile", express.json(), async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.split(" ")[1];
  const { email, password } = req.body;

  if (!token) return res.status(401).json({ error: "Missing token" });

  const result = await pool.query(`SELECT username FROM sessions WHERE token = $1`, [token]);
  if (result.rows.length === 0) return res.status(401).json({ error: "Invalid token" });

  const username = result.rows[0].username;
  await pool.query(`UPDATE users SET email = $1, password = $2 WHERE username = $3`, [email, password, username]);

  res.json({ success: true });
});

app.post("/api/messages/react", express.json(), async (req, res) => {
  const { id: messageId, reaction } = req.body;
  const auth = req.headers.authorization;
  const token = auth?.split(" ")[1];

  if (!token || !messageId || !reaction) {
    return res.status(400).json({ error: "Missing token, message ID, or reaction" });
  }

  const result = await pool.query(`SELECT username FROM sessions WHERE token = $1`, [token]);
  if (result.rows.length === 0) return res.status(401).json({ error: "Invalid token" });

  const username = result.rows[0].username;

  try {
    await pool.query(
      `INSERT INTO message_reactions (message_id, username, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, username)
       DO UPDATE SET reaction = EXCLUDED.reaction, timestamp = NOW()`,
      [messageId, username, reaction]
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to save reaction:", err);
    res.status(500).json({ error: "Failed to save reaction" });
  }
});


app.get("/api/messages", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM messages ORDER BY timestamp ASC`);
    const allMessages = result.rows.map((msg) => ({
      ...msg,
      replyTo: msg.reply_to ?? null, // normalize key
    }));
    res.json(allMessages); // ✅ flat list
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.get("/api/messages/reactions", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT message_id, reaction, COUNT(*) as count
      FROM message_reactions
      GROUP BY message_id, reaction
    `);

    const grouped = {};
    result.rows.forEach(({ message_id, reaction, count }) => {
      if (!grouped[message_id]) grouped[message_id] = {};
      grouped[message_id][reaction] = parseInt(count, 10);
    });

    res.json(grouped);
  } catch (err) {
    console.error("Failed to fetch reactions:", err);
    res.status(500).json({ error: "Failed to fetch reactions" });
  }
});

app.get("/api/messages/reaction-users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT message_id, username, reaction
      FROM message_reactions
    `);

    const userMap = {};

    result.rows.forEach(({ message_id, username, reaction }) => {
      if (!userMap[message_id]) userMap[message_id] = {};
      userMap[message_id][username] = reaction;
    });

    res.json(userMap);
  } catch (err) {
    console.error("Failed to fetch reaction user map:", err);
    res.status(500).json({ error: "Failed to fetch reaction users" });
  }
});


const messages = [];

app.post("/api/messages", express.json(), async (req, res) => {
 const username = req.body.username || "Guest";
   console.error("Failed to insert message:", username);
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
      replies: []
    };

    io.emit("new_message", message);
    res.status(201).json(message);
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Database insert failed" });
  }
});

app.get("/api/messages", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM messages ORDER BY timestamp ASC`);
    const allMessages = result.rows;

    // Step 1: Normalize and build a map of all messages
    const messageMap = {};
    allMessages.forEach(msg => {
      messageMap[msg.id] = {
        ...msg,
        replyTo: msg.reply_to ?? null, // normalize naming
        replies: []
      };
    });

    // Step 2: Nest replies under their parents
    const roots = [];
    Object.values(messageMap).forEach(msg => {
      const parentId = msg.replyTo;
      if (parentId && messageMap[parentId]) {
        messageMap[parentId].replies.push(msg);
      } else {
        roots.push(msg);
      }
    });

    // Step 3: Sort all levels newest-to-oldest
    function sortTree(messages) {
      messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      messages.forEach(m => {
        if (Array.isArray(m.replies)) sortTree(m.replies);
      });
    }

    sortTree(roots);

    res.json(roots);
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
  await pool.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT REFERENCES users(username),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

  // ✅ Add this for reactions support
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      reaction TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_reaction 
  ON message_reactions (message_id, username);
`);


}

initDb().catch(console.error);

function getActiveUserList() {
  const seen = new Set();
  const list = [];

  for (const [username, room] of activeUsers.entries()) {
    if (!seen.has(username)) {
      list.push({ username, room });
      seen.add(username);
    }
  }

  return list;
}

const rooms = {};
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 5;

const LETTER_WEIGHTS = [
  "E","E","E","E","E","E","E","E","E","E",
  "A","A","A","A","A","A","A","A",
  "R","R","R","R","R","R",
  "I","I","I","I","I",
  "O","O","O","O",
  "T","T","T","T",
  "N","N","N","N",
  "S","S","S",
  "L","L","L",
  "C","C","C",
  "U","U","U",
  "D","D",
  "P","P",
  "M","M",
  "H","H",
  "G","G",
  "B","B",
  "F",
  "Y",
  "W",
  "K",
  "V",
  "X",
  "Z",
  "J",
  "Q"
];

function createAcronym(length) {
  const pool = [...LETTER_WEIGHTS];
  const result = [];

  while (result.length < length && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const letter = pool[index];
    result.push(letter);
    pool.splice(index, 1); // prevent repeats
  }

  return result.join("");
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


function showFaceoffResults(roomId) {
  const room = rooms[roomId];
  if (!room || !room.faceoff?.active) return;

  const voteCounts = {};
  for (const vote of Object.values(room.votes)) {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }

  let highestVotes = 0;
  let winningEntryId = null;
  const firstVoteEntry = room.entries.find(entry => voteCounts[entry.id]);

  for (const entry of room.entries) {
    const count = voteCounts[entry.id] || 0;
    if (!room.faceoff.scores[entry.username]) room.faceoff.scores[entry.username] = 0;
    room.faceoff.scores[entry.username] += count;

    if (count > highestVotes) {
      highestVotes = count;
      winningEntryId = entry.id;
    }
  }

  if (firstVoteEntry) {
    room.faceoff.scores[firstVoteEntry.username] += 3;
  }

  if (winningEntryId && highestVotes > 0) {
    const winnerEntry = room.entries.find(e => e.id === winningEntryId);
    if (winnerEntry) room.faceoff.scores[winnerEntry.username] += 5;
  }

  const votersOfWinner = [];
  for (const [voter, entryId] of Object.entries(room.votes)) {
    if (entryId === winningEntryId) {
      votersOfWinner.push(voter);
    }
  }

  emitToRoom(roomId, "votes", voteCounts);
  emitToRoom(roomId, "scores", room.faceoff.scores);
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

  emitToRoom(roomId, "phase", "faceoff_results");

  // ✅ Final round check
  if (room.faceoff.round >= 3) {
    emitToRoom(roomId, "phase", "faceoff_game_over");
    emitToRoom(roomId, "final_faceoff_scores", room.faceoff.scores);

    // ⏳ Wait and reset room state before restarting game
    setTimeout(() => {
      room.phase = "waiting";
      room.round = 0;
      room.entries = [];
      room.votes = {};
      room.acronym = "";
      room.faceoff = { active: false, round: 0, players: [], scores: {} };
      room.scores = {}; // optional: full reset for new match

      emitToRoom(roomId, "phase", "waiting");
      emitToRoom(roomId, "players", room.players);

      if (room.players.length >= 2) {
        startGame(roomId);
      }
    }, 30000); // 30 seconds between matches
  } else {
    room.faceoff.round++;
    emitToRoom(roomId, "phase", "faceoff_next_round");
    setTimeout(() => runFaceoffRound(roomId), 8000);
  }
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

function getTopTwoPlayers(scores) {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([username]) => username);
}

function showResults(roomId) {
  calculateAndEmitResults(roomId);

  startCountdown(roomId, 30, () => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.round < MAX_ROUNDS) {
      // Continue to next round
      room.round++;
      emitToRoom(roomId, "phase", "next_round_overlay");
      emitToRoom(roomId, "round_number", room.round);

      setTimeout(() => runRound(roomId), 10000);
    } else {
      // Game over — begin faceoff round
      const topPlayers = getTopTwoPlayers(room.scores);
      room.faceoff = {
        active: true,
        round: 0,
        players: topPlayers,
        scores: {}
      };

      emitToRoom(roomId, "phase", "faceoff_intro");
      emitToRoom(roomId, "faceoff_players", topPlayers);

      // Start faceoff after short intro delay
      setTimeout(() => runFaceoffRound(roomId), 8000);
    }
  });
}

function runFaceoffRound(roomId) {
  const room = rooms[roomId];
  if (!room || !room.faceoff.active) return;

  const acronymLength = 2 + room.faceoff.round; // 3 → 5
  const acronym = createAcronym(acronymLength);

  room.phase = "faceoff_submit";
  room.acronym = acronym;
  room.entries = [];
  room.votes = {};

  emitToRoom(roomId, "round_number", room.faceoff.round);
    for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const playerSocket = io.sockets.sockets.get(socketId);
    if (!playerSocket) continue;
  
    const player = room.players.find(p => p.socketId === socketId);
    if (player && room.faceoff.players.includes(player.username)) {
      playerSocket.emit("acronym", acronym);
    }
  }
  emitToRoom(roomId, "phase", "faceoff_submit");
  emitToRoom(roomId, "faceoff_players", room.faceoff.players);

 revealAcronymLetters(roomId, room.acronym, () => {
  room.roundStartTime = Date.now();
  startCountdown(roomId, 45, () => {
    startFaceoffVoting(roomId); // 🔥 RIGHT HERE
  });
});
}

function startFaceoffVoting(roomId) {
  const room = rooms[roomId];
  if (!room || !room.faceoff?.active) return;

  room.phase = "faceoff_vote";
  emitToRoom(roomId, "phase", "faceoff_vote");

  const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);

  for (const socketId of roomSockets) {
    const playerSocket = io.sockets.sockets.get(socketId);
    if (!playerSocket) continue;

    // Everyone sees a shuffled entry list
    const shuffledEntries = [...room.entries].sort(() => Math.random() - 0.5);
    playerSocket.emit("entries", shuffledEntries);
  }

  startCountdown(roomId, 30, () => {
    showFaceoffResults(roomId);
  });
}

function getRoomStats() {
  const stats = {};
  for (const [roomName, room] of Object.entries(rooms)) {
    const usernames = room.players.map(p => p.username);
    const botCount = usernames.filter(name => name.startsWith(`${roomName}-bot`)).length;

    stats[roomName] = {
      players: usernames.length,
      round: room.round,
      botCount,
      usernames  // 👈 Include this so frontend can break down real vs bot users
    };
  }
  return stats;
}


io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next();

  try {
    const result = await pool.query(`SELECT username FROM sessions WHERE token = $1`, [token]);
    if (result.rows.length) {
      const username = result.rows[0].username;

      socket.data.username = username;

      // ✅ Register user's socket ID for private messaging
      userSockets.set(username, socket.id);
      console.log(`✅ ${username} connected on socket ${socket.id}`);
    }
    next();
  } catch (err) {
    console.error("❌ Error during socket authentication:", err);
    next(err);
  }
});


// ✅ Middleware to extract username from cookie
// io.use((socket, next) => {
//   const cookieHeader = socket.handshake.headers.cookie;
//   console.log("Cookie header:", socket.handshake.headers.cookie);
//   if (!cookieHeader) return next();
//   const cookies = Object.fromEntries(
//     cookieHeader.split(";").map(c => {
//       const [key, ...v] = c.trim().split("=");
//       return [key, decodeURIComponent(v.join("="))];
//     })
//   );
//   const username = cookies.acrophobia_user;
//   if (username) {
//     socket.data.username = username;
//   }
//   next();
// });
function emitRoomStats() {
  const stats = getRoomStats();
  console.log("🚀 Emitting room stats:", stats);
  io.emit("room_list", stats);
}


io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id, "user:", socket.data.username);
  const username = socket.data?.username; // should be set from token/session
  if (username) {
    userSockets.set(username, socket.id); // ✅ register mapping
    console.log(`✅ Registered ${username} to socket ${socket.id}`);
  }
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

  socket.on("request_user_stats", async () => {
    const username = socket.data?.username;
    if (!username) return;
    const statsRes = await pool.query(`SELECT * FROM user_stats WHERE username = $1`, [username]);
    if (statsRes.rows.length > 0) {
      socket.emit("user_stats", statsRes.rows[0]);
    }
  });


  socket.on("login", async ({ username, password }, callback) => {
  console.log("📩 Login event received:", username, password);
  if (!username || !password) {
    return callback({ success: false, message: "Missing credentials" });
  }

  try {
    // Fetch user by username only
    const userResult = await pool.query(
      `SELECT * FROM users WHERE username = $1`,
      [username]
    );

    if (userResult.rows.length === 0) {
      return callback({ success: false, message: "Invalid credentials" });
    }

    const user = userResult.rows[0];

    // Compare plaintext password to hashed one
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
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
  console.log("📩 Private message request:", { from, to, message });

  if (!from || !to || !message) {
    console.warn("❌ Missing fields in private_message:", { from, to, message });
    return;
  }

  const recipientSocketId = userSockets.get(to);
  console.log("➡️ Sending to socket:", recipientSocketId);

  const payload = { from, to, text: message, private: true };

  if (recipientSocketId) {
    io.to(recipientSocketId).emit("private_message", payload);
    socket.emit("private_message_ack", payload);
  } else {
    console.warn(`⚠️ Recipient ${to} not online.`);
  }
});




socket.on("chat_message", ({ room, text }) => {
  const username = socket.data?.username;
  if (!username || !text || !room) return;

  const roomData = rooms[room];
  if (roomData?.filterProfanity) {
    const result = containsInappropriate(text);
    if (result) {
      socket.emit("chat_error", {
        reason: `Inappropriate language in chat: ${result.matched}`
      });
      return;
    }
  }

  io.to(room).emit("chat_message", { username, text });
});

socket.on("confirm_add_bots", ({ room, count = 3 }) => {
  if (!room || !rooms[room] || count < 3 || count > 7) return;

  const existingNames = new Set(rooms[room].players.map(p => p.username));
  roomBots[room] = [];

  for (let i = 1; i <= count; i++) {
    const botName = `${room}-bot${i}`;
    if (!existingNames.has(botName)) {
      const bot = launchBot(botName, room);
      if (bot) roomBots[room].push(bot);
    }
  }
});


 

socket.on("join_room", (data, callback) => {
  const roomId = data?.room;
  const username = socket.data?.username;

  if (!username || !roomId) {
    return callback?.({ success: false, message: "Unauthorized or missing room" });
  }

  // 🔄 Clean up previous room (if any)
  const previousRoom = userRooms[username];
  if (previousRoom && rooms[previousRoom]) {
    rooms[previousRoom].players = rooms[previousRoom].players.filter(p => p.username !== username);

    // 🧹 Clear player's score in previous room
    delete rooms[previousRoom].scores?.[username];
    delete rooms[previousRoom].faceoff?.scores?.[username];

    emitToRoom(previousRoom, "players", rooms[previousRoom].players);
  }

  // 🗂 Assign to new room
  userRooms[username] = roomId;
  activeUsers.set(username, roomId);
  socket.data.room = roomId;
  socket.join(roomId);

  // 📦 Initialize room if not exists
  if (!rooms[roomId]) {
    const defaultSettings = { filterProfanity: false, theme: "general" };
    rooms[roomId] = {
      players: [],
      scores: {},
      phase: "waiting",
      round: 0,
      entries: [],
      votes: {},
      acronym: "",
      faceoff: {
        active: false,
        round: 0,
        players: [],
        scores: {}
      },
      ...defaultSettings,
      ...roomSettings[roomId]
    };
  }

  const room = rooms[roomId];

  // ❌ Prevent rejoining same room
  if (room.players.find(p => p.username === username)) {
    return callback?.({ success: false, message: "User already in room" });
  }

  // ❌ Prevent overfilling
  if (room.players.length >= MAX_PLAYERS) {
    return callback?.({ success: false, message: "Room is full" });
  }

  // ✅ Add to players list
  room.players.push({ id: socket.id, username });
  room.scores[username] = 0;

  emitToRoom(roomId, "players", room.players);

  // ✅ Emit room_list here (after players are initialized)
  emitToRoom(roomId, "room_list", {
    players: room.players.length,
    botCount: room.players.filter(p => p.isBot).length,
    usernames: room.players.map(p => p.username),
  });

  emitRoomStats();
  io.emit("active_users", getActiveUserList());

  // 💬 Ask if user wants bots (instead of auto-spawning)
  const realPlayers = room.players.filter(p => !p.username.startsWith("bot"));
  if (realPlayers.length === 1 && !roomBots[roomId]) {
    const playerSocket = io.sockets.sockets.get(socket.id);
    if (playerSocket) {
      playerSocket.emit("prompt_add_bots", { room: roomId });
    }
  }

  // ▶️ Start game if ready
  if (room.players.length >= 2 && room.phase === "waiting") {
    setTimeout(() => {
      if (rooms[roomId]?.phase === "waiting") {
        startGame(roomId);
      }
    }, 2000); // give bots time to connect
  }

  callback?.({ success: true });
});






  socket.on("submit_entry", ({ room, text }) => {
  const roomData = rooms[room];
  if (!roomData) return;

  const username = socket.data?.username;
  if (!username || roomData.entries.find(e => e.username === username)) return;

  if (roomData.filterProfanity) {
    const result = containsInappropriate(text);
    if (result) {
      socket.emit("entry_rejected", {
        reason: `Inappropriate content detected: ${result.matched}`
      });
      return;
    }
  }

  const id = `${Date.now()}-${Math.random()}`;
  const elapsed = Date.now() - roomData.roundStartTime;
  const entry = { id, username, text, time: Date.now(), elapsed };

  roomData.entries.push(entry);

  const submittedUsernames = roomData.entries.map(e => e.username);
  emitToRoom(room, "submitted_users", submittedUsernames);

  socket.emit("entry_submitted", { id, text });
  io.to(room).emit("entries", roomData.entries);
    if (room.faceoff?.active) {
      if (!room.faceoff.players.includes(username)) return;
    }

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

  if (!room || !rooms[room]) return;

  const r = rooms[room];

  // Remove player
  r.players = r.players.filter(p => p.id !== socket.id);

  // Reset score and faceoff score
  if (r.scores) delete r.scores[username];
  if (r.faceoff?.scores) delete r.faceoff.scores[username];

  // Optional: also clean votes/entries
  if (r.votes) delete r.votes[username];
  if (Array.isArray(r.entries)) {
    r.entries = r.entries.filter(e => e.username !== username);
  }

  // Leave room and mark in lobby
  socket.leave(room);
  socket.data.room = null;
  activeUsers.set(username, "lobby");

  emitToRoom(room, "players", r.players);
  io.emit("active_users", getActiveUserList());

  // Force cleanup if empty
  cleanupRoomIfEmpty(room);
});



  
 socket.on("disconnect", () => {
  const username = socket.data.username;
  const room = socket.data.room || userRooms[username]; // fallback

  if (username) {
    activeUsers.delete(username);
    delete userRooms[username];
  }

  if (room && rooms[room]) {
    rooms[room].players = rooms[room].players.filter(p => p.username !== username);
    delete rooms[room].scores?.[username]; // 👈 Optional fallback
    emitToRoom(room, "players", rooms[room].players);

    cleanupRoomIfEmpty(room);
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
  const stats = getRoomStats();
  io.emit("room_list", stats);
}, 5000);
server.listen(3001, () => console.log("✅ Acrophobia backend running on port 3001"));











































  

