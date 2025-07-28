const fs = require("fs");
const path = require("path");

const themeCache = {};

function loadTheme(themeName) {
  if (!themeCache[themeName]) {
    const filePath = path.join(__dirname, "themes", `${themeName}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    themeCache[themeName] = JSON.parse(raw);
  }
  return themeCache[themeName];
}

function getWordForLetter(letter, index, themeName = "general") {
  const theme = loadTheme(themeName);
  const list = index % 2 === 0 ? theme.adjectives : theme.nouns;
  const options = list.filter(word => word[0].toUpperCase() === letter.toUpperCase());
  return options.length > 0
    ? options[Math.floor(Math.random() * options.length)]
    : letter;
}

module.exports = { getWordForLetter };

