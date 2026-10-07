const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
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
      PATCHES_DIR: path.join(renderDir, "patches"),
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

async function openPage(t, width = 390, options = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, ...options });
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
  const downloadPromise = page.waitForEvent('download');
  await page.click('#downloadRender');
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'synbrane-loop.wav');
  const wav = await readFile(await download.path());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
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

test('public library shares current sound across sessions and downloads a reusable patch', async t => {
  const publisher = await openPage(t);
  await publisher.evaluate(() => {
    state.bpm = 137;
    state.loopChordCount = 2;
    state.chords[0].notes = [1, 8, 14, 25];
    state.synth.volume = 0.65;
    state.globalArp.pattern = 'down';
  });
  const original = await publisher.evaluate(() => buildPatch());
  await publisher.click('#sharePatch');
  await publisher.fill('#sharedPatchName', '<img src=x onerror=alert(1)> Glass');
  await publisher.fill('#sharedPatchAuthor', 'Spiral artist');
  await publisher.click('#publishPatch');
  await publisher.waitForFunction(() => document.getElementById('sharePatchStatus').textContent.startsWith('Published'));
  const listener = await openPage(t);
  await listener.click('#openPatchLibrary');
  await listener.locator('#patchLibraryList li').first().waitFor();
  assert.equal(await listener.locator('#patchLibraryList h4').first().textContent(), '<img src=x onerror=alert(1)> Glass');
  assert.equal(await listener.locator('#patchLibraryList img').count(), 0);
  const downloadPromise = listener.waitForEvent('download');
  await listener.locator('#patchLibraryList button').filter({ hasText: 'Download' }).first().click();
  const downloaded = await downloadPromise;
  assert.deepEqual(JSON.parse(await readFile(await downloaded.path(), 'utf8')), original);
  await listener.locator('#patchLibraryList button').filter({ hasText: /^Load$/ }).first().click();
  await listener.waitForFunction(() => !document.getElementById('patchLibrary').open);
  assert.deepEqual(await listener.evaluate(() => buildPatch()), original);
  assert.equal(await listener.evaluate(() => state.playback), null);
});

test('file upload preserves custom mixed-tuning notes; library fits narrow phones and keyboard close', async t => {
  const page = await openPage(t);
  const filePatch = await page.evaluate(async () => {
    await ensureChordPresets('edo:19');
    const p = buildPatch();
    p.chords[0] = { ...p.chords[0], tuningId: 'edo:19', notes: [1, 7, 15, 24], preset: state.chordPresets['edo:19'][0].id };
    p.global.arpeggiator.enabled = false;
    return p;
  });
  await page.click('#sharePatch');
  await page.fill('#sharedPatchName', 'Nineteen glass');
  await page.selectOption('#sharedPatchSource', 'file');
  await page.setInputFiles('#sharedPatchFile', { name: 'nineteen.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(filePatch)) });
  await page.click('#publishPatch');
  await page.waitForFunction(() => document.getElementById('sharePatchStatus').textContent.startsWith('Published'));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
  await page.click('#openPatchLibrary');
  await page.locator('#patchLibraryList li').first().waitFor();
  assert.equal(await page.evaluate(() => !!state.chordPresets['edo:19']), false);
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => {
      const dialog = document.getElementById('patchLibrary');
      return dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().width <= innerWidth;
    }), true, `library overflows at ${width}`);
  }
  await page.getByRole('button', { name: 'Load Nineteen glass', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('patchLibrary').open);
  assert.deepEqual(await page.evaluate(() => buildPatch()), filePatch);
  await page.click('#openPatchLibrary');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#patchLibrary').isVisible(), false);
});

test('library reports upload errors and failed requests without changing the sound', async t => {
  const page = await openPage(t);
  const original = await page.evaluate(() => buildPatch());
  await page.click('#sharePatch');
  await page.fill('#sharedPatchName', 'Broken file');
  await page.selectOption('#sharedPatchSource', 'file');
  await page.setInputFiles('#sharedPatchFile', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.click('#publishPatch');
  await page.waitForFunction(() => document.getElementById('sharePatchStatus').textContent.includes('valid JSON'));
  assert.equal(await page.locator('#publishPatch').isEnabled(), true);
  await page.route('**/api/patches', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Library offline"}' }));
  await page.click('#refreshPatchLibrary');
  await page.waitForFunction(() => document.getElementById('libraryStatus').textContent === 'Library offline');
  assert.deepEqual(await page.evaluate(() => buildPatch()), original);
});

test('closing the library cancels a pending load; tuning failures never change the instrument', async t => {
  const page = await openPage(t);
  const original = await page.evaluate(() => buildPatch());
  const input = structuredClone(original);
  const presets = await (await fetch(`${origin}/api/chords?tuningId=edo:19`)).json();
  input.chords[0] = { ...input.chords[0], tuningId: 'edo:19', preset: presets.chords[0].id, notes: [0, 6, 11] };
  const upload = await fetch(`${origin}/api/patches`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Pending nineteen', patch: input }) });
  assert.equal(upload.status, 201);
  const entry = (await upload.json()).patch;
  const record = await (await fetch(`${origin}/api/patches/${entry.id}`)).json();
  let pending;
  const requested = new Promise(resolve => page.route(`**/api/patches/${entry.id}`, route => { pending = route; resolve(); }));
  await page.click('#openPatchLibrary');
  await page.getByRole('button', { name: 'Load Pending nineteen', exact: true }).click();
  await requested;
  await page.keyboard.press('Escape');
  await pending.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(record) });
  await page.waitForFunction(() => [...document.querySelectorAll('#patchLibraryList button')].every(b => !b.disabled));
  assert.deepEqual(await page.evaluate(() => buildPatch()), original);
  await page.unroute(`**/api/patches/${entry.id}`);
  await page.evaluate(() => { delete state.chordPresets['edo:19']; });
  await page.route('**/api/chords?tuningId=edo%3A19', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }));
  await page.click('#openPatchLibrary');
  await page.getByRole('button', { name: 'Load Pending nineteen', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('libraryStatus').textContent.includes('Could not load the patch tuning'));
  assert.deepEqual(await page.evaluate(() => buildPatch()), original);
});

async function holdNote(page, degree = 0) {
  const note = page.locator(`#noteCircle [data-degree-index="${degree}"]`);
  await note.scrollIntoViewIfNeeded();
  const rect = await note.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => document.getElementById('noteRepeatPicker').matches(':popover-open'));
  await page.mouse.up();
  return note;
}

test('hold chooser keeps taps as toggles, shows counts, and supports keyboard and narrow screens', async t => {
  const page = await openPage(t);
  const note = await holdNote(page);
  assert.equal(await page.locator('#noteRepeatPicker').isVisible(), true);
  assert.equal(await note.getAttribute('aria-pressed'), 'true', 'hold release must not toggle the note');
  await page.locator('#noteRepeatPicker [data-count="3"]').click();
  assert.equal(await note.getAttribute('data-repeat'), '3');
  assert.match(await note.getAttribute('aria-label'), /3 repeats/);
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), { 0: 3 });
  await note.click();
  assert.equal(await note.getAttribute('aria-pressed'), 'false');
  assert.equal(await note.getAttribute('data-repeat'), null);
  await note.click();
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), {});
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await note.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await note.focus();
    await page.keyboard.press('r');
    assert.equal(await page.locator('#noteRepeatPicker').isVisible(), true);
    assert.equal(await page.evaluate(() => {
      const rect = document.getElementById('noteRepeatPicker').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, `chooser bounds at ${width}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#noteRepeatPicker').isVisible(), false);
    assert.equal(await note.evaluate(el => el === document.activeElement), true, `focus lost at ${width}`);
  }
  // A moved gesture must neither open the chooser nor toggle a note.
  await note.scrollIntoViewIfNeeded();
  const box = await note.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 25, box.y + 30);
  await page.waitForTimeout(500);
  await page.mouse.up();
  assert.equal(await page.locator('#noteRepeatPicker').isVisible(), false);
  assert.equal(await note.getAttribute('aria-pressed'), 'true');
});

test('real touch hold opens repeat choices; touch scrolling cancels the hold', async t => {
  const page = await openPage(t, 390, { hasTouch: true, isMobile: true });
  const note = page.locator('#noteCircle [data-degree-index="0"]');
  await note.scrollIntoViewIfNeeded();
  const rect = await note.boundingBox();
  const touch = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await page.waitForFunction(() => document.getElementById('noteRepeatPicker').matches(':popover-open'));
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.locator('#noteRepeatPicker').isVisible(), true);
  await page.locator('#noteRepeatPicker [data-count="4"]').tap();
  assert.equal(await note.getAttribute('data-repeat'), '4');
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y - 60 }] });
  await page.waitForTimeout(500);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.locator('#noteRepeatPicker').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), { 0: 4 });
  await session.detach();
});

test('repeat edits follow copies and root changes; presets, clear, and old patches reset them', async t => {
  const page = await openPage(t);
  await holdNote(page);
  await page.locator('#noteRepeatPicker [data-count="2"]').click();
  await page.click('#copyChord');
  assert.deepEqual(await page.evaluate(() => state.chords[1].repeats), { 0: 2 });
  await page.selectOption('#chordRoot', '2');
  assert.deepEqual(await page.evaluate(() => state.chords[1].repeats), { 2: 2 });
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), { 0: 2 });
  await page.click('#clearChord');
  assert.deepEqual(await page.evaluate(() => state.chords[1].repeats), {});
  await page.locator('#chordSwitcher button').first().click();
  await page.selectOption('#chordPreset', { index: 1 });
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), {});
  await page.evaluate(() => {
    const old = buildPatch();
    old.chords.forEach(chord => delete chord.repeats);
    state.chords[0].repeats = { [state.chords[0].notes[0]]: 4 };
    applyPatch(old);
  });
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), {});
});

test('shared patches retain repeats with synth settings, and loop events carry aligned repeat counts', async t => {
  const page = await openPage(t);
  await holdNote(page);
  await page.locator('#noteRepeatPicker [data-count="4"]').click();
  const saved = await page.evaluate(() => {
    state.synth.volume = 0.63;
    state.synth.envelope.attackMs = 170;
    state.synth.envelope.decayMs = 330;
    state.synth.envelope.sustainLevel = 0.42;
    state.synth.envelope.releaseMs = 780;
    state.synth.filter = { cutoffHz: 4200, resonance: 0.67 };
    state.synth.detuneCents = 7.5;
    state.synth.waveform = 'square';
    return buildPatch();
  });
  await page.click('#sharePatch');
  await page.fill('#sharedPatchName', 'Four repeats with synth');
  await page.click('#publishPatch');
  await page.waitForFunction(() => document.getElementById('sharePatchStatus').textContent.startsWith('Published'));
  const reader = await openPage(t);
  await reader.click('#openPatchLibrary');
  await reader.getByRole('button', { name: 'Load Four repeats with synth', exact: true }).click();
  await reader.waitForFunction(() => !document.getElementById('patchLibrary').open);
  assert.deepEqual(await reader.evaluate(() => buildPatch()), saved);
  assert.equal(await reader.locator('#noteCircle [data-degree-index="0"]').getAttribute('data-repeat'), '4');
  const event = await reader.evaluate(() => buildLoopPayload().sequence[0]);
  assert.deepEqual(event.arpeggio.repeats, event.degrees.map(degree => saved.chords[0].repeats[degree] || 1));
});

test('browser scheduling and real WAV keep repeated notes in order without crossing the next bar', async t => {
  const page = await openPage(t);
  const result = await page.evaluate(() => {
    const chord = state.chords[0];
    chord.notes = [0, 4, 7];
    chord.repeats = { 0: 2, 7: 3 };
    state.loopChordCount = 1;
    state.bpm = 120;
    state.synth = { waveform: 'sine', volume: 0.6, detuneCents: 0,
      envelope: { attackMs: 0, decayMs: 0, sustainLevel: 1, releaseMs: 0 },
      filter: { cutoffHz: 15000, resonance: 0 } };
    const ctx = getPreviewContext();
    const original = ctx.createOscillator.bind(ctx);
    const scheduled = [];
    ctx.createOscillator = () => {
      const osc = original();
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, time) => { scheduled.push(value); return set(value, time); };
      return osc;
    };
    state.loopPreview.stop = false;
    scheduleHarmonyPreview(chord, ctx.currentTime + 0.1, 2, state.synth, 120);
    const frequencies = chordToEvent(chord, 0).frequencies;
    const repeated = [...scheduled];
    stopPreview();
    state.loopPreview.stop = false;
    state.globalArp.enabled = false;
    scheduled.length = 0;
    scheduleHarmonyPreview(chord, ctx.currentTime + 0.1, 2, state.synth, 120);
    const simultaneous = [...scheduled];
    stopPreview();
    state.globalArp.enabled = true;
    // A long 4x pattern is still constrained to the requested loop bar.
    state.loopPreview.stop = false;
    scheduled.length = 0;
    const dense = { ...chord, notes: Array.from({ length: 12 }, (_, i) => i), repeats: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 4])) };
    scheduleHarmonyPreview(dense, ctx.currentTime + 0.1, 2, state.synth, 120);
    const boundedCount = scheduled.length;
    stopPreview();
    ctx.createOscillator = original;
    const payload = buildLoopPayload();
    payload.loopCount = 1;
    return { repeated, simultaneous, frequencies, boundedCount, payload };
  });
  const [c, e, g] = result.frequencies;
  const expected = [c, c, e, g, g, g, c, c];
  assert.deepEqual(result.repeated, expected);
  assert.deepEqual(result.simultaneous, result.frequencies, 'CHORD must not stack repeated voices');
  assert.equal(result.boundedCount, 8);
  const response = await fetch(`${origin}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.payload) });
  assert.equal(response.status, 200);
  const { file } = await response.json();
  const wav = Buffer.from(await (await fetch(origin + file)).arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  const rate = wav.readUInt32LE(24);
  for (let step = 0; step < expected.length; step++) {
    const start = Math.round((step * 0.25 + 0.05) * rate);
    const end = Math.round((step * 0.25 + 0.20) * rate);
    let crossings = 0;
    for (let sample = start + 1; sample < end; sample++) {
      if (wav.readInt16LE(44 + (sample - 1) * 2) <= 0 && wav.readInt16LE(44 + sample * 2) > 0) crossings++;
    }
    const measured = crossings / ((end - start) / rate);
    assert.ok(Math.abs(measured - expected[step]) < 10, `WAV step ${step}: ${measured} instead of ${expected[step]}`);
  }
});

test('sharing refuses an older library that would silently drop note repeats', async t => {
  const page = await openPage(t);
  await page.evaluate(() => { state.chords[0].repeats = { 0: 2 }; });
  let posts = 0;
  await page.route('**/api/patches', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"patches":[],"nextCursor":null}' });
  });
  await page.click('#sharePatch');
  await page.fill('#sharedPatchName', 'Preserve my repeats');
  await page.click('#publishPatch');
  await page.waitForFunction(() => document.getElementById('sharePatchStatus').textContent.includes('cannot save note repeats yet'));
  assert.equal(posts, 0);
  assert.deepEqual(await page.evaluate(() => state.chords[0].repeats), { 0: 2 });
});
