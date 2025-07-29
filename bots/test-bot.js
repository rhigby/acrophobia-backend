const { io } = require("socket.io-client");
const path = require("path");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
  if (!bank) {
    console.warn(`⚠️ No entry for letter: ${upper}`);
    return upper;
  }
  const pool = index % 2 === 0 ? bank.adjectives : bank.nouns;
  return pool[Math.floor(Math.random() * pool.length)];
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
      console.log(`[${username}] 📢 Received round_number: ${round}`);
    });


    function voteNow(entries) {
      const valid = entries.filter((e) => e.username !== username);
      if (valid.length === 0) return;

      const pick =
        Math.random() < 0.7
          ? valid.sort((a, b) => b.text.length - a.text.length)[0]
          : valid[rand(0, valid.length - 1)];

      socket.emit("vote_entry", { room: ROOM, entryId: pick.id });
      console.log(`[${username}] ✅ Voted for: ${pick.text}`);
      hasVoted = true;
    }

    function buildAnswer(acronym) {
      const words = acronym.toUpperCase().split("").map((letter, index) =>
        getWordForLetter(letter, index)
      );
      return words.join(" ");
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
          console.log(`[${username}] ✍️ Submitted (${source}): ${answer} after ${delay}ms`);
        }, delay);
        hasSubmitted = true;
      } else {
        console.warn(`[${username}] 🚫 Invalid answer (${source}): "${answer}"`);
      }
    }

    socket.on("connect", () => {
      console.log(`[${username}] Connected`);
      socket.emit("join_room", { room: ROOM });
    });

    socket.on("phase", (phase) => {
      currentPhase = phase;
      canSubmit = phase === "submit" || phase === "faceoff_submit";
      hasSubmitted = false;
      hasVoted = false;
      console.log(`[${username}] Phase: ${phase}`);
    });

   socket.on("acronym", (acronym) => {
    currentAcronym = acronym;
    console.log(`[${username}] Received acronym: ${acronym}`);
    // defer submission until "acronym_ready"
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

    // Fallback voting loop
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




// 👇 Prevent duplicate launch and enforce unique usernames
// const baseNames = ["bot1", "bot2", "bot3", "bot4"];
// baseNames.forEach(base => {
//   const botUsername = `${ROOM}-${base}`;
//   runBot(botUsername);
// });









