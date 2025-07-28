const { io } = require("socket.io-client");
const fetch = require("node-fetch");

const SERVER_URL = "https://acrophobia-backend-2.onrender.com";
const ROOM = "Eighties";
const PASSWORD = "bot123";

// Adjective and Noun word bank
const wordBank = {
  A: {
    adjectives: ["Amazing", "Awkward", "Agile", "Ancient", "Angry", "Adorable", "Ambitious", "Aromatic", "Artful", "Astounding"],
    nouns: ["Alligator", "Apple", "Artist", "Axe", "Astronaut", "Ant", "Arrow", "Avocado", "Anchor", "Alarm"]
  },
  B: {
    adjectives: ["Brave", "Bold", "Brilliant", "Bouncy", "Big", "Busy", "Bitter", "Bright", "Blissful", "Buzzing"],
    nouns: ["Bear", "Book", "Balloon", "Butterfly", "Banana", "Box", "Bottle", "Bridge", "Bee", "Bus"]
  },
  C: {
    adjectives: ["Clever", "Crazy", "Cool", "Charming", "Creative", "Curious", "Crisp", "Cheerful", "Colorful", "Cozy"],
    nouns: ["Cat", "Car", "Cloud", "Candle", "Cookie", "Clock", "Cactus", "Castle", "Cup", "Chair"]
  },
  D: {
    adjectives: ["Daring", "Dusty", "Dizzy", "Dynamic", "Dramatic", "Delightful", "Dangerous", "Dapper", "Dull", "Drifty"],
    nouns: ["Dog", "Drum", "Duck", "Desk", "Diamond", "Donkey", "Door", "Dolphin", "Drawer", "Dragon"]
  },
  E: {
    adjectives: ["Eager", "Epic", "Elegant", "Energetic", "Eccentric", "Exciting", "Earthy", "Easygoing", "Ethereal", "Enchanting"],
    nouns: ["Elephant", "Egg", "Engine", "Eagle", "Envelope", "Earth", "Elf", "Exit", "Eye", "Elevator"]
  },
  F: {
    adjectives: ["Funny", "Fierce", "Funky", "Fast", "Fluffy", "Frantic", "Fresh", "Frosty", "Fragrant", "Fuzzy"],
    nouns: ["Fox", "Fan", "Feather", "Fork", "Fire", "Fish", "Frog", "Fence", "Flower", "Flag"]
  },
  G: {
    adjectives: ["Grumpy", "Golden", "Goofy", "Gentle", "Giant", "Gleaming", "Glorious", "Greedy", "Giddy", "Gracious"],
    nouns: ["Giraffe", "Guitar", "Goat", "Ghost", "Gem", "Gate", "Glove", "Glacier", "Gnome", "Glass"]
  },
  H: {
    adjectives: ["Happy", "Heroic", "Hungry", "Hot", "Hilarious", "Harsh", "Humble", "Haunted", "Helpful", "Hopeful"],
    nouns: ["Horse", "Hat", "Helicopter", "Hammer", "House", "Hill", "Hawk", "Hose", "Heart", "Helmet"]
  },
  I: {
    adjectives: ["Icy", "Ideal", "Impressive", "Invisible", "Illusive", "Incredible", "Intense", "Innovative", "Intelligent", "Iridescent"],
    nouns: ["Igloo", "Ink", "Insect", "Island", "Iron", "Idea", "Iceberg", "Image", "Internet", "Invitation"]
  },
  J: {
    adjectives: ["Jolly", "Jealous", "Jagged", "Joyful", "Jumpy", "Juicy", "Jazzy", "Jaded", "Judicious", "Jaunty"],
    nouns: ["Jaguar", "Jelly", "Jeep", "Jewel", "Jar", "Jungle", "Jacket", "Joystick", "Journal", "Jump rope"]
  },
  K: {
    adjectives: ["Kind", "Kooky", "Klutzy", "Keen", "Knockout", "Knowledgeable", "Knavish", "Kinetic", "Keyed-up", "Kosher"],
    nouns: ["Kangaroo", "Key", "Kite", "Knife", "Kiwi", "Kernel", "Kitten", "Kiosk", "Keyboard", "King"]
  },
  L: {
    adjectives: ["Loud", "Lazy", "Lively", "Lucky", "Lovely", "Luminous", "Lanky", "Loyal", "Lush", "Legendary"],
    nouns: ["Lion", "Lamp", "Leaf", "Ladder", "Lemon", "Locket", "Lake", "Lizard", "Log", "Laptop"]
  },
  M: {
    adjectives: ["Mad", "Moody", "Mighty", "Magical", "Massive", "Merry", "Modern", "Mysterious", "Melodic", "Majestic"],
    nouns: ["Monkey", "Mountain", "Mug", "Moon", "Map", "Mouse", "Mirror", "Marker", "Motor", "Magazine"]
  },
  N: {
    adjectives: ["Noble", "Nutty", "Nifty", "Noisy", "Nervous", "Neat", "Naughty", "Nimble", "Narrow", "Natural"],
    nouns: ["Nose", "Notebook", "Needle", "Nest", "Net", "Necklace", "Ninja", "Nut", "Night", "Number"]
  },
  O: {
    adjectives: ["Odd", "Old", "Open", "Optimistic", "Outstanding", "Ordinary", "Orange", "Obvious", "Obedient", "Opulent"],
    nouns: ["Owl", "Orange", "Octopus", "Orb", "Onion", "Oven", "Ocean", "Oil", "Outlet", "Opera"]
  },
  P: {
    adjectives: ["Proud", "Playful", "Pink", "Powerful", "Puzzled", "Peaceful", "Prickly", "Polished", "Precise", "Poetic"],
    nouns: ["Penguin", "Pencil", "Pizza", "Pumpkin", "Puppy", "Pan", "Plane", "Peach", "Pig", "Parrot"]
  },
  Q: {
    adjectives: ["Quick", "Quiet", "Quirky", "Quaint", "Queasy", "Quarrelsome", "Qualified", "Quotable", "Questionable", "Quenched"],
    nouns: ["Queen", "Quilt", "Quartz", "Quokka", "Quiver", "Quest", "Quote", "Quail", "Queue", "Quarter"]
  },
  R: {
    adjectives: ["Rough", "Rapid", "Radical", "Rusty", "Rowdy", "Rational", "Reckless", "Radiant", "Rare", "Robust"],
    nouns: ["Rabbit", "Robot", "Rainbow", "Rock", "Rose", "Ring", "Road", "Radio", "Ruler", "Raccoon"]
  },
  S: {
    adjectives: ["Silly", "Sharp", "Spunky", "Sleepy", "Savage", "Sincere", "Shiny", "Speedy", "Sneaky", "Spicy"],
    nouns: ["Snake", "Sun", "Star", "Shell", "Sandwich", "Skateboard", "Spider", "Sock", "Sword", "Seal"]
  },
  T: {
    adjectives: ["Tiny", "Tired", "Tough", "Tenacious", "Terrific", "Timid", "Tasty", "Transparent", "Thrifty", "Tangy"],
    nouns: ["Tiger", "Table", "Turtle", "Train", "Tooth", "Tree", "Truck", "Towel", "Tent", "Trophy"]
  },
  U: {
    adjectives: ["Ugly", "Unique", "Untamed", "Unreal", "Upset", "Useful", "Ultra", "Unusual", "Urban", "Upbeat"],
    nouns: ["Umbrella", "Unicorn", "Urn", "Uniform", "Utility", "Universe", "Ukulele", "UFO", "Utensil", "Undertow"]
  },
  V: {
    adjectives: ["Vast", "Vivid", "Valiant", "Velvety", "Violent", "Vigorous", "Visible", "Vital", "Vengeful", "Vocal"],
    nouns: ["Violin", "Volcano", "Vampire", "Vase", "Vegetable", "Village", "Van", "Vest", "Vision", "Vine"]
  },
  W: {
    adjectives: ["Wild", "Witty", "Wobbly", "Weird", "Wacky", "Warm", "Windy", "Wicked", "Wise", "Woeful"],
    nouns: ["Wolf", "Watermelon", "Worm", "Whale", "Watch", "Wheel", "Window", "Wrench", "Wagon", "Wizard"]
  },
  X: {
    adjectives: ["Xenial", "Xtreme", "Xenophobic", "Xeno", "Xyloid", "Xanthic", "Xeric", "Xenogenetic", "Xenolithic", "Xenodochial"],
    nouns: ["Xylophone", "Xerus", "X-ray", "Xenops", "Xenon", "Xiphoid", "Xebec", "Xylitol", "Xenograft", "Xylograph"]
  },
  Y: {
    adjectives: ["Young", "Yawning", "Yearning", "Yummy", "Yappy", "Yellow", "Yielding", "Youthful", "Yonder", "Yucky"],
    nouns: ["Yak", "Yogurt", "Yacht", "Yarn", "Yam", "Yeti", "Yard", "Yearbook", "Yurt", "Yolk"]
  },
  Z: {
    adjectives: ["Zany", "Zesty", "Zealous", "Zippy", "Zigzag", "Zonked", "Zoological", "Zincous", "Zygotic", "Zapped"],
    nouns: ["Zebra", "Zoo", "Zucchini", "Zeppelin", "Zipper", "Zither", "Zone", "Zigzag", "Zookeeper", "Zodiac"]
  }
};


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

async function runBot(username) {
  let token;
  let currentAcronym = null;

  try {
    const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    const data = await loginRes.json();
    token = data.token;
  } catch {
    console.log(`[${username}] Login failed, registering instead`);
  }

  const socket = io(SERVER_URL, {
    auth: token ? { token } : {},
    transports: ["websocket"]
  });

  let canSubmit = false;
  let hasVoted = false;

  socket.on("connect", () => {
    console.log(`[${username}] Connected`);
    if (!token) {
      socket.emit("register", {
        username,
        email: `${username}@test.com`,
        password: PASSWORD
      }, async (res) => {
        if (res.success) {
          console.log(`[${username}] Registered`);
          const loginRes = await fetch(`${SERVER_URL}/api/login-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password: PASSWORD }),
          });
          const data = await loginRes.json();
          token = data.token;
          socket.auth = { token };
          socket.disconnect();
          socket.connect();
        } else {
          console.error(`[${username}] Registration failed: ${res.message}`);
        }
      });
    } else {
      socket.emit("join_room", { room: ROOM });
    }
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

["Bot1", "Bot2", "Bot3", "Bot4"].forEach(runBot);






