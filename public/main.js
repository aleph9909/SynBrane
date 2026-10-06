// Base URL for the backend API.
// Default to empty string (relative) so the hosting API proxy stays on the same origin.
// Allow override from window for local development when needed.
const API_BASE =
  (typeof window !== 'undefined' && window.SYNBRANE_API_BASE) || '';

function apiUrl(path) {
  // ensure path starts with /
  if (!path.startsWith('/')) path = `/${path}`;
  return `${API_BASE}${path}`;
}

const chordSwitcher = document.getElementById('chordSwitcher');
const chordLabel = document.getElementById('activeChordLabel');
const chordTuning = document.getElementById('chordTuning');
const noteCircle = document.getElementById('noteCircle');
const clearChordBtn = document.getElementById('clearChord');
const playActiveBtn = document.getElementById('playActiveChord');
const copyChordBtn = document.getElementById('copyChord');
const chordPreset = document.getElementById('chordPreset');
const chordRoot = document.getElementById('chordRoot');
const intervalInfo = document.getElementById('intervalInfo');
const frequencyInfo = document.getElementById('frequencyInfo');
const loopChord = document.getElementById('loopChord');
const modeSelect = document.getElementById('modeSelect');
const bpmInput = document.getElementById('bpm');
const bpmLabel = document.getElementById('bpmLabel');
const rhythmInput = document.getElementById('rhythmSpeed');
const rhythmLabel = document.getElementById('rhythmLabel');
const waveformSelect = document.getElementById('waveform');
const attackInput = document.getElementById('attack');
const attackLabel = document.getElementById('attackLabel');
const decayInput = document.getElementById('decay');
const decayLabel = document.getElementById('decayLabel');
const sustainInput = document.getElementById('sustain');
const sustainLabel = document.getElementById('sustainLabel');
const releaseInput = document.getElementById('release');
const releaseLabel = document.getElementById('releaseLabel');
const volumeInput = document.getElementById('volume');
const volumeLabel = document.getElementById('volumeLabel');
const detuneInput = document.getElementById('detune');
const detuneLabel = document.getElementById('detuneLabel');
const cutoffInput = document.getElementById('cutoff');
const cutoffLabel = document.getElementById('cutoffLabel');
const resonanceInput = document.getElementById('resonance');
const resonanceLabel = document.getElementById('resonanceLabel');
const globalArpEnabled = document.getElementById('globalArpEnabled');
const globalArpPattern = document.getElementById('globalArpPattern');
const globalArpRate = document.getElementById('globalArpRate');
const playLoopBtn = document.getElementById('playLoop');
const stopLoopBtn = document.getElementById('stopLoop');
const renderLoopBtn = document.getElementById('renderLoop');
const loopChordCountInput = document.getElementById('loopChordCount');
const statusEl = document.getElementById('status');
const player = document.getElementById('player');
const savePatchBtn = document.getElementById('savePatch');
const loadPatchBtn = document.getElementById('loadPatch');
const patchFileInput = document.getElementById('patchFile');
const NOTE_NAMES_12 = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const LEGACY_PRESET_MAP = {
  major: 'major-triad',
  minor: 'minor-triad',
  diminished: 'diminished-triad',
  augmented: 'augmented-triad',
  dom7: 'dominant-7',
  maj7: 'major-7',
  min7: 'minor-7',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  add11: 'add11',
  add13: 'add13',
  sixth: 'sixth',
};

const defaultSynth = {
  waveform: 'saw',
  envelope: {
    attackMs: 40,
    decayMs: 200,
    sustainLevel: 0.7,
    releaseMs: 800,
  },
  filter: {
    cutoffHz: 12000,
    resonance: 0.2,
  },
  detuneCents: 3,
  volume: 1,
};

const VISIBLE_OCTAVES = 3;

function defaultArp() {
  return { enabled: false, pattern: 'up', rate: '1/8' };
}

function defaultChord() {
  return { tuningId: null, root: 0, notes: [], preset: 'major-triad', arp: defaultArp() };
}

function resolveArpeggio(chord) {
  const globalArp = { ...defaultArp(), ...(state.globalArp || {}) };
  if (globalArp.enabled) return globalArp;
  if (chord?.arp?.enabled) return { ...defaultArp(), ...chord.arp };
  return globalArp;
}

const MAX_CHORDS = 5;

const state = {
  tunings: [],
  chordPresets: {},
  rootOptions: {},
  baseFrequency: 440,
  activeChord: 0,
  chords: Array.from({ length: MAX_CHORDS }, () => defaultChord()),
  loopChordCount: 4,
  mode: 'harmony',
  bpm: 120,
  rhythmSpeed: 0.3,
  synth: JSON.parse(JSON.stringify(defaultSynth)),
  globalArp: defaultArp(),
  preview: { arpeggiate: false, arpRateMs: 180, loop: false },
  loopPreview: { ctx: null, timer: null, stop: false, nodes: [], noiseBuffer: null, masterGain: null },
};

function clampRhythmSpeed(value) {
  return Math.min(1, Math.max(0.1, Number(value) || 0.3));
}

function clampLoopChordCount(value) {
  return Math.max(1, Math.min(MAX_CHORDS, Math.round(Number(value) || 1)));
}

function getVisibleChordCount() {
  return Math.max(1, Math.min(clampLoopChordCount(state.loopChordCount || 1), state.chords.length));
}

function clampVolume(value) {
  return Math.max(0, Math.min(1.5, Number(value) || 0));
}

function syncGlobalArpToggle(enabled) {
  const active = Boolean(enabled);
  globalArpEnabled.checked = active;
  globalArpEnabled.setAttribute('aria-checked', String(active));
}

function coercePresetId(presetId) {
  return LEGACY_PRESET_MAP[presetId] || presetId;
}

const OSC_TYPE_MAP = {
  sine: 'sine',
  square: 'square',
  saw: 'sawtooth',
  triangle: 'triangle',
};

function waveformToOscType(waveform) {
  return OSC_TYPE_MAP[waveform] || 'sine';
}

function updateStatus(text) {
  statusEl.textContent = text || '';
}

function getTuning(id) {
  return state.tunings.find((t) => t.id === id);
}

function getDegreeSpan(tuning) {
  if (!tuning) return 12;
  if (tuning.type === 'edo') return tuning.value || 12;
  return tuning.intervals?.length || tuning.count || 12;
}

function degreeLabel(tuning, degree, root = 0) {
  const span = getDegreeSpan(tuning);
  const wrappedDegree = ((degree % span) + span) % span;
  const wrappedRoot = ((root % span) + span) % span;
  const isRoot = wrappedDegree === wrappedRoot;
  if (tuning?.type === 'edo' && tuning.value === 12) {
    const label = NOTE_NAMES_12[wrappedDegree % 12];
    return isRoot ? `${label} •` : label;
  }
  const numeric = wrappedDegree;
  return `${isRoot ? 'R ' : ''}${numeric}°`;
}

function degreeToFrequency(tuningId, degree) {
  const tuning = getTuning(tuningId);
  if (!tuning) return state.baseFrequency;
  if (tuning.type === 'edo') {
    return state.baseFrequency * 2 ** (degree / tuning.value);
  }
  const intervals = tuning.intervals || [];
  const span = intervals.length || 1;
  const wrapped = ((degree % span) + span) % span;
  const oct = Math.floor(degree / span);
  const cents = intervals[wrapped] || 0;
  return state.baseFrequency * 2 ** oct * 2 ** (cents / 1200);
}

function centsForDegree(tuning, degree) {
  if (!tuning) return 0;
  if (tuning.type === 'edo') {
    const step = 1200 / (tuning.value || 12);
    return degree * step;
  }
  const intervals = tuning.intervals || [];
  if (!intervals.length) return degree * 100;
  const span = intervals.length;
  const wrapped = ((degree % span) + span) % span;
  const oct = Math.floor(degree / span);
  return (intervals[wrapped] || 0) + oct * 1200;
}

function degreeForCentsTarget(target, tuning) {
  if (!tuning) return Math.round(target / 100);
  if (tuning.type === 'edo') {
    const step = 1200 / (tuning.value || 12);
    return Math.round(target / step);
  }
  const intervals = tuning.intervals || [];
  if (!intervals.length) return Math.round(target / 100);
  const span = intervals.length;
  const oct = Math.floor(target / 1200);
  const remainder = ((target % 1200) + 1200) % 1200;
  let bestIndex = 0;
  let bestDiff = Infinity;
  intervals.forEach((cents, idx) => {
    const diff = Math.abs(cents - remainder);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = idx;
    }
  });
  return bestIndex + oct * span;
}

function getPresetList(tuningId) {
  return state.chordPresets[tuningId] || [];
}

function findPreset(tuningId, presetId) {
  return getPresetList(tuningId).find((preset) => preset.id === presetId);
}

function isTwelveEdo(tuning) {
  return tuning?.id === 'edo:12' || (tuning?.type === 'edo' && Number(tuning?.value) === 12);
}

function formatDegreeList(degrees = [], tuning) {
  const normalized = Array.isArray(degrees)
    ? degrees
        .map((deg) => Number(deg))
        .filter((deg) => Number.isFinite(deg))
    : [];
  if (isTwelveEdo(tuning)) return '';
  const displayDegrees = normalized.map((deg) => deg);
  return displayDegrees.length ? displayDegrees.join(', ') : '';
}

function presetDegreeLabel(preset, tuning) {
  const degrees = formatDegreeList(preset?.degrees, tuning);
  return degrees ? ` (${degrees})` : '';
}

function displayPresetLabel(preset, tuning) {
  if (!preset) return '';
  const degreeText = presetDegreeLabel(preset, tuning);
  if (!degreeText) return preset.label;
  const strippedLabel = preset.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return `${strippedLabel}${degreeText}`;
}

function applyPresetToChord(chord, preset) {
  if (!chord || !preset) return;
  const root = chord.root || 0;
  const mappedDegrees = (preset.degrees || []).map((deg) => deg + root);
  chord.notes = Array.from(new Set(mappedDegrees)).sort((a, b) => a - b);
  chord.preset = preset.id;
  normalizeChordNotes(chord);
}

async function ensureChordPresets(tuningId) {
  if (!tuningId || state.chordPresets[tuningId]) return;
  try {
    const res = await fetch(apiUrl(`/api/chords?tuningId=${encodeURIComponent(tuningId)}`));
    const data = await res.json();
    state.chordPresets[tuningId] = data.chords || [];
    state.rootOptions[tuningId] = data.roots || [];
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load chord presets', error);
    state.chordPresets[tuningId] = [];
    state.rootOptions[tuningId] = [];
  }
}

function normalizeChordNotes(chord) {
  const tuning = getTuning(chord.tuningId);
  const span = getDegreeSpan(tuning);
  const minDeg = 0;
  const maxDeg = VISIBLE_OCTAVES * span - 1;
  chord.arp = {
    ...defaultArp(),
    ...(chord.arp || {}),
  };
  chord.notes = (chord.notes || [])
    .map((deg) => {
      const safe = Number.isFinite(deg) ? Math.round(deg) : 0;
      return Math.max(minDeg, Math.min(safe, maxDeg));
    })
    .filter((deg, idx, arr) => arr.indexOf(deg) === idx)
    .sort((a, b) => a - b);
  if (!chord.notes.length) chord.notes = [];
  return chord;
}

function renderChordSwitcher() {
  chordSwitcher.innerHTML = '';
  const visibleChords = getVisibleChordCount();
  if (state.activeChord >= visibleChords) {
    state.activeChord = visibleChords - 1;
  }
  state.chords.slice(0, visibleChords).forEach((_, idx) => {
    const btn = document.createElement('button');
    btn.textContent = idx + 1;
    btn.className = idx === state.activeChord ? 'active' : '';
    btn.onclick = () => {
      state.activeChord = idx;
      renderActiveChord();
    };
    chordSwitcher.appendChild(btn);
  });
}

function renderTuningOptions() {
  chordTuning.innerHTML = '';
  state.tunings.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    chordTuning.appendChild(opt);
  });
}

function renderPresetOptions() {
  chordPreset.innerHTML = '';
  const chord = state.chords[state.activeChord];
  const tuning = getTuning(chord.tuningId);
  const presets = getPresetList(chord.tuningId);
  if (!presets.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No presets';
    chordPreset.appendChild(opt);
    chordPreset.disabled = true;
    return;
  }
  chordPreset.disabled = false;
  presets.forEach((preset) => {
    const opt = document.createElement('option');
    opt.value = preset.id;
    const displayLabel = displayPresetLabel(preset, tuning);
    opt.textContent = displayLabel;
    opt.title = displayLabel;
    chordPreset.appendChild(opt);
  });
  if (!presets.find((p) => p.id === chord.preset) && presets[0]) {
    chord.preset = presets[0].id;
  }
  chordPreset.value = chord.preset || presets[0]?.id || '';
}

function renderRootOptions() {
  const chord = state.chords[state.activeChord];
  const tuning = getTuning(chord.tuningId);
  const span = getDegreeSpan(tuning);
  const presetRoots = state.rootOptions[tuning?.id];
  const rootEntries = presetRoots?.length
    ? presetRoots
    : Array.from({ length: tuning?.type === 'edo' ? Math.max(span * 2, span) : span }, (_, i) => ({
        value: i,
        label: degreeLabel(tuning, i, i),
      }));
  chordRoot.innerHTML = '';
  if (chord.root >= rootEntries.length) {
    chord.root = 0;
  }
  rootEntries.forEach((rootOption) => {
    const opt = document.createElement('option');
    opt.value = rootOption.value;
    opt.textContent = rootOption.label || degreeLabel(tuning, rootOption.value, rootOption.value);
    chordRoot.appendChild(opt);
  });
  chordRoot.value = chord.root || 0;
}

function baseHueForTuning(tuning) {
  if (!tuning) return 200;
  if (tuning.type === 'edo') {
    const hueMap = {
      10: 210,
      8: 150,
      12: 188,
      9: 262,
      19: 295,
      22: 48,
      24: 328,
      31: 32,
      13: 120,
      15: 82,
      16: 240,
      17: 18,
      20: 260,
      26: 305,
      27: 340,
    };
    return hueMap[tuning.value] ?? ((tuning.value * 11 + 60) % 360);
  }
  return 135;
}

function octaveColor(tuning, octave) {
  const baseHue = baseHueForTuning(tuning);
  const hue = (baseHue + octave * 8 + 360) % 360;
  const baseSaturation = tuning?.type === 'scala' ? 58 : 68;
  const saturation = Math.max(48, Math.min(82, baseSaturation + octave * 6));
  const baseLightness = tuning?.type === 'scala' ? 48 : 52;
  const lightness = Math.max(32, Math.min(80, baseLightness + octave * 10));
  const mutedLight = Math.max(30, Math.min(78, lightness - 8));
  const highlightLight = Math.max(50, Math.min(92, lightness + 12));
  const textColor = lightness > 62 ? '#0c1118' : '#f7fbff';
  const strongText = lightness > 58 ? '#0b0f14' : '#f9fbff';
  return {
    main: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    muted: `hsla(${hue}, ${saturation - 10}%, ${mutedLight}%, 0.7)`,
    mutedStroke: `hsla(${hue}, ${saturation - 8}%, ${mutedLight + 6}%, 0.9)`,
    highlight: `hsl(${hue}, ${Math.min(95, saturation + 8)}%, ${highlightLight}%)`,
    glow: `hsla(${hue}, ${Math.min(95, saturation + 12)}%, ${highlightLight + 6}%, 0.85)`,
    shadow: `hsla(${hue}, ${saturation}%, ${lightness}%, 0.45)`,
    outline: `hsla(${hue}, ${Math.min(96, saturation + 4)}%, ${highlightLight}%, 0.95)`,
    text: textColor,
    strongText,
  };
}

const spiralState = {
  tuningId: null,
  span: 0,
  width: 0,
  height: 0,
  pointSize: 0,
  nodes: [],
};

function spiralThemeForTuning(tuning) {
  if (!tuning?.id) return '';
  if (tuning.type === 'edo') {
    const map = {
      12: 'edo-12',
      19: 'edo-19',
      22: 'edo-22',
      24: 'edo-24',
      31: 'edo-31',
    };
    return map[tuning.value] || 'edo-generic';
  }
  return 'scala';
}

function setPointState(point, isActive) {
  if (!point) return;
  point.classList.toggle('active', isActive);
  point.classList.toggle('muted', !isActive);
}

function updateSpiralActiveStates() {
  const chord = state.chords[state.activeChord];
  const noteSet = new Set(chord.notes || []);
  spiralState.nodes.forEach((point) => {
    const degreeIndex = Number(point.dataset.degreeIndex);
    setPointState(point, noteSet.has(degreeIndex));
  });
  renderIntervalPanels();
}

function calculateSpiralSize(span) {
  const pointSize = span >= 31 ? 13 : span >= 24 ? 15 : span >= 19 ? 17 : 22;
  const densityBoost = span >= 28 ? 1.24 : span >= 22 ? 1.12 : 1.04;
  const preferredBase = span >= 28 ? 420 : span >= 22 ? 380 : 340;
  const preferredSize = preferredBase * densityBoost;
  const wrapSize = noteCircle.parentElement?.clientWidth || preferredSize;
  const circleSize = Math.max(300, Math.min(preferredSize, wrapSize - 8));
  return { pointSize, circleSize };
}

function buildSpiral(tuning) {
  const span = getDegreeSpan(tuning);
  const chord = state.chords[state.activeChord];
  const { pointSize, circleSize } = calculateSpiralSize(span);
  noteCircle.style.width = `${circleSize}px`;
  noteCircle.style.height = `${circleSize}px`;
  noteCircle.dataset.tuningId = tuning?.id || '';

  const circleWidth = noteCircle.clientWidth || circleSize;
  const circleHeight = noteCircle.clientHeight || circleSize;
  const totalPoints = span * VISIBLE_OCTAVES;
  const maxRadius = Math.min(circleWidth, circleHeight) / 2 - Math.max(pointSize * 0.6, 10);
  const centerX = circleWidth / 2;
  const centerY = circleHeight / 2;
  const innerRadius = maxRadius * 0.25;
  const outerRadius = maxRadius * 0.9;
  const turns = 2.5;

  noteCircle.innerHTML = '';
  spiralState.nodes = [];
  const fragment = document.createDocumentFragment();

  for (let j = 0; j < totalPoints; j += 1) {
    const t = totalPoints > 1 ? j / (totalPoints - 1) : 0;
    const angle = -Math.PI / 2 + turns * 2 * Math.PI * t;
    const radius = innerRadius + (outerRadius - innerRadius) * t;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    const octaveIndex = Math.floor(j / span);
    const degreeInOctave = j % span;
    const degreeIndex = octaveIndex * span + degreeInOctave;
    const palette = octaveColor(tuning, octaveIndex);
    const point = document.createElement('div');
    point.className = 'note-point muted';
    point.dataset.degreeIndex = degreeIndex;
    point.style.width = `${pointSize}px`;
    point.style.height = `${pointSize}px`;
    point.style.fontSize = `${span >= 28 ? 9 : span >= 22 ? 10 : Math.max(10, pointSize - 10)}px`;
    point.style.setProperty('--bubble-main', palette.main);
    point.style.setProperty('--bubble-muted', palette.muted);
    point.style.setProperty('--bubble-highlight', palette.highlight);
    point.style.setProperty('--bubble-glow', palette.glow);
    point.style.setProperty('--bubble-text', palette.text);
    point.style.setProperty('--bubble-text-strong', palette.strongText);
    point.style.setProperty('--bubble-shadow', palette.shadow);
    point.style.setProperty('--bubble-outline', palette.outline);
    point.style.setProperty('--note-transform', `translate(${x}px, ${y}px) translate(-50%, -50%)`);
    point.title = `Degree ${degreeInOctave} (oct +${octaveIndex})`;
    point.textContent = degreeLabel(tuning, degreeInOctave, chord.root || 0);
    point.onclick = () => {
      const activeChord = state.chords[state.activeChord];
      if (activeChord.notes.includes(degreeIndex)) {
        activeChord.notes = activeChord.notes.filter((n) => n !== degreeIndex);
      } else {
        activeChord.notes = [...activeChord.notes, degreeIndex].sort((a, b) => a - b);
      }
      normalizeChordNotes(activeChord);
      updateSpiralActiveStates();
    };
    fragment.appendChild(point);
    spiralState.nodes.push(point);
  }

  noteCircle.appendChild(fragment);
  spiralState.tuningId = tuning?.id || null;
  spiralState.span = span;
  spiralState.width = circleWidth;
  spiralState.height = circleHeight;
  spiralState.pointSize = pointSize;
}

function spiralNeedsRebuild(tuning) {
  const span = getDegreeSpan(tuning);
  const { pointSize, circleSize } = calculateSpiralSize(span);
  return (
    spiralState.tuningId !== (tuning?.id || null) ||
    spiralState.span !== span ||
    spiralState.pointSize !== pointSize ||
    Math.abs(spiralState.width - circleSize) > 2 ||
    Math.abs(spiralState.height - circleSize) > 2
  );
}

function renderCircle() {
  const chord = state.chords[state.activeChord];
  normalizeChordNotes(chord);
  const tuning = getTuning(chord.tuningId);
  const span = getDegreeSpan(tuning);
  const theme = spiralThemeForTuning(tuning);
  noteCircle.dataset.theme = theme;
  if (spiralNeedsRebuild(tuning)) {
    buildSpiral(tuning);
  }
  spiralState.nodes.forEach((point) => {
    const degreeInOctave = Number(point.dataset.degreeIndex) % span;
    point.textContent = degreeLabel(tuning, degreeInOctave, chord.root || 0);
  });
  updateSpiralActiveStates();
}

function intervalLabelByIndex(idx) {
  const labels = ['Root', '2nd', '3rd', '4th', '5th', '6th', '7th', '9th', '11th', '13th'];
  return labels[idx] || `${idx + 1}°`;
}

function renderIntervalPanels() {
  const chord = state.chords[state.activeChord];
  const tuning = getTuning(chord.tuningId);
  const sorted = [...(chord.notes || [])].sort((a, b) => a - b);
  const infoLines = [];
  const freqLines = [];
  sorted.forEach((degree, idx) => {
    const offset = degree - (chord.root || 0);
    const cents = centsForDegree(tuning, offset);
    const label = degreeLabel(tuning, degree, chord.root || 0);
    const name = intervalLabelByIndex(idx);
    infoLines.push(`${name}: ${label} (${cents.toFixed(1)}¢ from root)`);
    const freq = degreeToFrequency(chord.tuningId, degree).toFixed(2);
    const steps = tuning?.type === 'edo' ? `${offset} steps` : `${offset}°`;
    freqLines.push(`${label}: ${freq} Hz (${steps})`);
  });
  intervalInfo.textContent = infoLines.join('\n') || 'Pick notes to see intervals.';
  frequencyInfo.textContent = freqLines.join('\n') || 'Frequencies will appear here.';
}

function copyActiveChordToNext() {
  const fromIndex = state.activeChord;
  const nextIndex = fromIndex + 1;
  const visibleChords = getVisibleChordCount();
  if (nextIndex >= visibleChords) {
    updateStatus('No next chord to copy to. Increase loop length to add another chord.');
    return;
  }

  const source = normalizeChordNotes({
    ...state.chords[fromIndex],
    notes: [...(state.chords[fromIndex]?.notes || [])],
  });

  const target = state.chords[nextIndex];
  target.tuningId = source.tuningId;
  target.root = source.root || 0;
  target.notes = [...(source.notes || [])];
  target.preset = source.preset;
  target.arp = { ...defaultArp(), ...(source.arp || {}) };

  normalizeChordNotes(target);

  state.activeChord = nextIndex;
  renderActiveChord();
  updateStatus(`Copied chord ${fromIndex + 1} to chord ${nextIndex + 1}`);
}

function renderActiveChord() {
  renderChordSwitcher();
  const chord = normalizeChordNotes(state.chords[state.activeChord]);
  if (!chord.tuningId && state.tunings[0]) {
    chord.tuningId = state.tunings[0].id;
  }
  if (chord.root == null) chord.root = 0;
  chordLabel.textContent = `Chord ${state.activeChord + 1}`;
  chordTuning.value = chord.tuningId || '';
  renderPresetOptions();
  renderRootOptions();
  renderCircle();
  ensureChordPresets(chord.tuningId).then(() => {
    const presets = getPresetList(chord.tuningId);
    if (!presets.find((p) => p.id === chord.preset) && presets[0]) {
      chord.preset = presets[0].id;
      applyPresetToChord(chord, presets[0]);
    }
    renderPresetOptions();
    renderRootOptions();
    renderCircle();
  });
}

function syncSynthLabels() {
  bpmLabel.textContent = `${state.bpm} BPM`;
  rhythmLabel.textContent = `${state.rhythmSpeed.toFixed(2)}×`;
  attackLabel.textContent = `${state.synth.envelope.attackMs} ms`;
  decayLabel.textContent = `${state.synth.envelope.decayMs} ms`;
  sustainLabel.textContent = state.synth.envelope.sustainLevel.toFixed(2);
  releaseLabel.textContent = `${state.synth.envelope.releaseMs} ms`;
  volumeLabel.textContent = `${(state.synth.volume ?? 1).toFixed(2)}×`;
  detuneLabel.textContent = `${state.synth.detuneCents?.toFixed(1) || 0}¢`;
  cutoffLabel.textContent = `${state.synth.filter.cutoffHz} Hz`;
  resonanceLabel.textContent = state.synth.filter.resonance.toFixed(2);
}

function attachControlListeners() {
  chordTuning.onchange = (e) => {
    const chord = state.chords[state.activeChord];
    chord.tuningId = e.target.value;
    normalizeChordNotes(chord);
    ensureChordPresets(chord.tuningId).then(() => {
      const presets = getPresetList(chord.tuningId);
      if (!presets.find((p) => p.id === chord.preset) && presets[0]) {
        chord.preset = presets[0].id;
      }
      const preset = findPreset(chord.tuningId, chord.preset);
      if (preset) {
        applyPresetToChord(chord, preset);
      }
      renderRootOptions();
      renderPresetOptions();
      renderCircle();
    });
  };

  chordPreset.onchange = (e) => {
    const chord = state.chords[state.activeChord];
    const preset = findPreset(chord.tuningId, e.target.value);
    chord.preset = preset?.id || e.target.value;
    if (preset) {
      applyPresetToChord(chord, preset);
    }
    renderCircle();
  };

  chordRoot.onchange = (e) => {
    const chord = state.chords[state.activeChord];
    const oldRoot = chord.root || 0;
    const newRoot = Number(e.target.value);
    const delta = newRoot - oldRoot;
    chord.root = newRoot;
    chord.notes = (chord.notes || []).map((deg) => deg + delta);
    normalizeChordNotes(chord);
    renderCircle();
  };

  loopChord.onchange = (e) => {
    state.preview.loop = e.target.checked;
  };

  loopChordCountInput.onchange = (e) => {
    const value = clampLoopChordCount(e.target.value);
    state.loopChordCount = value;
    loopChordCountInput.value = state.loopChordCount;
    renderChordSwitcher();
    renderActiveChord();
  };

  clearChordBtn.onclick = () => {
    state.chords[state.activeChord].notes = [];
    renderCircle();
  };

  playActiveBtn.onclick = () => playChord(state.activeChord);

  copyChordBtn.onclick = copyActiveChordToNext;

    modeSelect.onchange = (e) => {
      state.mode = e.target.value;
    };

    bpmInput.oninput = (e) => {
      state.bpm = Number(e.target.value);
      syncSynthLabels();
    };

    rhythmInput.oninput = (e) => {
      state.rhythmSpeed = clampRhythmSpeed(e.target.value);
      rhythmInput.value = state.rhythmSpeed;
      syncSynthLabels();
    };

  waveformSelect.onchange = (e) => {
    state.synth.waveform = e.target.value;
  };

  attackInput.oninput = (e) => {
    state.synth.envelope.attackMs = Number(e.target.value);
    syncSynthLabels();
  };
  decayInput.oninput = (e) => {
    state.synth.envelope.decayMs = Number(e.target.value);
    syncSynthLabels();
  };
  sustainInput.oninput = (e) => {
    state.synth.envelope.sustainLevel = Number(e.target.value);
    syncSynthLabels();
  };
  releaseInput.oninput = (e) => {
    state.synth.envelope.releaseMs = Number(e.target.value);
    syncSynthLabels();
  };
  detuneInput.oninput = (e) => {
    state.synth.detuneCents = Number(e.target.value);
    syncSynthLabels();
  };
  cutoffInput.oninput = (e) => {
    state.synth.filter.cutoffHz = Number(e.target.value);
    syncSynthLabels();
  };
  resonanceInput.oninput = (e) => {
    state.synth.filter.resonance = Number(e.target.value);
    syncSynthLabels();
  };
  volumeInput.oninput = (e) => {
    state.synth.volume = clampVolume(e.target.value);
    volumeInput.value = state.synth.volume;
    syncSynthLabels();
    syncPreviewVolume();
  };

  globalArpEnabled.onchange = (e) => {
    state.globalArp.enabled = e.target.checked;
    syncGlobalArpToggle(state.globalArp.enabled);
  };

  globalArpPattern.onchange = (e) => {
    state.globalArp.pattern = e.target.value;
  };

  globalArpRate.onchange = (e) => {
    state.globalArp.rate = e.target.value;
  };

  playLoopBtn.onclick = () => playLoop();
  renderLoopBtn.onclick = () => renderLoop();
  stopLoopBtn.onclick = () => stopPreview('Stopped');

  savePatchBtn.onclick = () => savePatch();
  loadPatchBtn.onclick = () => patchFileInput.click();
  patchFileInput.onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) loadPatch(file);
    patchFileInput.value = '';
  };
}

function ensureChordComplete(chord, index) {
  if (!chord.tuningId) {
    throw new Error(`Chord ${index + 1} is missing a tuning.`);
  }
  if (!chord.notes?.length) {
    throw new Error(`Chord ${index + 1} has no notes.`);
  }
}

function chordToEvent(chord, index) {
  ensureChordComplete(chord, index);
  const frequencies = chord.notes.map((deg) => degreeToFrequency(chord.tuningId, deg));
  const arpeggio = resolveArpeggio(chord);
  return {
    bar: index,
    durationBars: 1,
    tuningId: chord.tuningId,
    root: chord.root || 0,
    chordType: 'custom',
    chord: { id: `circle-${index}`, degrees: [...chord.notes] },
    customChord: { degrees: [...chord.notes] },
    degrees: [...chord.notes],
    noteCount: chord.notes.length,
    frequencies,
    mode: state.mode,
    arpeggioEnabled: arpeggio.enabled,
    arpeggioPattern: arpeggio.pattern,
    arpeggioRate: arpeggio.rate,
    arpeggio,
  };
}

function expandSequence(events, loopCount = 1) {
  const iterations = Math.max(1, Number(loopCount) || 1);
  if (!events.length || iterations === 1) return events;
  const barsPerLoop =
    events.reduce((max, event) => {
      const start = event.bar || 0;
      const duration = event.durationBars || 1;
      return Math.max(max, start + duration);
    }, 0) || events.length;
  const expanded = [];
  for (let loopIndex = 0; loopIndex < iterations; loopIndex += 1) {
    events.forEach((event) => {
      expanded.push({
        ...event,
        bar: (event.bar || 0) + loopIndex * barsPerLoop,
      });
    });
  }
  return expanded;
}

function getPreviewContext() {
  if (state.loopPreview.ctx) {
    if (state.loopPreview.ctx.state === 'suspended') {
      state.loopPreview.ctx.resume();
    }
    state.loopPreview.stop = false;
    return state.loopPreview.ctx;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  state.loopPreview.ctx = new AudioCtx();
  state.loopPreview.nodes = [];
  state.loopPreview.stop = false;
  const masterGain = state.loopPreview.ctx.createGain();
  const initialVolume = clampVolume(state.synth.volume ?? 1);
  masterGain.gain.setValueAtTime(initialVolume, state.loopPreview.ctx.currentTime);
  masterGain.connect(state.loopPreview.ctx.destination);
  state.loopPreview.masterGain = masterGain;
  return state.loopPreview.ctx;
}

function getPreviewDestination() {
  const ctx = getPreviewContext();
  if (!state.loopPreview.masterGain) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(clampVolume(state.synth.volume ?? 1), ctx.currentTime);
    gain.connect(ctx.destination);
    state.loopPreview.masterGain = gain;
  }
  return state.loopPreview.masterGain;
}

function syncPreviewVolume() {
  if (!state.loopPreview.masterGain || !state.loopPreview.ctx) return;
  const clamped = clampVolume(state.synth.volume ?? 1);
  state.loopPreview.masterGain.gain.setTargetAtTime(clamped, state.loopPreview.ctx.currentTime, 0.02);
}

function trackPreviewNodes(...nodes) {
  if (!state.loopPreview.nodes) state.loopPreview.nodes = [];
  nodes.forEach((node) => {
    if (node) state.loopPreview.nodes.push(node);
  });
}

function applyEnvelope(gainNode, ctx, startTime, durationSec, envelope) {
  const attack = Math.max(0, (envelope.attackMs || 0) / 1000);
  const decay = Math.max(0, (envelope.decayMs || 0) / 1000);
  const sustain = Math.max(0, Math.min(1, envelope.sustainLevel ?? 0.7));
  const release = Math.max(0, (envelope.releaseMs || 0) / 1000);

  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(1, startTime + attack);
  gainNode.gain.linearRampToValueAtTime(sustain, startTime + attack + decay);
  gainNode.gain.setValueAtTime(sustain, startTime + durationSec);
  gainNode.gain.linearRampToValueAtTime(0, startTime + durationSec + release);

  return durationSec + release;
}

function orderFrequenciesForPattern(freqs, pattern) {
  const sorted = [...freqs].sort((a, b) => a - b);
  if (pattern === 'down') return [...sorted].reverse();
  if (pattern === 'updown') {
    const ascent = [...sorted];
    const descent = sorted.length > 1 ? sorted.slice(1, -1).reverse() : [];
    return [...ascent, ...descent];
  }
  if (pattern === 'random') {
    const shuffle = [...sorted];
    for (let i = shuffle.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffle[i], shuffle[j]] = [shuffle[j], shuffle[i]];
    }
    return shuffle;
  }
  return sorted;
}

function stepDurationFromRate(rate, bpm) {
  const secondsPerBeat = 60 / Math.max(30, bpm || 120);
  const map = {
    '1/4': 1,
    '1/8': 0.5,
    '1/8T': 1 / 3,
    '1/16': 0.25,
  };
  const beatPortion = map[rate] ?? 0.5;
  return secondsPerBeat * beatPortion;
}

function getNoiseBuffer(ctx) {
  if (state.loopPreview.noiseBuffer) return state.loopPreview.noiseBuffer;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 1.5)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  state.loopPreview.noiseBuffer = buffer;
  return buffer;
}

function rhythmStepCount(speed) {
  const value = clampRhythmSpeed(speed);
  if (value < 0.25) return 4;
  if (value < 0.5) return 8;
  if (value < 0.75) return 12;
  return 16;
}

function buildRhythmPattern({ degrees = [], durationSec, bpm, rhythmSpeed, voiceCount = 0 }) {
  const steps = rhythmStepCount(rhythmSpeed);
  const stepDuration = durationSec / steps;
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
    : Array.from({ length: Math.max(1, voiceCount || 1) }, (_, idx) => idx);
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
  const tail = 0.3;
  return { events, duration: durationSec + tail };
}

function triggerDrum(role, ctx, when, velocity = 1) {
  const safeVelocity = Math.max(0.2, Math.min(1.25, velocity));
  const nodes = [];
  const destination = getPreviewDestination();

  const connectGain = (gain) => {
    gain.connect(destination);
    nodes.push(gain);
  };

  if (role === 'kick') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, when);
    osc.frequency.exponentialRampToValueAtTime(55, when + 0.22);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(1.05 * safeVelocity, when + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.45);
    osc.connect(gain);
    connectGain(gain);
    osc.start(when);
    osc.stop(when + 0.5);
    nodes.push(osc);
  } else if (role === 'snare') {
    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuffer(ctx);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1800, when);
    noiseFilter.Q.setValueAtTime(1, when);

    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(210, when);
    tone.frequency.exponentialRampToValueAtTime(140, when + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.95 * safeVelocity, when + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);

    noise.connect(noiseFilter);
    noiseFilter.connect(gain);
    tone.connect(gain);
    connectGain(gain);

    noise.start(when);
    noise.stop(when + 0.35);
    tone.start(when);
    tone.stop(when + 0.35);
    nodes.push(noise, noiseFilter, tone);
  } else if (role === 'closedHat' || role === 'openHat') {
    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuffer(ctx);
    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(role === 'openHat' ? 6500 : 7200, when);
    highPass.Q.setValueAtTime(0.7, when);

    const gain = ctx.createGain();
    const decay = role === 'openHat' ? 0.42 : 0.16;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.65 * safeVelocity, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    noise.connect(highPass);
    highPass.connect(gain);
    connectGain(gain);

    noise.start(when);
    noise.stop(when + decay + 0.05);
    nodes.push(noise, highPass);
  } else if (role === 'lowTom' || role === 'highTom') {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const base = role === 'lowTom' ? 130 : 190;
    osc.frequency.setValueAtTime(base * 1.2, when);
    osc.frequency.exponentialRampToValueAtTime(base * 0.9, when + 0.22);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.85 * safeVelocity, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);
    osc.connect(gain);
    connectGain(gain);
    osc.start(when);
    osc.stop(when + 0.35);
    nodes.push(osc);
  } else {
    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(role === 'clap' ? 1200 : 2600, when);
    filter.Q.setValueAtTime(role === 'clap' ? 0.6 : 1.4, when);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    const decay = role === 'clap' ? 0.18 : 0.14;
    gain.gain.exponentialRampToValueAtTime(0.8 * safeVelocity, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    noise.connect(filter);
    filter.connect(gain);
    connectGain(gain);

    noise.start(when);
    noise.stop(when + decay + 0.05);
    nodes.push(noise, filter);
  }

  trackPreviewNodes(...nodes);
  return nodes.length ? 0.5 : 0;
}

function scheduleRhythmPreview(chord, startTime, durationSec, rhythmSpeed, tempo) {
  if (state.loopPreview.stop) return 0;
  const ctx = getPreviewContext();
  const pattern = buildRhythmPattern({
    degrees: chord.notes || [],
    durationSec,
    bpm: tempo || state.bpm,
    rhythmSpeed: clampRhythmSpeed(rhythmSpeed ?? state.rhythmSpeed),
    voiceCount: chord.notes?.length || 0,
  });

  pattern.events.forEach((event) => {
    triggerDrum(event.role, ctx, startTime + event.time, event.velocity);
  });

  return pattern.duration;
}

function scheduleHarmonyPreview(chord, startTime, durationSec, synthSettings, tempo) {
  if (state.loopPreview.stop) return 0;
  const tuning = getTuning(chord.tuningId);
  if (!tuning) throw new Error('Chord missing tuning');
  if (!chord.notes?.length) throw new Error('Chord has no notes');

  const ctx = getPreviewContext();
  const synth = synthSettings || state.synth;
  const envelope = synth.envelope || defaultSynth.envelope;
  const filterCfg = synth.filter || {};
  const freqs = chord.notes.map((deg) => degreeToFrequency(chord.tuningId, deg));
  const chordArp = resolveArpeggio(chord);
  const useArp = chordArp.enabled && freqs.length > 1;
  const orderedFreqs = useArp ? orderFrequenciesForPattern(freqs, chordArp.pattern) : freqs;
  const stepSec = useArp ? stepDurationFromRate(chordArp.rate, tempo || state.bpm) : durationSec;
  const noteDuration = useArp ? Math.min(durationSec, Math.max(0.08, stepSec * 0.9)) : durationSec;
  const steps = useArp
    ? Math.max(orderedFreqs.length, Math.max(1, Math.floor(durationSec / stepSec)))
    : orderedFreqs.length;

  let lastOffset = 0;
  for (let idx = 0; idx < steps; idx += 1) {
    const freq = orderedFreqs[idx % orderedFreqs.length];
    const osc = ctx.createOscillator();
    const oscType = waveformToOscType(synth.waveform || defaultSynth.waveform);
    osc.type = oscType;
    osc.frequency.setValueAtTime(freq, startTime);
    const detuneRange = getDegreeSpan(tuning) > 12 ? synth.detuneCents || 0 : 0;
    const detune = detuneRange ? (Math.random() * 2 - 1) * detuneRange : 0;
    osc.detune.setValueAtTime(detune, startTime);

    const gain = ctx.createGain();
    let lastNode = osc;

    if (filterCfg.cutoffHz) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(filterCfg.cutoffHz, startTime);
      const resonance = Math.max(0.0001, filterCfg.resonance || 0);
      filter.Q.setValueAtTime(resonance * 12 + 0.0001, startTime);
      lastNode.connect(filter);
      lastNode = filter;
      trackPreviewNodes(filter);
    }

    const noteStart = startTime + (useArp ? idx * stepSec : 0);
    const totalDuration = applyEnvelope(gain, ctx, noteStart, noteDuration, envelope);
    gain.gain.setValueAtTime(0.0001, noteStart - 0.01);
    lastNode.connect(gain);
    gain.connect(getPreviewDestination());

    osc.start(noteStart);
    osc.stop(noteStart + totalDuration + 0.05);
    trackPreviewNodes(osc, gain);
    lastOffset = useArp ? idx * stepSec + noteDuration : noteDuration;
  }

  const releaseSec = Math.max(0, (synth.envelope?.releaseMs || 0) / 1000);
  return lastOffset + releaseSec;
}

function scheduleChordPreview(chord, startTime, durationSec, { mode, synthSettings, rhythmSpeed, tempo } = {}) {
  const activeMode = mode || state.mode;
  if (activeMode === 'rhythm') {
    return scheduleRhythmPreview(chord, startTime, durationSec, rhythmSpeed, tempo);
  }
  return scheduleHarmonyPreview(chord, startTime, durationSec, synthSettings, tempo);
}

  async function playChord(index) {
    try {
      stopPreview();
      const chord = state.chords[index];
      ensureChordComplete(chord, index);

      const ctx = getPreviewContext();
      const startTime = ctx.currentTime + 0.05;
      const beatsPerBar = 4;
      const sustainDuration = state.mode === 'rhythm' ? (60 / Math.max(30, state.bpm)) * beatsPerBar : 1;
      const total = scheduleChordPreview(chord, startTime, sustainDuration, {
        mode: state.mode,
        synthSettings: state.synth,
        rhythmSpeed: state.rhythmSpeed,
        tempo: state.bpm,
      });

      updateStatus(`Previewing chord ${index + 1}`);
      state.loopPreview.timer = setTimeout(() => {
        if (state.preview.loop) {
          playChord(index);
        } else {
          stopPreview('Preview ended');
        }
      }, (total + 0.2) * 1000);

      state.rhythmSpeed = clampRhythmSpeed(state.rhythmSpeed);
    } catch (error) {
      updateStatus(error.message);
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  function buildLoopPayload() {
    state.rhythmSpeed = clampRhythmSpeed(state.rhythmSpeed);
    const visibleChords = state.chords.slice(0, Math.max(1, Math.min(clampLoopChordCount(state.loopChordCount), state.chords.length)));
    visibleChords.forEach((chord, idx) => ensureChordComplete(chord, idx));
    const sequence = visibleChords.map((chord, idx) => chordToEvent(chord, idx));
    const loopCount = 10;
    return {
      mode: state.mode,
      bpm: state.bpm,
      rhythmSpeed: state.rhythmSpeed,
      synthSettings: JSON.parse(JSON.stringify(state.synth)),
      arpeggio: { ...defaultArp(), ...(state.globalArp || {}) },
      loopCount,
      sequence,
      loopChordCount: sequence.length,
    };
  }

async function playLoop() {
  try {
    stopPreview();
    const payload = buildLoopPayload();
    const { sequence, loopCount, bpm, mode, synthSettings, rhythmSpeed } = payload;
    if (!sequence.length) throw new Error('No chords to play');

    const ctx = getPreviewContext();
    state.loopPreview.stop = false;
    const beatsPerBar = 4;
    const barDuration = (60 / Math.max(30, bpm)) * beatsPerBar;
    const expanded = expandSequence(sequence, loopCount);
    const startTime = ctx.currentTime + 0.1;

    const totalBars = expanded.reduce((max, event) => Math.max(max, (event.bar || 0) + (event.durationBars || 1)), 0);
    expanded.forEach((event) => {
      const chordDuration = barDuration * (event.durationBars || 1);
      const chordStart = startTime + (event.bar || 0) * barDuration;
      const chord = {
        tuningId: event.tuningId,
        root: event.root || 0,
        notes: event.degrees || event.customChord?.degrees || [],
        arp: event.arpeggio || {
          enabled: Boolean(event.arpeggioEnabled),
          pattern: event.arpeggioPattern || 'up',
          rate: event.arpeggioRate || '1/8',
        },
      };
      scheduleChordPreview(chord, chordStart, chordDuration, {
        mode,
        synthSettings,
        rhythmSpeed,
        tempo: bpm,
      });
    });

    const tail = mode === 'rhythm' ? 0.4 : (synthSettings.envelope?.releaseMs || 0) / 1000;
    const totalDuration = totalBars * barDuration + tail;
    state.loopPreview.timer = setTimeout(
      () => stopPreview('Loop preview finished'),
      (totalDuration + 0.3) * 1000,
    );
    updateStatus(`Loop previewing ${sequence.length} chords × ${loopCount} at ${bpm} BPM`);
  } catch (error) {
    updateStatus(error.message);
    // eslint-disable-next-line no-console
    console.error(error);
  }
}

async function renderLoop() {
  try {
    const payload = buildLoopPayload();
    const res = await fetch(apiUrl('/api/render'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.file) {
      player.classList.remove('hidden');
      player.src = data.file;
      player.play();
      updateStatus('Render ready');
    } else {
      updateStatus('Render complete');
    }
  } catch (error) {
    updateStatus(error.message);
    // eslint-disable-next-line no-console
    console.error(error);
  }
}

function stopPreview(reason) {
  if (state.loopPreview.timer) {
    clearTimeout(state.loopPreview.timer);
    state.loopPreview.timer = null;
  }
  state.loopPreview.stop = true;
  if (state.loopPreview.nodes?.length) {
    state.loopPreview.nodes.forEach((node) => {
      if (!node) return;
      try {
        if (typeof node.stop === 'function') {
          node.stop();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
      try {
        if (typeof node.disconnect === 'function') {
          node.disconnect();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
    });
    state.loopPreview.nodes = [];
  }
  if (state.loopPreview.ctx && state.loopPreview.ctx.state === 'running') {
    state.loopPreview.ctx.suspend();
  }
  if (reason) updateStatus(reason);
}

function buildPatch() {
  return {
    version: 1,
    loopChordCount: state.loopChordCount,
    global: {
      mode: state.mode,
      tempo: state.bpm,
      rhythmMultiplier: state.rhythmSpeed,
      synth: { ...state.synth },
      arpeggiator: { ...defaultArp(), ...(state.globalArp || {}) },
      preview: { ...state.preview },
    },
    chords: state.chords.map((chord) => ({
      tuningId: chord.tuningId,
      notes: [...(chord.notes || [])],
      root: chord.root || 0,
      preset: chord.preset,
      arp: { ...defaultArp(), ...(chord.arp || {}) },
    })),
  };
}

function savePatch() {
  try {
    const patch = buildPatch();
    const blob = new Blob([JSON.stringify(patch, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'synbrane_patch.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    updateStatus('Patch saved');
  } catch (error) {
    updateStatus('Failed to save patch');
    // eslint-disable-next-line no-console
    console.error(error);
  }
}

function applyPatch(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid patch');
  const chords = Array.isArray(data.chords) ? data.chords.slice(0, state.chords.length) : [];
  const loopChordCount = clampLoopChordCount(data.loopChordCount || data.chords?.length || state.loopChordCount);
  state.loopChordCount = loopChordCount;
  chords.forEach((entry, idx) => {
    if (!state.chords[idx]) return;
    state.chords[idx].tuningId = entry.tuningId || state.tunings[0]?.id || null;
    state.chords[idx].notes = Array.isArray(entry.notes) ? entry.notes.map((n) => Number(n)) : [];
    state.chords[idx].root = Number(entry.root ?? state.chords[idx].root ?? 0);
    state.chords[idx].preset = coercePresetId(entry.preset || state.chords[idx].preset || 'major-triad');
    state.chords[idx].arp = { ...defaultArp(), ...(entry.arp || {}) };
    normalizeChordNotes(state.chords[idx]);
  });
  for (let idx = chords.length; idx < state.chords.length; idx += 1) {
    state.chords[idx] = defaultChord();
    state.chords[idx].tuningId = state.tunings[0]?.id || null;
    normalizeChordNotes(state.chords[idx]);
  }
    if (data.global) {
      state.mode = data.global.mode || state.mode;
      state.bpm = Number(data.global.tempo || state.bpm);
      const nextRhythm = Number(data.global.rhythmMultiplier ?? state.rhythmSpeed);
      state.rhythmSpeed = clampRhythmSpeed(nextRhythm);
    if (data.global.synth) {
      state.synth = {
        waveform: data.global.synth.waveform || state.synth.waveform,
        envelope: {
          attackMs: Number(data.global.synth.envelope?.attackMs ?? state.synth.envelope.attackMs),
          decayMs: Number(data.global.synth.envelope?.decayMs ?? state.synth.envelope.decayMs),
          sustainLevel: Number(data.global.synth.envelope?.sustainLevel ?? state.synth.envelope.sustainLevel),
          releaseMs: Number(data.global.synth.envelope?.releaseMs ?? state.synth.envelope.releaseMs),
        },
        filter: {
          cutoffHz: Number(data.global.synth.filter?.cutoffHz ?? state.synth.filter.cutoffHz),
          resonance: Number(data.global.synth.filter?.resonance ?? state.synth.filter.resonance),
        },
        detuneCents: Number(data.global.synth.detuneCents ?? state.synth.detuneCents),
        volume: clampVolume(data.global.synth.volume ?? state.synth.volume),
      };
    }
    if (data.global.preview) {
      state.preview = {
        arpeggiate: Boolean(data.global.preview.arpeggiate ?? state.preview.arpeggiate),
        arpRateMs: Number(data.global.preview.arpRateMs ?? state.preview.arpRateMs),
        loop: Boolean(data.global.preview.loop ?? state.preview.loop),
      };
    }
    if (data.global.arpeggiator) {
      state.globalArp = { ...defaultArp(), ...data.global.arpeggiator };
    }
  }
  if (!data.global?.arpeggiator) {
    const firstChordArp = chords.find((entry) => entry?.arp?.enabled)?.arp;
    if (firstChordArp) {
      state.globalArp = { ...defaultArp(), ...firstChordArp };
    }
  }
  modeSelect.value = state.mode;
  bpmInput.value = state.bpm;
  rhythmInput.value = state.rhythmSpeed;
  waveformSelect.value = state.synth.waveform;
  volumeInput.value = state.synth.volume;
  attackInput.value = state.synth.envelope.attackMs;
  decayInput.value = state.synth.envelope.decayMs;
  sustainInput.value = state.synth.envelope.sustainLevel;
  releaseInput.value = state.synth.envelope.releaseMs;
  detuneInput.value = state.synth.detuneCents;
  cutoffInput.value = state.synth.filter.cutoffHz;
  resonanceInput.value = state.synth.filter.resonance;
  syncGlobalArpToggle(state.globalArp?.enabled);
  globalArpPattern.value = state.globalArp?.pattern || 'up';
  globalArpRate.value = state.globalArp?.rate || '1/8';
  loopChordCountInput.value = state.loopChordCount;
  loopChord.checked = state.preview.loop;
  syncSynthLabels();
  syncPreviewVolume();
  renderChordSwitcher();
  renderActiveChord();
}

function loadPatch(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      applyPatch(parsed);
      updateStatus('Patch loaded');
    } catch (error) {
      updateStatus('Invalid patch file');
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };
  reader.readAsText(file);
}

async function init() {
  attachControlListeners();
  syncSynthLabels();
  volumeInput.value = state.synth.volume;
  syncGlobalArpToggle(state.globalArp.enabled);
  globalArpPattern.value = state.globalArp.pattern;
  globalArpRate.value = state.globalArp.rate;
  state.loopChordCount = clampLoopChordCount(state.loopChordCount);
  loopChordCountInput.value = state.loopChordCount;
  loopChord.checked = state.preview.loop;
  const res = await fetch(apiUrl('/api/tunings'));
  const data = await res.json();
  state.tunings = data.tunings || [];
  state.baseFrequency = data.baseFrequency || 440;
  state.chords.forEach((chord) => {
    chord.tuningId = chord.tuningId || state.tunings[0]?.id || null;
    chord.root = chord.root || 0;
    chord.preset = coercePresetId(chord.preset || 'major-triad');
    normalizeChordNotes(chord);
  });
  const tuningIds = Array.from(new Set(state.chords.map((c) => c.tuningId).filter(Boolean)));
  // preload presets for any tunings already assigned to chords
  // eslint-disable-next-line no-restricted-syntax
  for (const tuningId of tuningIds) {
    // eslint-disable-next-line no-await-in-loop
    await ensureChordPresets(tuningId);
  }
  state.chords.forEach((chord) => {
    const presets = getPresetList(chord.tuningId);
    if (!presets.find((p) => p.id === chord.preset) && presets[0]) {
      chord.preset = presets[0].id;
    }
    const preset = findPreset(chord.tuningId, chord.preset);
    if (preset && !chord.notes.length) {
      applyPresetToChord(chord, preset);
    }
  });
  renderTuningOptions();
  renderRootOptions();
  renderPresetOptions();
  renderActiveChord();
  updateStatus('Ready');
}

init();
