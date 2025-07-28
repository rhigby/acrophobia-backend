const { io } = require("socket.io-client");
const path = require("path");
const fs = require("fs");

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
  // Try to register first
  const registerRes = await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@test.com`,
      password: PASSWORD
    }),
  });

  if (registerRes.ok) {
    console.log(`[${username}] Registered successfully`);
  } else {
    const text = await registerRes.text();
    if (registerRes.status !== 409) {
      console.error(`[${username}] Registration failed:\n${text}`);
      throw new Error("Registration failed");
    } else {
      console.log(`[${username}] Already registered`);
    }
  }

  // Attempt login regardless
  const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });

  if (!loginRes.ok) {
    const errText = await loginRes.text();
    console.error(`[${username}] Login failed: ${errText}`);
    throw new Error("Login failed");
  }

  const data = await loginRes.json();
  return data.token;
}



async function runBot(username) {
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
      console.log(`[${username}] Submitted: ${answer} [from ${currentAcronym}]`);
      canSubmit = false;
    }, rand(1000, 3000));
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
      }, rand(1000, 3000));
    }
  });

  socket.on("disconnect", () => {
    console.log(`[${username}] Disconnected`);
  });
}

const baseNames = ["bot1", "bot2", "bot3", "bot4"];
baseNames.forEach(base => {
  const botUsername = `${ROOM}-${base}`;
  runBot(botUsername);
});








