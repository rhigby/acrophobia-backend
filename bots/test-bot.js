const { io } = require("socket.io-client");
const path = require("path");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { english } = require("wordlist-english");
const wordList = english["english"] || [];
const DICTIONARY = new Set(
  (Array.isArray(wordList) ? wordList : [])
    .filter(w => typeof w === "string" && w.length <= 10 && !w.endsWith("s") && /^[a-zA-Z]+$/.test(w))
);
console.log(wordList);
const SERVER_URL = process.env.SERVER_URL || "https://acrophobia-backend-2.onrender.com";
const ROOM = process.env.ROOM || "room1";
const PASSWORD = process.env.PASSWORD || "bot123";

const { getThemeForRoom } = require("../utils/profanityFilter");
const chatLines = require("./chatDictionary");

const theme = getThemeForRoom(ROOM);
const themePath = path.join(__dirname, "themes", `${theme}.json`);
const wordBank = JSON.parse(fs.readFileSync(themePath, "utf8"));

const wordMapByLetter = {};
for (let word of DICTIONARY) {
  const first = word[0].toUpperCase();
  if (!wordMapByLetter[first]) wordMapByLetter[first] = [];
  wordMapByLetter[first].push(word);
}

const usedChatLinesGlobal = {
  greetings: new Set(),
  submitTaunts: new Set(),
  voteReactions: new Set(),
  resultReactions: new Set(),
};

let hasGreeted = false;
let hasTauntedThisRound = false;
let submittedAnswerThisRound = false;

function sendChat(socket, text) {
  socket.emit("chat_message", {
    room: ROOM,
    username: botName,
    text,
    isBot: true
  });
}

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

function getWordForLetter(letter, index) {
  const upper = letter.toUpperCase();
  const dictPool = wordMapByLetter[upper] || [];
  const themePool = Array.isArray(wordBank[upper]) ? wordBank[upper] : [];

  const dictSample = dictPool.filter(w => typeof w === "string" && w.length <= 10 && /^[a-zA-Z]+$/.test(w));
  const themeSample = themePool.filter(w => typeof w === "string" && w.length <= 10 && /^[a-zA-Z]+$/.test(w));

  const combinedPool = [...dictSample, ...themeSample];

  if (combinedPool.length === 0) {
    console.warn(`⚠️ No usable words for letter: ${upper}`);
    return upper;
  }

  const adjRegex = /ly$|ous$|ive$|ful$|ic$|al$/;
  const grammarIsAdjective = index % 2 === 0;

  let filtered = grammarIsAdjective
    ? combinedPool.filter(w => w.match(adjRegex))
    : combinedPool.filter(w => !w.match(adjRegex));

  if (filtered.length === 0) {
    console.warn(`🪂 Fallback to combined pool (no grammar match) for ${upper}`);
    filtered = combinedPool;
  }

  const word = filtered[Math.floor(Math.random() * filtered.length)];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function say(text) {
  console.log(`[BOT_CHAT] ${text}`);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isMostlyWords(text) {
  const words = text.trim().split(/\s+/);
  let validCount = 0;

  for (let word of words) {
    const cleanWord = word.toLowerCase().replace(/[^a-z]/gi, "");
    if (DICTIONARY.has(cleanWord)) {
      validCount++;
    }
  }

  return validCount >= Math.floor(words.length * 0.6);
}

async function loginOrRegister(username) {
  const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });

  if (loginRes.ok) {
    const data = await loginRes.json();
    console.log(`[${username}] Logged in`);
    return data.token;
  }

  const errorText = await loginRes.text();
  console.log(`[${username}] Login failed, registering... (${errorText})`);

  const registerRes = await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@bots.fake`,
      password: PASSWORD,
    }),
  });

  if (!registerRes.ok && registerRes.status !== 409) {
    const regErr = await registerRes.text();
    throw new Error(`[${username}] Registration failed: ${regErr}`);
  }

  const retryRes = await fetch(`${SERVER_URL}/api/login-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });

  if (!retryRes.ok) {
    const err = await retryRes.text();
    throw new Error(`[${username}] Login after registration failed: ${err}`);
  }

  const data = await retryRes.json();
  return data.token;
}

async function runBot(username) {
  try {
    const token = await loginOrRegister(username);

    const socket = io(SERVER_URL, {
      auth: { token },
      transports: ["websocket"],
    });

    let canSubmit = false;
    let hasSubmitted = false;
    let hasVoted = false;
    let currentAcronym = null;
    let currentPhase = "";
    let entriesReceived = [];
    let currentRound = 1;

    socket.on("round_number", (round) => {
      currentRound = round;
      hasTauntedThisRound = false;
      submittedAnswerThisRound = false;
      console.log(`[${username}] 📢 Received round_number: ${round}`);
    });

    let votedForUser = null;
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

    function trySubmit(source) {
      if (!canSubmit || hasSubmitted || !currentAcronym) return;

      const letters = currentAcronym.trim().toUpperCase().split("");
      if (letters.length < 2) {
        console.warn(`[${username}] ❌ Skipping acronym too short: ${currentAcronym}`);
        return;
      }

      const words = letters.map((letter, index) => getWordForLetter(letter, index));
      const answer = words.join(" ");
      const wordCount = answer.trim().split(/\s+/).length;

      if (wordCount === letters.length) {
        const minDelay = 10000 + (currentRound - 1) * 5000;
        const maxDelay = 25000 + (currentRound - 1) * 5000;
        const delay = rand(minDelay, maxDelay);

        setTimeout(() => {
          socket.emit("submit_entry", { room: ROOM, text: answer });
          console.log(`[${username}] ✍️ Submitted: ${answer} after ${delay}ms`);
          hasSubmitted = true;
          submittedAnswerThisRound = true;

          if (!hasTauntedThisRound) {
            setTimeout(() => {
              sendChat(socket, randomLine("submitTaunts"));
              hasTauntedThisRound = true;
            }, rand(1000, 3000));
          }
        }, delay);
      } else {
        console.warn(`[${username}] 🚫 Invalid answer: "${answer}"`);
      }
    }

    socket.on("connect", () => {
      console.log(`[${username}] Connected`);
      socket.emit("join_room", { room: ROOM });

      if (!hasGreeted) {
        setTimeout(() => {
          sendChat(socket, randomLine("greetings"));
          hasGreeted = true;
        }, rand(1000, 4000));
      }
    });

    socket.on("phase", (phase) => {
      currentPhase = phase;
      canSubmit = phase === "submit" || phase === "faceoff_submit";
      hasSubmitted = false;
      hasVoted = false;

      if (phase === "results" && votedForUser) {
        setTimeout(() => {
          sendChat(socket, randomLine("voteReactions", votedForUser));
          votedForUser = null;
        }, rand(1000, 4000));
      }

      console.log(`[${username}] Phase: ${phase}`);
    });

    socket.on("acronym", (acronym) => {
      currentAcronym = acronym;
      console.log(`[${username}] Received acronym: ${acronym}`);
    });

    socket.on("acronym_ready", () => {
      trySubmit("acronym_ready");
    });

    socket.on("entries", (entries) => {
      entriesReceived = entries;

      if (!hasVoted && currentPhase === "vote") {
        const delay = rand(3000, 8000);
        setTimeout(() => {
          if (!hasVoted && currentPhase === "vote") {
            voteNow(entries);
          }
        }, delay);
      }
    });

    setInterval(() => {
      if (currentPhase === "vote" && !hasVoted && entriesReceived.length > 1) {
        voteNow(entriesReceived);
      }
    }, 1000);

    socket.on("disconnect", () => {
      console.log(`[${username}] ❌ Disconnected`);
    });
  } catch (err) {
    console.error(`[${username} ERROR]: ${err.message}`);
    process.exit(1);
  }
}

const botName = process.env.BOT_NAME || process.argv[2];
const roomName = process.env.ROOM || process.argv[3];

if (botName && roomName) {
  runBot(botName);
} else {
  console.log("❌ BOT_NAME and ROOM must be set");
  process.exit(1);
}












