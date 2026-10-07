const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

let browser, server, renderDir;
const port = Number(process.env.TEST_UI_PORT || 13002);
const origin = `http://127.0.0.1:${port}`;

before(async () => {
  renderDir = await mkdtemp(path.join(os.tmpdir(), "synbrane-ui-"));
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SUPER_COLLIDER_ENABLED: "false",
      RENDER_OUTPUT_DIR: renderDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
  });
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }
  if (renderDir) await rm(renderDir, { recursive: true, force: true });
});

async function openPage(t, width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "Ready",
  );
  return page;
}

test("fresh defaults use 12-EDO and ARP; main switch overrides legacy arp flags", async (t) => {
  const page = await openPage(t);
  assert.deepEqual(
    await page.evaluate(() => ({
      tuningIds: [...new Set(state.chords.map((chord) => chord.tuningId))],
      enabled: buildLoopPayload().arpeggio.enabled,
      count: buildLoopPayload().sequence.length,
    })),
    { tuningIds: ["edo:12"], enabled: true, count: 4 },
  );
  await page.evaluate(() => {
    state.chords.forEach((chord) => {
      chord.arp.enabled = true;
    });
  });
  await page.locator("label:has(#chordMode)").click();
  assert.equal(await page.locator("#arpSettings").isVisible(), false);
  assert.equal(
    await page.evaluate(() =>
      buildLoopPayload().sequence.every((event) => !event.arpeggioEnabled),
    ),
    true,
  );
  await page.locator("#showSynthSettings").click();
  await page.locator(".synth-details summary").click();
  await page.selectOption("#modeSelect", "rhythm");
  assert.equal(await page.locator("#arpMode").isChecked(), false);
  await page.locator("label:has(#arpMode)").click();
  assert.equal(await page.evaluate(() => state.mode), "harmony");
  assert.equal(
    await page.evaluate(() =>
      buildLoopPayload().sequence.every((event) => event.arpeggioEnabled),
    ),
    true,
  );
});

test("loop lengths 1–4 change scheduled audio and visible slots without losing hidden edits", async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => {
    state.chords[3].notes = [2, 5, 9];
  });
  for (const count of [1, 2, 3, 4]) {
    await page.selectOption("#loopChordCount", String(count));
    assert.equal(await page.locator("#chordSwitcher button").count(), count);
    assert.equal(
      await page.evaluate(() => buildLoopPayload().sequence.length),
      count,
    );
    await page.click("#playLoop");
    assert.equal(await page.evaluate(() => state.playback.chordCount), count);
    assert.equal(
      await page.evaluate(() => state.loopPreview.nodes.length > 0),
      true,
    );
  }
  assert.deepEqual(await page.evaluate(() => state.chords[3].notes), [2, 5, 9]);
  await page.locator("#chordSwitcher button").nth(3).click();
  await page.selectOption("#loopChordCount", "1");
  assert.equal(await page.evaluate(() => state.activeChord), 0);
  assert.equal(await page.evaluate(() => state.playback.chordCount), 1);
  await page.click("#stopLoop");
  assert.deepEqual(
    await page.evaluate(() => [
      state.playback,
      state.playingChord,
      state.playbackFrame,
      state.loopPreview.timer,
      state.loopPreview.nodes.length,
    ]),
    [null, null, null, null, 0],
  );
});

test("playing chord follows audio-clock bars and wraparound independently of the editor and tempo edits", async (t) => {
  const page = await openPage(t);
  await page.click("#playLoop");
  await page.locator("#chordSwitcher button").nth(3).click();
  for (const [bar, expected] of [
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 0],
    [9, 1],
  ]) {
    const result = await page.evaluate(
      ({ bar }) => {
        cancelAnimationFrame(state.playbackFrame);
        state.playbackFrame = null;
        state.playback.startTime =
          state.loopPreview.ctx.currentTime -
          (bar + 0.1) * state.playback.barDuration;
        state.bpm = 300;
        updatePlaybackIndicator();
        return {
          playing: state.playingChord,
          editing: state.activeChord,
          label: nowPlaying.textContent,
          highlighted: chordSwitcher.querySelectorAll(".playing").length,
        };
      },
      { bar },
    );
    assert.deepEqual(result, {
      playing: expected,
      editing: 3,
      label: `Playing · Chord ${expected + 1} of 4`,
      highlighted: 1,
    });
  }
  await page.evaluate(() => {
    state.playback.startTime =
      state.loopPreview.ctx.currentTime - state.playback.endTime - 1;
    updatePlaybackIndicator();
  });
  assert.equal(await page.locator("#chordSwitcher .playing").count(), 0);
  assert.equal(
    await page.locator("#nowPlaying").textContent(),
    "Ready to play",
  );
});

test("patch loading preserves explicit defaults, legacy fifth chords and non-12 temperaments", async (t) => {
  const page = await openPage(t);
  const result = await page.evaluate(() => {
    const patch = buildPatch();
    patch.loopChordCount = 5;
    patch.chords[4].tuningId = "edo:19";
    patch.chords[4].notes = [0, 6, 11];
    patch.chords[0].arp.enabled = true;
    patch.global.arpeggiator.enabled = false;
    applyPatch(patch);
    return {
      saved: buildPatch(),
      eventArps: buildLoopPayload().sequence.map(
        (event) => event.arpeggioEnabled,
      ),
      checked: chordMode.checked,
      legacyHidden: legacyChordCount.hidden,
    };
  });
  assert.equal(result.saved.loopChordCount, 5);
  assert.equal(result.saved.chords[4].tuningId, "edo:19");
  assert.deepEqual(result.eventArps, [false, false, false, false, false]);
  assert.equal(result.checked, true);
  assert.equal(result.legacyHidden, false);
  await page.evaluate(() => {
    const patch = buildPatch();
    delete patch.global.arpeggiator;
    patch.chords.forEach((chord) => {
      chord.arp.enabled = false;
    });
    state.globalArp.enabled = true;
    applyPatch(patch);
  });
  assert.equal(await page.evaluate(() => state.globalArp.enabled), false);
});

test("mobile controls fit 320–430px, synth is one tap away, and spiral retains its size and notes", async (t) => {
  const page = await openPage(t);
  for (const width of [320, 375, 390, 430, 900, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => renderCircle());
    let metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      width: innerWidth,
      spiral: noteCircle.getBoundingClientRect().toJSON(),
      notes: noteCircle.querySelectorAll(".note-point").length,
    }));
    assert.equal(metrics.scrollWidth, metrics.width, `overflow at ${width}`);
    assert.equal(metrics.notes, 36);
    assert.equal(metrics.spiral.width, metrics.spiral.height);
    assert.ok(
      metrics.spiral.top < 710,
      `spiral too low at ${width}: ${metrics.spiral.top}`,
    );
    await page.click("#playLoop");
    await page.waitForFunction(() => state.playingChord === 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth === innerWidth,
      ),
      true,
      `playing overflow at ${width}`,
    );
    await page.click("#stopLoop");
    if (width <= 430) {
      await page.click("#showSynthSettings");
      assert.equal(await page.locator("#volume").isVisible(), true);
      assert.equal(await page.locator("#cutoff").isVisible(), true);
      const top = await page
        .locator("#noteCircle")
        .evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(
        Math.abs(top - metrics.spiral.top) < 12,
        `synth moved spiral at ${width}`,
      );
      await page.locator(".synth-details summary").click();
      assert.equal(await page.locator("#attack").isVisible(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth === innerWidth,
        ),
        true,
      );
      await page.locator(".synth-details summary").click();
      await page.click("#showChordSettings");
    }
  }
  await page.locator("#noteCircle button").nth(1).click();
  assert.equal(
    await page
      .locator("#noteCircle button")
      .nth(1)
      .getAttribute("aria-pressed"),
    "true",
  );
});

test("real rendered WAV uses its own timeline on seek, pause and replay; Stop silences it", async (t) => {
  const page = await openPage(t);
  await page.selectOption("#loopChordCount", "2");
  await page.evaluate(() => {
    state.bpm = 300;
  });
  await page.click("#renderLoop");
  await page.waitForFunction(() => state.playback?.kind === "render");
  await page.waitForFunction(() => Number.isFinite(player.duration));
  assert.ok(await page.evaluate(() => player.duration >= 16));
  await page.evaluate(() => {
    player.currentTime = 0.9;
  });
  await page.waitForFunction(() => state.playingChord === 1);
  assert.match(await page.locator("#nowPlaying").textContent(), /Chord 2 of 2/);
  await page.evaluate(() => player.pause());
  await page.waitForFunction(() => state.playback === null);
  await page.evaluate(() => player.play());
  await page.waitForFunction(() => state.playback?.kind === "render");
  await page.click("#stopLoop");
  assert.equal(await page.evaluate(() => player.paused), true);
  assert.equal(await page.locator("#chordSwitcher .playing").count(), 0);
});

test('Stop cancels a pending render so a late response cannot restart audio', async t => {
  const page = await openPage(t);
  let pendingRoute;
  const requested = new Promise(resolve => {
    page.route('**/api/render', route => {
      pendingRoute = route;
      resolve();
    });
  });
  await page.click('#renderLoop');
  await requested;
  await page.click('#stopLoop');
  const response = page.waitForResponse('**/api/render');
  await pendingRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file: '/renders/stale.wav' }) });
  await response;
  assert.equal(await page.evaluate(() => state.renderedLoop), null);
  assert.equal(await page.locator('#player').isVisible(), false);
  assert.equal(await page.locator('#status').textContent(), 'Stopped');
});

test('preview schedules a small window, retains the sound snapshot, and cancels future work on Stop', async t => {
  const page = await openPage(t);
  const initial = await page.evaluate(async () => {
    const schedule = scheduleChordPreview;
    window.scheduledBars = [];
    scheduleChordPreview = (chord, time, duration, options) => {
      window.scheduledBars.push({ time, duration, arp: { ...chord.arpeggio } });
      return schedule(chord, time, duration, options);
    };
    await playLoop();
    const result = { nodes: state.loopPreview.nodes.length, queued: state.loopPreview.scheduler.nextIndex, total: state.playback.totalBars };
    state.globalArp.enabled = false;
    state.globalArp.pattern = 'down';
    return result;
  });
  assert.deepEqual(initial, { nodes: 48, queued: 2, total: 40 });
  await page.waitForFunction(() => state.loopPreview.scheduler.nextIndex >= 3);
  const later = await page.evaluate(() => ({
    nodes: state.loopPreview.nodes.length,
    events: window.scheduledBars,
  }));
  assert.ok(later.nodes <= 96);
  assert.equal(later.events.every(event => event.arp.enabled && event.arp.pattern === 'up'), true);
  assert.ok(Math.abs(later.events[1].time - later.events[0].time - 2) < 1e-9);
  assert.ok(Math.abs(later.events[2].time - later.events[1].time - 2) < 1e-9);
  const stopped = await page.evaluate(() => {
    const pump = state.loopPreview.scheduler.pump;
    stopPreview();
    pump();
    return { scheduler: state.loopPreview.scheduler, nodes: state.loopPreview.nodes.length };
  });
  assert.deepEqual(stopped, { scheduler: null, nodes: 0 });
});

test('background transition queues native audio before browser timers can be throttled', async t => {
  const page = await openPage(t);
  const result = await page.evaluate(async () => {
    await playLoop();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const result = { queued: state.loopPreview.scheduler.nextIndex, timer: state.loopPreview.scheduler.timer };
    delete document.hidden;
    stopPreview();
    return result;
  });
  assert.deepEqual(result, { queued: 40, timer: null });
});

test('offline preview stays below full scale and cleans up harmony and shared drum chains', async t => {
  const page = await openPage(t);
  const results = await page.evaluate(async () => {
    const results = [];
    for (const variant of [
      { name: 'default arp', volume: 1, arp: true, count: 3, resonance: 0.2 },
      { name: 'boosted arp', volume: 1.5, arp: true, count: 3, resonance: 0.2 },
      { name: 'dense chord', volume: 1.5, arp: false, count: 12, resonance: 1 },
      { name: 'drums', volume: 1.5, arp: false, count: 3, resonance: 0.2, mode: 'rhythm' },
    ]) {
      const ctx = new OfflineAudioContext(1, 44100 * 5, 44100);
      getPreviewContext = () => ctx;
      Object.assign(state.loopPreview, { ctx, masterGain: null, mixGain: null, limiter: null, outputGain: null, noiseBuffer: null, stop: false, nodes: [] });
      state.synth.volume = variant.volume;
      state.synth.filter.resonance = variant.resonance;
      state.globalArp.enabled = variant.arp;
      const chord = { ...state.chords[0], notes: variant.count === 3 ? [0, 4, 7] : Array.from({ length: variant.count }, (_, i) => i) };
      for (let i = 0; i < 2; i++) scheduleChordPreview(chord, 0.1 + i * 2, 2, {
        mode: variant.mode || 'harmony', synthSettings: state.synth, rhythmSpeed: 0.3, tempo: 120,
      });
      const buffer = await ctx.startRendering();
      let peak = 0, clipped = 0;
      for (const sample of buffer.getChannelData(0)) {
        if (!Number.isFinite(sample)) throw new Error('Non-finite audio sample');
        peak = Math.max(peak, Math.abs(sample));
        if (Math.abs(sample) > 1) clipped++;
      }
      // Source ended events are dispatched separately from rendering completion.
      await new Promise(resolve => setTimeout(resolve, 0));
      results.push({ name: variant.name, peak, clipped, retainedNodes: state.loopPreview.nodes.length });
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.clipped, 0, `${result.name}: peak ${result.peak}`);
    assert.ok(result.peak > 0.01, `${result.name} must not be silent`);
    assert.equal(result.retainedNodes, 0, result.name);
  }
});
