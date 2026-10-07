const config = require('../config');
const fallbackEngine = require('./engine');
const supercolliderClient = require('./supercolliderClient');

function useSuperCollider() {
  return config.superColliderEnabled;
}

async function playRealtime(job) {
  if (useSuperCollider()) {
    try {
      return await supercolliderClient.playRealtime(job);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[SuperCollider fallback] play failed, using Node DSP:', error.message);
    }
  }
  return fallbackEngine.playRealtime(job);
}

async function renderToFile(job) {
  // The legacy SuperCollider script has no per-note arp scheduling. Repeated
  // arp jobs use the Node renderer so the exported sound retains their timing.
  const hasRepeats = event => event.arpeggio?.enabled && event.arpeggio?.repeats?.some(count => count > 1);
  const repeatedArp = job.mode === 'harmony' && (hasRepeats(job) || job.events?.some(hasRepeats));
  if (useSuperCollider() && !repeatedArp) {
    try {
      return await supercolliderClient.renderToFile(job);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[SuperCollider fallback] render failed, using Node DSP:', error.message);
    }
  }
  return fallbackEngine.renderToFile(job);
}

module.exports = { playRealtime, renderToFile };
