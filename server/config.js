const fs = require('fs');
const path = require('path');
const os = require('os');

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const parsed = {};
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...rest] = trimmed.split('=');
    parsed[key.trim()] = rest.join('=').trim();
  });
  return parsed;
}

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  const parsed = parseEnvFile(envPath);
  Object.entries(parsed).forEach(([key, value]) => {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnv();

const config = {
  port: parseInt(process.env.PORT, 10) || 3001,
  host: process.env.HOST || '0.0.0.0',
  baseFrequency: parseFloat(process.env.BASE_FREQUENCY) || 440,
  renderOutputDir: process.env.RENDER_OUTPUT_DIR || path.join(process.cwd(), 'renders'),
  patchesDir: process.env.PATCHES_DIR || path.join(os.homedir(), '.synbrane', 'patches'),
  scalesDir: process.env.SCALES_DIR || path.join(process.cwd(), 'scales'),
  superColliderEnabled: (process.env.SUPER_COLLIDER_ENABLED || '').toLowerCase() === 'true',
  superColliderSclangPath: process.env.SUPER_COLLIDER_SCLANG_PATH || 'sclang',
  renderSampleRate: Math.max(44100, parseInt(process.env.RENDER_SAMPLE_RATE, 10) || 44100),
};

module.exports = config;
