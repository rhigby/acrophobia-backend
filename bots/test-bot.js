const { io } = require("socket.io-client");
const path = require("path");
const fs = require("fs");
//const fetch = require("node-fetch"); // ensure this is installed if not already
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const SERVER_URL = process.env.SERVER_URL || "https://acrophobia-backend-2.onrender.com";
const ROOM = process.env.ROOM || "room1";
const PASSWORD = process.env.PASSWORD || "bot123";

const { getThemeForRoom } = require("../utils/profanityFilter");

const theme = getThemeForRoom(ROOM);
const themePath = path.join(__dirname, "themes", `${theme}.json`);
const wordBank = JSON.parse(fs.readFileSync(themePath, "utf8"));

function getWordForLetter(letter, index) {
  const upper = letter.toUpperCase();
  const bank = wordBank[upper];
  if (!bank) return upper;
  const pool = index % 2 === 0 ? bank.adjectives : bank.nouns;
  return pool[Math.floor(Math.random() * pool.length)];
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function loginOrRegister(username) {
  // Always try login first
  const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });

  if (loginRes.ok) {
    const data = await loginRes.json();
    console.log(`[${username}] Logged in successfully`);
    return data.token;
  }

  const errorText = await loginRes.text();
  console.log(`[${username}] Login failed, attempting registration. Reason: ${errorText}`);

  // Try to register
  const registerRes = await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@bots.fake`,
      password: PASSWORD
    }),
  });

  if (registerRes.ok) {
    console.log(`[${username}] Registered successfully`);
  } else if (registerRes.status === 409) {
    console.log(`[${username}] Already registered`);
  } else {
    const regErr = await registerRes.text();
    throw new Error(`[${username}] Registration failed: ${regErr}`);
  }

  // Try login again after registration
  const loginRes2 = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });

  if (!loginRes2.ok) {
    const err = await loginRes2.text();
    throw new Error(`[${username}] Login after registration failed: ${err}`);
  }

  const data2 = await loginRes2.json();
  return data2.token;
}

async function runBot(username) {
  try {
    const token = await loginOrRegister(username);

    const socket = io(SERVER_URL, {
      auth: { token },
      transports: ["websocket"]
    });

    let canSubmit = false;
    let hasVoted = false;
    let currentAcronym = null;

    socket.on("connect", () => {
      console.log(`[${username}] Connected`);
      socket.emit("join_room", { room: ROOM });
    });

    socket.on("phase", (phase) => {
      canSubmit = phase === "submit" || phase === "faceoff_submit";
      hasVoted = false;
      console.log(`[${username}] Phase changed to: ${phase}`);
    });

    socket.on("acronym", (acronym) => {
      currentAcronym = acronym;
    });

    socket.on("acronym_ready", async () => {
      if (!canSubmit || !currentAcronym) return;
      const letters = currentAcronym.toUpperCase().split("");
      const words = letters.map((letter, index) => getWordForLetter(letter, index));
      const answer = words.join(" ");

      setTimeout(() => {
        socket.emit("submit_entry", { room: ROOM, text: answer });
        console.log(`[${username}] Submitted: ${answer} [${currentAcronym}]`);
        canSubmit = false;
      }, rand(20000, 40000));
    });

    socket.on("entries", (entries) => {
      if (hasVoted) return;
      const others = entries.filter(e => e.username !== username);
      if (others.length > 0) {
        const pick = others[Math.floor(Math.random() * others.length)];
        hasVoted = true;
        setTimeout(() => {
          socket.emit("vote_entry", { room: ROOM, entryId: pick.id });
          console.log(`[${username}] Voted for: ${pick.text}`);
        }, rand(20000, 50000));
      }
    });

    socket.on("disconnect", () => {
      console.log(`[${username}] Disconnected`);
    });
  } catch (err) {
    console.error(`[${username} ERROR]: ${err.message}`);
    process.exit(1);
  }
}

const botName = process.env.BOT_NAME || process.argv[2];
const roomName = process.env.ROOM || process.argv[3];

// Only launch a single bot if BOT_NAME and ROOM are provided
if (botName && roomName) {
  runBot(botName);
} else {
  console.log("❌ BOT_NAME and ROOM must be set to launch a bot");
  process.exit(1);
}

// 👇 Prevent duplicate launch and enforce unique usernames
// const baseNames = ["bot1", "bot2", "bot3", "bot4"];
// baseNames.forEach(base => {
//   const botUsername = `${ROOM}-${base}`;
//   runBot(botUsername);
// });









