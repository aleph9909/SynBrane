const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { listTunings, chordsForTuning } = require('../tuning/tuningService');

const MAX_UPLOAD_BYTES = 16 * 1024;
const PATCH_ID = /^\d{13}-[a-f0-9]{24}$/;
const PRESET_ALIASES = { major: 'major-triad', minor: 'minor-triad', diminished: 'diminished-triad',
  augmented: 'augmented-triad', dom7: 'dominant-7', maj7: 'major-7', min7: 'minor-7' };

class PatchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, message) {
  if (!condition) throw new PatchError(400, message);
}
function object(value, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
  return value;
}
function number(value, min, max, name, integer = false) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max &&
    (!integer || Number.isInteger(value)), `${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
function text(value, max, name, optional = false) {
  if (optional && value == null) return '';
  requireValue(typeof value === 'string', `${name} must be text.`);
  const clean = value.trim();
  requireValue((optional || clean.length > 0) && clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean),
    `${name} must be ${optional ? 'at most ' : '1–'}${max} characters without control characters.`);
  return clean;
}
function choice(value, choices, name) {
  requireValue(choices.includes(value), `Unsupported ${name}.`);
  return value;
}
function boolean(value, name) {
  requireValue(typeof value === 'boolean', `${name} must be true or false.`);
  return value;
}
function arp(raw) {
  const value = object(raw, 'Arpeggiator');
  return { enabled: boolean(value.enabled, 'Arpeggiator enabled'),
    pattern: choice(value.pattern, ['up', 'down', 'updown', 'random'], 'arpeggiator pattern'),
    rate: choice(value.rate, ['1/4', '1/8', '1/8T', '1/16'], 'arpeggiator rate') };
}

// Rebuild the known schema instead of retaining arbitrary uploaded properties.
// Pitch values remain zero-based; displayed degree labels never enter storage.
function validatePatch(raw) {
  const patch = object(raw, 'Patch');
  requireValue(patch.version === 1, 'Only SynBrane version 1 patches are supported.');
  requireValue(Array.isArray(patch.chords) && patch.chords.length >= 1 && patch.chords.length <= 5,
    'A patch must contain 1–5 chords.');
  const loopChordCount = number(patch.loopChordCount, 1, patch.chords.length, 'Loop chord count', true);
  const available = new Map(listTunings().tunings.map(tuning => [tuning.id, tuning]));
  const chords = patch.chords.map((rawChord, index) => {
    const chord = object(rawChord, `Chord ${index + 1}`);
    const tuning = available.get(chord.tuningId);
    requireValue(tuning, `Chord ${index + 1} uses an unavailable tuning.`);
    const span = tuning.type === 'edo' ? tuning.value : tuning.intervals.length;
    const { chords: presets, roots } = chordsForTuning({ tuningId: tuning.id });
    const preset = PRESET_ALIASES[chord.preset] || chord.preset;
    requireValue(presets.some(item => item.id === preset), `Chord ${index + 1} uses an unavailable preset.`);
    requireValue(roots.some(item => item.value === chord.root), `Chord ${index + 1} has an invalid root.`);
    requireValue(Array.isArray(chord.notes) && chord.notes.length <= Math.min(384, span * 3), 'Too many notes.');
    const notes = chord.notes.map(note => number(note, 0, span * 3 - 1, 'Note degree', true));
    requireValue(new Set(notes).size === notes.length, 'Duplicate note degrees are not supported.');
    return { tuningId: tuning.id, root: chord.root, notes: notes.sort((a, b) => a - b), preset,
      arp: arp(chord.arp || { enabled: false, pattern: 'up', rate: '1/8' }) };
  });
  const global = object(patch.global, 'Global settings');
  const synth = object(global.synth, 'Synth');
  const envelope = object(synth.envelope, 'Envelope');
  const filter = object(synth.filter, 'Filter');
  const preview = object(global.preview || {}, 'Preview');
  const globalArp = global.arpeggiator || chords.find(chord => chord.arp.enabled)?.arp ||
    { enabled: false, pattern: 'up', rate: '1/8' };
  return { version: 1, loopChordCount, chords, global: {
    mode: choice(global.mode, ['harmony', 'rhythm'], 'sound engine'),
    tempo: number(global.tempo, 30, 300, 'Tempo'),
    rhythmMultiplier: number(global.rhythmMultiplier, 0.1, 1, 'Rhythm multiplier'),
    synth: {
      waveform: choice(synth.waveform, ['sine', 'saw', 'square'], 'waveform'),
      volume: number(synth.volume, 0, 1.5, 'Volume'),
      detuneCents: number(synth.detuneCents, 0, 15, 'Detune'),
      envelope: { attackMs: number(envelope.attackMs, 0, 1000, 'Attack'),
        decayMs: number(envelope.decayMs, 0, 1000, 'Decay'),
        sustainLevel: number(envelope.sustainLevel, 0, 1, 'Sustain'),
        releaseMs: number(envelope.releaseMs, 0, 2000, 'Release') },
      filter: { cutoffHz: number(filter.cutoffHz, 500, 15000, 'Cutoff'),
        resonance: number(filter.resonance, 0, 1, 'Resonance') },
    },
    arpeggiator: arp(globalArp),
    preview: { arpeggiate: boolean(preview.arpeggiate ?? false, 'Preview arp'),
      arpRateMs: number(preview.arpRateMs ?? 180, 20, 2000, 'Preview rate'),
      loop: boolean(preview.loop ?? false, 'Repeat preview') },
  } };
}

function summary(record) {
  return { id: record.id, name: record.name, author: record.author, createdAt: record.createdAt,
    mode: record.patch.global.mode, arp: record.patch.global.arpeggiator.enabled,
    tempo: record.patch.global.tempo, chordCount: record.patch.loopChordCount,
    tunings: [...new Set(record.patch.chords.slice(0, record.patch.loopChordCount).map(chord => chord.tuningId))] };
}

function createPatchStore({ directory, maxPatches = 1000, hourlyLimit = 100, now = Date.now }) {
  let writeQueue = Promise.resolve();
  async function ids() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return (await fs.readdir(directory)).filter(name => name.endsWith('.json') && PATCH_ID.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)).sort().reverse();
  }
  async function get(id) {
    if (!PATCH_ID.test(id)) throw new PatchError(404, 'Patch not found.');
    try {
      const record = JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8'));
      if (record.id !== id || !record.patch?.global) throw new Error('Invalid stored patch');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') throw new PatchError(404, 'Patch not found.');
      throw error;
    }
  }
  async function list(before) {
    if (before && !PATCH_ID.test(before)) throw new PatchError(400, 'Invalid page cursor.');
    const all = (await ids()).filter(id => !before || id < before);
    const page = all.slice(0, 20);
    const patches = [];
    for (const id of page) {
      try { patches.push(summary(await get(id))); }
      catch (error) { console.error('Could not read shared patch', id, error.code || error.message); }
    }
    return { patches, nextCursor: all.length > page.length ? page[page.length - 1] : null };
  }
  async function create(raw) {
    object(raw, 'Upload');
    const name = text(raw.name, 80, 'Patch name');
    const author = text(raw.author, 40, 'Artist name', true);
    const patch = validatePatch(raw.patch);
    const operation = writeQueue.then(async () => {
      const existing = await ids();
      if (existing.length >= maxPatches) throw new PatchError(507, 'The patch library is full. Please try again later.');
      const time = now();
      if (existing.filter(id => Number(id.slice(0, 13)) > time - 3600000).length >= hourlyLimit) {
        throw new PatchError(429, 'The library has reached its hourly upload limit. Please try again later.');
      }
      const id = `${String(time).padStart(13, '0')}-${randomBytes(12).toString('hex')}`;
      const record = { id, name, author, createdAt: new Date(time).toISOString(), patch };
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > MAX_UPLOAD_BYTES) throw new PatchError(413, 'Patch is too large (16 KiB maximum).');
      const temporary = path.join(directory, `.${id}.tmp`);
      const destination = path.join(directory, `${id}.json`);
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(serialized); await file.sync(); }
        finally { await file.close(); }
        await fs.rename(temporary, destination);
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return summary(record);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }
  return { create, get, list };
}
module.exports = { MAX_UPLOAD_BYTES, PATCH_ID, PatchError, validatePatch, createPatchStore };
