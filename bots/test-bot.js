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














