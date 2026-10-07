// Shared by browser preview and Node WAV rendering. Order pitches first, then
// repeat each visit, so repeats stay consecutive in every arpeggio pattern.
(function (root) {
  function repeatCount(value) {
    return Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 1;
  }
  function orderFrequencies(frequencies, pattern, repeats = []) {
    const sorted = frequencies.map((frequency, index) => ({ frequency, count: repeatCount(repeats[index]) }))
      .sort((a, b) => a.frequency - b.frequency);
    let ordered = sorted;
    if (pattern === 'down') ordered = [...sorted].reverse();
    else if (pattern === 'updown') ordered = [...sorted, ...sorted.slice(1, -1).reverse()];
    else if (pattern === 'random') {
      ordered = [...sorted];
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
    }
    return ordered.flatMap(note => Array(note.count).fill(note.frequency));
  }
  const api = { repeatCount, orderFrequencies };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SynBraneArp = api;
})(typeof globalThis === 'object' ? globalThis : this);
