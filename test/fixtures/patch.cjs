module.exports = function patch() {
  return { version: 1, loopChordCount: 4,
    global: { mode: 'harmony', tempo: 120, rhythmMultiplier: 0.3,
      synth: { waveform: 'sine', volume: 1, detuneCents: 3,
        envelope: { attackMs: 10, decayMs: 150, sustainLevel: 0.7, releaseMs: 200 },
        filter: { cutoffHz: 12000, resonance: 0.2 } },
      arpeggiator: { enabled: true, pattern: 'up', rate: '1/8' },
      preview: { arpeggiate: false, arpRateMs: 180, loop: false } },
    chords: Array.from({ length: 5 }, () => ({ tuningId: 'edo:12', root: 0,
      notes: [0, 4, 7], preset: 'major-triad', arp: { enabled: false, pattern: 'up', rate: '1/8' } })) };
};
