// test-bot.js

// test-bot.js

const { io } = require("socket.io-client");
const path = require("path");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const ROOM = process.env.ROOM || "room1";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const PASSWORD = process.env.PASSWORD || "bot123";

const adjMap = require("./adjMap.json");
const nounMap = require("./nounMap.json");
const verbMap = require("./verbMap.json");
const wordMap = require("./wordMap.json");
const chatLines = require("./chatDictionary");

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function getWordForLetter(letter, index) {
  const upper = letter.toUpperCase();

  const adjectives = adjMap[upper] || [];
  const nouns = nounMap[upper] || [];
  const verbs = verbMap[upper] || [];
  const general = wordMap[upper] || [];

  let pool = [];
  if (index % 2 === 0) {
    pool = adjectives.length > 0 ? adjectives : general;
  } else {
    pool = nouns.length > 0 ? nouns : verbs.length > 0 ? verbs : general;
  }

  const filtered = pool.filter(w => typeof w === "string" && w.length <= 10);
  const word = filtered[Math.floor(Math.random() * filtered.length)];

  if (!word) {
    console.warn(`⚠️ No usable words for letter: ${upper}`);
    return upper;
  }

  return word.charAt(0).toUpperCase() + word.slice(1);
}

const usedChatLinesGlobal = {
  greetings: new Set(),
  submitTaunts: new Set(),
  voteReactions: new Set(),
  resultReactions: new Set(),
};

function randomLine(category, player = "") {
  const lines = chatLines[category];
  const used = usedChatLinesGlobal[category];

  const unused = lines.filter(line => {
    const key = typeof line === "function" ? line.toString() : line;
    return !used.has(key);
  });

  const chosen = unused.length
    ? unused[Math.floor(Math.random() * unused.length)]
    : lines[Math.floor(Math.random() * lines.length)];

  const key = typeof chosen === "function" ? chosen.toString() : chosen;
  used.add(key);
  return typeof chosen === "function" ? chosen(player) : chosen;
}

async function loginOrRegister(username) {
  const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD })
  });

  if (loginRes.ok) {
    const data = await loginRes.json();
    console.log(`[${username}] Logged in`);
    return data.token;
  }

  await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@bots.fake`,
      password: PASSWORD
    })
  });

  const retryRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD })
  });

  const data = await retryRes.json();
  return data.token;
}

async function runBot(username) {
  const token = await loginOrRegister(username);

  const socket = io(SERVER_URL, {
    auth: { token },
    transports: ["websocket"]
  });

  let hasSubmitted = false;
  let currentAcronym = null;
  let currentPhase = "";
  let hasGreeted = false;
  let hasTaunted = false;
  let votedForUser = null;
  let hasVoted = false;
  let entriesReceived = [];

  function sendChat(text) {
    socket.emit("chat_message", {
      room: ROOM,
      username,
      text,
      isBot: true
    });
  }

  function isMostlyWords(text) {
    const words = text.trim().split(/\s+/);
    let validCount = 0;
    for (let word of words) {
      const cleanWord = word.toLowerCase().replace(/[^a-z]/gi, "");
      if (wordMap[cleanWord.charAt(0).toUpperCase()]?.includes(cleanWord)) {
        validCount++;
      }
    }
    return validCount >= Math.floor(words.length * 0.6);
  }

  function voteNow(entries) {
    const valid = entries.filter((e) => e.username !== username && isMostlyWords(e.text));
    if (valid.length === 0) return;

    const pick =
      Math.random() < 0.7
        ? valid.sort((a, b) => b.text.length - a.text.length)[0]
        : valid[rand(0, valid.length - 1)];

    votedForUser = pick.username;
    socket.emit("vote_entry", { room: ROOM, entryId: pick.id });
    console.log(`[${username}] ✅ Voted for: ${pick.text}`);
    hasVoted = true;
  }

  socket.on("connect", () => {
    console.log(`[${username}] Connected`);
    socket.emit("join_room", { room: ROOM });

    if (!hasGreeted) {
      setTimeout(() => {
        sendChat(randomLine("greetings"));
        hasGreeted = true;
      }, rand(1000, 4000));
    }
  });

  socket.on("acronym", (acronym) => {
    currentAcronym = acronym;
    console.log(`[${username}] Received acronym: ${acronym}`);
  });

  socket.on("phase", (phase) => {
    currentPhase = phase;
    hasSubmitted = false;
    hasTaunted = false;
    hasVoted = false;
    entriesReceived = [];

    if (phase === "submit") {
      setTimeout(() => trySubmit(), rand(10000, 20000));
    } else if (phase === "results" && votedForUser) {
      setTimeout(() => {
        sendChat(randomLine("voteReactions", votedForUser));
        votedForUser = null;
      }, rand(1000, 3000));
    }
  });

  socket.on("entries", (entries) => {
    entriesReceived = entries;

    if (!hasVoted && currentPhase === "vote") {
      setTimeout(() => {
        if (!hasVoted && currentPhase === "vote") voteNow(entries);
      }, rand(3000, 8000));
    }
  });

  setInterval(() => {
    if (currentPhase === "vote" && !hasVoted && entriesReceived.length > 1) {
      voteNow(entriesReceived);
    }
  }, 1000);

  function trySubmit() {
    if (!currentAcronym || hasSubmitted || currentPhase !== "submit") return;

    const words = currentAcronym
      .toUpperCase()
      .split("")
      .map((letter, i) => getWordForLetter(letter, i));

    const answer = words.join(" ");
    socket.emit("submit_entry", { room: ROOM, text: answer });
    console.log(`[${username}] ✍️ Submitted: ${answer}`);
    hasSubmitted = true;

    if (!hasTaunted) {
      setTimeout(() => {
        sendChat(randomLine("submitTaunts"));
        hasTaunted = true;
      }, rand(1000, 3000));
    }
  }

  socket.on("disconnect", () => {
    console.log(`[${username}] ❌ Disconnected`);
  });
}

const botName = process.env.BOT_NAME || process.argv[2];
const roomName = process.env.ROOM || process.argv[3];

if (botName && roomName) {
  runBot(botName);
} else {
  console.log("❌ BOT_NAME and ROOM must be set");
  process.exit(1);
}














