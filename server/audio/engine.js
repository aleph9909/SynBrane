const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function applyNormalization(samples, targetDb = -4, volume = 1) {
  const targetPeak = dbToLinear(targetDb);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }

  if (peak === 0) {
    return { gain: 1, peak };
  }

  const gain = (targetPeak / peak) * clamp(Number(volume) || 0, 0, 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= gain;
  }

  return { gain, peak };
}

const DRUM_ROLE_CONFIG = {
  kick: { amplitude: 1, attack: 0.003, decay: 0.32, baseFrequency: 55, partials: [1, 2.1, 2.9], noiseMix: 0.05, saturation: 0 },
  snare: {
    amplitude: 0.85,
    attack: 0.002,
    decay: 0.22,
    baseFrequency: 185,
    partials: [1.4, 2.4, 3.6, 4.5],
    noiseMix: 0.65,
    saturation: 0,
  },
  closedHat: { amplitude: 0.6, attack: 0.0015, decay: 0.12, baseFrequency: 4200, partials: [3, 5, 7, 9], noiseMix: 0.75, saturation: 0 },
  openHat: { amplitude: 0.55, attack: 0.002, decay: 0.35, baseFrequency: 3600, partials: [3, 6, 9, 12], noiseMix: 0.75, saturation: 0 },
  lowTom: { amplitude: 0.8, attack: 0.003, decay: 0.22, baseFrequency: 130, partials: [1, 2.2, 3.1], noiseMix: 0.12, saturation: 0 },
  highTom: { amplitude: 0.75, attack: 0.003, decay: 0.18, baseFrequency: 200, partials: [1, 2.4, 3.6], noiseMix: 0.12, saturation: 0 },
  clap: { amplitude: 0.6, attack: 0.001, decay: 0.18, baseFrequency: 900, partials: [2.2, 3.5], noiseMix: 0.95, saturation: 0 },
  perc: { amplitude: 0.55, attack: 0.001, decay: 0.14, baseFrequency: 320, partials: [2, 5, 7], noiseMix: 0.4, saturation: 0 },
};

function arpeggioStepDuration(rate, bpm) {
  const secondsPerBeat = 60 / Math.max(1, bpm || 120);
  const map = {
    '1/4': 1,
    '1/8': 0.5,
    '1/8T': 1 / 3,
    '1/16': 0.25,
  };
  const portion = map[rate] ?? 0.5;
  return secondsPerBeat * portion;
}

const { orderFrequencies: arpeggioCycle } = require('../../public/arp-pattern');

function normalizeSynthSettings(raw = {}) {
  const envelope = raw.envelope || raw.adsr || {};
  const filter = raw.filter || {};
  return {
    waveform: raw.waveform || 'saw',
    envelope: {
      attackMs: clamp(Number(envelope.attackMs ?? 40), 0, 5000),
      decayMs: clamp(Number(envelope.decayMs ?? 200), 0, 5000),
      sustainLevel: clamp(Number(envelope.sustainLevel ?? 0.7), 0, 1),
      releaseMs: clamp(Number(envelope.releaseMs ?? 800), 0, 5000),
    },
    filter: {
      cutoffHz: clamp(Number(filter.cutoffHz ?? 12000), 50, 20000),
      resonance: clamp(Number(filter.resonance ?? 0.2), 0, 1),
    },
    detuneCents: clamp(Number(raw.detuneCents ?? 0), 0, 50),
    volume: clamp(Number(raw.volume ?? 1), 0, 2),
  };
}

function createAdsrEnvelope(totalSamples, sampleRate, sustainUntil, envelope) {
  const env = new Float32Array(totalSamples);
  const attack = envelope.attackMs / 1000;
  const decay = envelope.decayMs / 1000;
  const release = envelope.releaseMs / 1000;
  const sustain = envelope.sustainLevel;
  const sustainEnd = Math.max(sustainUntil, attack + decay);

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate;
    if (attack > 0 && t < attack) {
      env[i] = t / attack;
    } else if (decay > 0 && t < attack + decay) {
      const progress = (t - attack) / Math.max(decay, 1e-6);
      env[i] = 1 - (1 - sustain) * progress;
    } else if (t < sustainEnd) {
      env[i] = sustain;
    } else if (release > 0) {
      const releasePos = (t - sustainEnd) / release;
      env[i] = Math.max(0, sustain * (1 - releasePos));
    } else {
      env[i] = sustain;
    }
  }

  return env;
}

function waveSample(phase, waveform) {
  const twoPi = Math.PI * 2;
  const wrapped = phase % twoPi;
  if (waveform === 'square') {
    return wrapped < Math.PI ? 1 : -1;
  }
  if (waveform === 'saw') {
    return 1 - (2 * wrapped) / twoPi;
  }
  return Math.sin(wrapped);
}

function applyLowPassFilter(samples, sampleRate, cutoffHz, resonance = 0.2) {
  const nyquist = sampleRate / 2;
  const cutoff = clamp(cutoffHz, 50, nyquist - 100);
  const q = 0.5 + resonance * 11.5; // map 0–1 to a musically useful Q span
  const omega = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cosw = Math.cos(omega);

  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    samples[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
}

function rhythmStepCount(speed) {
  const value = clamp(Number(speed) || 0.3, 0.1, 1);
  if (value < 0.25) return 4;
  if (value < 0.5) return 8;
  if (value < 0.75) return 12;
  return 16;
}

function buildRhythmPattern({ degrees = [], durationSeconds, bpm, rhythmSpeed, fallbackCount = 0 }) {
  const steps = rhythmStepCount(rhythmSpeed);
  const stepDuration = durationSeconds / steps;
  const events = [];
  const addEvent = (role, step, velocity = 1) => {
    const clampedStep = Math.max(0, Math.min(steps - 1, Math.round(step)));
    events.push({
      role,
      time: clampedStep * stepDuration,
      velocity: Math.max(0.25, Math.min(1.1, velocity)),
    });
  };

  const quarter = steps / 4;
  addEvent('kick', 0, 1);
  addEvent('kick', quarter * 2, 0.9);
  addEvent('snare', quarter, 0.9);
  addEvent('snare', quarter * 3, 0.95);

  const hatSpacing = rhythmSpeed > 0.75 ? 1 : rhythmSpeed > 0.5 ? 2 : rhythmSpeed > 0.35 ? 4 : 8;
  for (let step = 0; step < steps; step += hatSpacing) {
    addEvent('closedHat', step, 0.55 + 0.25 * rhythmSpeed);
  }
  addEvent('openHat', Math.max(1, steps - Math.round(steps / 4)), 0.65 + 0.25 * rhythmSpeed);

  const degreeSource = degrees?.length
    ? Array.from(new Set(degrees)).sort((a, b) => a - b)
    : Array.from({ length: Math.max(1, fallbackCount || 1) }, (_, idx) => idx);
  const roleOrder = ['kick', 'snare', 'closedHat', 'openHat', 'lowTom', 'highTom', 'clap', 'perc'];
  degreeSource.forEach((deg, idx) => {
    const role = roleOrder[Math.min(idx, roleOrder.length - 1)];
    const baseStep = Math.abs(deg) % steps;
    const repeats = rhythmSpeed > 0.7 ? 2 : 1;
    for (let rep = 0; rep < repeats; rep += 1) {
      const offsetStep = (baseStep + rep * Math.max(1, Math.floor(steps / (repeats * 4)))) % steps;
      const velocity = Math.max(0.35, 0.9 - idx * 0.08 + rhythmSpeed * 0.1);
      addEvent(role, offsetStep, velocity);
    }
  });

  events.sort((a, b) => a.time - b.time);
  return { events, duration: durationSeconds + 0.3 };
}

function addRhythmPatternHits(samples, startSample, sampleRate, pattern) {
  pattern.events.forEach((event) => {
    const baseConfig = DRUM_ROLE_CONFIG[event.role] || DRUM_ROLE_CONFIG.perc;
    const amplitude = clamp((baseConfig.amplitude || 0.6) * event.velocity, 0, 1);
    addPercussiveHit(samples, startSample + Math.floor(event.time * sampleRate), sampleRate, {
      ...baseConfig,
      amplitude,
    });
  });

  return pattern.duration;
}

function generateArpeggiatedSamples({ frequencies, duration, sampleRate, synth, bpm, arpeggio }) {
  const pattern = arpeggioCycle(frequencies, arpeggio?.pattern || 'up', arpeggio?.repeats);
  const stepDuration = arpeggioStepDuration(arpeggio?.rate || '1/8', bpm);
  if (!pattern.length || !Number.isFinite(stepDuration) || stepDuration <= 0) return null;

  const baseDuration = duration || 1;
  const releaseSeconds = synth.envelope.releaseMs / 1000;
  const totalDuration = baseDuration + releaseSeconds;
  const totalSamples = Math.max(1, Math.floor(sampleRate * totalDuration));
  const samples = new Float32Array(totalSamples);
  const steps = Math.max(1, Math.floor(baseDuration / stepDuration));

  for (let step = 0; step < steps; step += 1) {
    const noteStart = step * stepDuration;
    const remaining = baseDuration - step * stepDuration;
    if (remaining <= 0) break;
    const noteDuration = Math.min(stepDuration, remaining);
    const noteTotalDuration = noteDuration + releaseSeconds;
    const totalNoteSamples = Math.max(1, Math.floor(noteTotalDuration * sampleRate));
    const envelope = createAdsrEnvelope(totalNoteSamples, sampleRate, noteDuration, synth.envelope);
    const baseFreq = pattern[step % pattern.length];
    const detune = synth.detuneCents ? 2 ** (((Math.random() * 2 - 1) * synth.detuneCents) / 1200) : 1;
    const freq = baseFreq * detune;
    let phase = 0;
    const phaseIncrement = (2 * Math.PI * freq) / sampleRate;
    const startSample = Math.floor(noteStart * sampleRate);
    for (let i = 0; i < totalNoteSamples && startSample + i < samples.length; i += 1) {
      samples[startSample + i] += waveSample(phase, synth.waveform) * envelope[i] * 0.5;
      phase += phaseIncrement;
    }
  }

  if (synth.filter && synth.filter.cutoffHz) {
    applyLowPassFilter(samples, sampleRate, synth.filter.cutoffHz, synth.filter.resonance);
  }

  return samples;
}

function generateChordSamples({ mode, frequencies = [], degrees = [], duration, sampleRate, mappingFactor, synthSettings, bpm = 120, arpeggio }) {
  if (mode === 'rhythm') {
    const speed = clamp(mappingFactor ?? 0.3, 0.1, 1);
    const durationSeconds = duration || 1;
    const pattern = buildRhythmPattern({
      degrees,
      durationSeconds,
      bpm,
      rhythmSpeed: speed,
      fallbackCount: frequencies.length || degrees.length,
    });
    const totalSamples = Math.max(1, Math.floor(sampleRate * pattern.duration));
    const samples = new Float32Array(totalSamples);
    addRhythmPatternHits(samples, 0, sampleRate, pattern);
    applyLowPassFilter(samples, sampleRate, Math.min(sampleRate / 2 - 500, 16000), 0.12);
    return samples;
  }

  const synth = normalizeSynthSettings(synthSettings);
  if (arpeggio?.enabled) {
    const arpeggiated = generateArpeggiatedSamples({
      frequencies,
      duration,
      sampleRate,
      synth,
      bpm,
      arpeggio,
    });
    if (arpeggiated) return arpeggiated;
  }
  const baseDuration = duration || 1;
  const releaseSeconds = synth.envelope.releaseMs / 1000;
  const totalDuration = baseDuration + releaseSeconds;
  const totalSamples = Math.max(1, Math.floor(sampleRate * totalDuration));
  const samples = new Float32Array(totalSamples);
  const envelope = createAdsrEnvelope(totalSamples, sampleRate, baseDuration, synth.envelope);
  const amplitude = 0.5 / Math.max(frequencies.length, 1);

  frequencies.forEach((baseFreq) => {
    const detune = synth.detuneCents ? 2 ** (((Math.random() * 2 - 1) * synth.detuneCents) / 1200) : 1;
    const freq = baseFreq * detune;
    let phase = 0;
    const phaseIncrement = (2 * Math.PI * freq) / sampleRate;
    for (let i = 0; i < totalSamples; i += 1) {
      samples[i] += waveSample(phase, synth.waveform) * envelope[i] * amplitude;
      phase += phaseIncrement;
    }
  });

  if (synth.filter && synth.filter.cutoffHz) {
    applyLowPassFilter(samples, sampleRate, synth.filter.cutoffHz, synth.filter.resonance);
  }

  return samples;
}

function addPercussiveHit(samples, startSample, sampleRate, {
  amplitude = 1,
  attack = 0.004,
  decay = 0.12,
  baseFrequency = 80,
  partials = [1, 2, 3, 4],
  noiseMix = 0.25,
  saturation = 0,
} = {}) {
  const attackSamples = Math.max(1, Math.floor(attack * sampleRate));
  const decaySamples = Math.max(1, Math.floor(decay * sampleRate));
  const totalSamples = attackSamples + decaySamples;
  const nyquist = sampleRate / 2;
  const safeMaxFreq = nyquist * 0.95;
  const filteredPartials = (partials || [])
    .filter((partial) => partial > 0 && baseFrequency * partial < safeMaxFreq)
    .sort((a, b) => a - b);
  const partialSet = filteredPartials.length ? filteredPartials : [1];

  for (let i = 0; i < totalSamples; i += 1) {
    const env = i < attackSamples
      ? i / attackSamples
      : 1 - (i - attackSamples) / decaySamples;
    const time = i / sampleRate;
    let sampleValue = 0;

    if (noiseMix > 0) {
      sampleValue += (Math.random() * 2 - 1) * noiseMix;
    }

    partialSet.forEach((partial, index) => {
      const weight = 1 / Math.max(1.5, index + 1);
      sampleValue += Math.sin(2 * Math.PI * baseFrequency * partial * time) * weight;
    });

    const targetIndex = startSample + i;
    if (targetIndex < samples.length) {
      const raw = sampleValue * env * amplitude;
      const soft = saturation > 0 ? Math.tanh(raw * (1 + saturation * 2)) : raw;
      samples[targetIndex] += soft;
    }
  }
}

function generateSequenceSamples({ mode, events, bpm, sampleRate, mappingFactor, synthSettings }) {
  const beatsPerBar = 4;
  const secondsPerBeat = 60 / bpm;
  const barDuration = secondsPerBeat * beatsPerBar;
  const normalizedSynth = mode === 'harmony' ? normalizeSynthSettings(synthSettings) : null;
  const releaseSeconds = normalizedSynth ? normalizedSynth.envelope.releaseMs / 1000 : 0;
  const totalBars = Math.max(...events.map((event) => (event.bar || 0) + (event.durationBars || 1)), 1);
  const totalDuration = totalBars * barDuration + releaseSeconds;
  const totalSamples = Math.ceil(sampleRate * totalDuration);
  const samples = new Float32Array(totalSamples);

  events.forEach((event) => {
    const startTime = barDuration * (event.bar || 0);
    const duration = barDuration * (event.durationBars || 1);
    const startSample = Math.floor(startTime * sampleRate);
    const buffer = generateChordSamples({
      mode,
      frequencies: event.frequencies || [],
      degrees: event.degrees || event.customChord?.degrees || [],
      duration,
      sampleRate,
      mappingFactor,
      synthSettings: normalizedSynth || synthSettings,
      bpm,
      arpeggio: event.arpeggio,
    });
    const copyLength = Math.min(buffer.length, samples.length - startSample);
    for (let i = 0; i < copyLength; i += 1) {
      samples[startSample + i] += buffer[i];
    }
  });

  return samples;
}

function encodeWav(samples, sampleRate) {
  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

function renderToFile({ mode, frequencies, degrees = [], duration, mappingFactor, rhythmSpeed, events, bpm, synthSettings, arpeggio }) {
  ensureDir(config.renderOutputDir);
  const sampleRate = config.renderSampleRate;
  const effectiveMapping = rhythmSpeed ?? mappingFactor;
  const normalizedSynth = normalizeSynthSettings(synthSettings || {});
  let samples;
  if (Array.isArray(events) && events.length) {
    samples = generateSequenceSamples({ mode, events, bpm: bpm || 120, sampleRate, mappingFactor: effectiveMapping, synthSettings });
  } else {
    samples = generateChordSamples({
      mode,
      frequencies,
      degrees,
      duration,
      sampleRate,
      mappingFactor: effectiveMapping,
      synthSettings,
      bpm: bpm || 120,
      arpeggio,
    });
  }
  applyNormalization(samples, -4, normalizedSynth.volume);
  const wav = encodeWav(samples, sampleRate);
  const filename = `render-${mode}-${Date.now()}.wav`;
  const filePath = path.join(config.renderOutputDir, filename);
  fs.writeFileSync(filePath, wav);
  return { filePath, filename };
}

function playRealtime(job) {
  // Placeholder for SuperCollider integration. In a full build, this would
  // send OSC messages or score data to scsynth/sclang. Here we simply log the
  // job so that the backend can be wired to a sound engine later.
  // eslint-disable-next-line no-console
  console.log('[playRealtime]', { ...job, loopCount: job.loopCount || 1, synthSettings: normalizeSynthSettings(job.synthSettings) });
  return { status: 'scheduled' };
}

module.exports = { renderToFile, playRealtime };
