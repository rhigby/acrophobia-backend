// profanityFilter.js

const profanityBank = {
  general: [
    "damn", "hell", "shit", "fuck", "crap", "bastard", "bitch",
    "piss", "douche", "dick", "cock", "asshole", "balls", "slut",
    "prick", "jerk", "screw", "bloody"
  ],
  sexual: [
    "penis", "vagina", "pussy", "boobs", "tits", "dildo", "horny",
    "sex", "sexy", "cum", "orgasm", "anal", "nipple", "buttplug",
    "blowjob", "handjob", "fuck", "jerkoff", "masturbate", "69"
  ],
  hate: [
    "nigger", "kike", "chink", "gook", "spic", "wetback", "faggot",
    "dyke", "retard", "tranny", "towelhead", "raghead", "coon",
    "zipperhead", "nigga", "cripple", "homo", "slant", "paki"
  ],
  body: [
    "boobs", "tits", "ass", "dick", "cock", "balls", "pussy",
    "butt", "genitals", "penis", "vagina", "nipples", "scrotum"
  ],
  violence: [
    "kill", "murder", "bomb", "attack", "explode", "stab",
    "shoot", "gun", "blood", "rape", "slaughter", "terrorist"
  ]
};

function containsInappropriate(text) {
  const lowered = text.toLowerCase();
  const words = lowered.split(/\W+/); // split by non-word characters
  for (const [category, profanities] of Object.entries(profanityBank)) {
    for (const profanity of profanities) {
      if (words.includes(profanity)) {
        return { matched: profanity, category };
      }
    }
  }
  return false;
}

const roomSettings = {
   Eighties: {
    displayName: "80's Theme",
    filterProfanity: true,
    theme: "eighties"
  },
   Ninties: {
    displayName: "90's Theme",
    filterProfanity: true,
    theme: "ninties"
  },
  CleanFun: {
    displayName: "Clean Fun",
    filterProfanity: true,
    theme: "general"
  },
  SportsArena: {
    displayName: "Sports Arena",
    filterProfanity: true,
    theme: "sports"
  },
   AnythingGoes: {
    displayName: "Anything Goes",
    filterProfanity: false,
    theme: "anything"
  },
    LateNight: {
    displayName: "Late Night",
    filterProfanity: false,
    theme: "anything"
  },
   TheCouch: {
    displayName: "The Couch",
    filterProfanity: false,
    theme: "anything"
  }
};

function getThemeForRoom(roomName) {
  return roomSettings[roomName]?.theme || "general";
}

module.exports = {
  containsInappropriate,
  profanityBank,
  roomSettings,
  getThemeForRoom
};

