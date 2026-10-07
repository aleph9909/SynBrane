// The community library shares the existing v1 patch format and same-origin API.
(() => {
  const el = id => document.getElementById(id);
  const dialog = el('patchLibrary');
  const list = el('patchLibraryList');
  const status = el('libraryStatus');
  const shareStatus = el('sharePatchStatus');
  let cursor = null;
  let generation = 0;
  let loading = false;
  let publishing = false;
  let applying = false;

  async function request(path, options) {
    const response = await fetch(apiUrl(path), { ...options, signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'The patch library is unavailable. Please try again.');
    if (!data) throw new Error('The patch library returned an invalid response.');
    return data;
  }
  function message(error) {
    return error.name === 'TimeoutError' || error instanceof TypeError
      ? 'Could not reach the patch library. Please try again.' : error.message;
  }
  function download(record) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record.patch, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `synbrane-${record.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function row(patch) {
    const item = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('h4');
    name.textContent = patch.name;
    const byline = document.createElement('p');
    byline.className = 'meta';
    byline.textContent = `${patch.author || 'Anonymous'} · ${new Date(patch.createdAt).toLocaleDateString()}`;
    const detail = document.createElement('p');
    detail.className = 'meta';
    detail.textContent = `${patch.mode === 'rhythm' ? 'Rhythm' : patch.arp ? 'ARP' : 'Chord'} · ${patch.tempo} BPM · ${patch.chordCount} chord${patch.chordCount === 1 ? '' : 's'} · ${patch.tunings.join(', ')}`;
    info.append(name, byline, detail);
    const actions = document.createElement('div');
    actions.className = 'library-actions';
    for (const action of ['Load', 'Download']) {
      const button = document.createElement('button');
      button.textContent = action;
      button.className = action === 'Load' ? 'secondary' : 'ghost';
      button.setAttribute('aria-label', `${action} ${patch.name}`);
      button.onclick = async () => {
        if (action === 'Load' && applying) return;
        const token = generation;
        if (action === 'Load') applying = true;
        button.disabled = true;
        status.textContent = `${action === 'Load' ? 'Loading' : 'Downloading'} ${patch.name}…`;
        try {
          const record = await request(`/api/patches/${encodeURIComponent(patch.id)}`);
          if (action === 'Load') {
            // Load preset definitions first so renderActiveChord preserves custom notes.
            await Promise.all([...new Set(record.patch.chords.map(chord => chord.tuningId))].map(async tuningId => {
              if (!state.tunings.some(tuning => tuning.id === tuningId)) throw new Error('This patch uses a tuning that is no longer available.');
              if (!state.chordPresets[tuningId]?.length) delete state.chordPresets[tuningId];
              await ensureChordPresets(tuningId);
              if (!state.chordPresets[tuningId]?.length) throw new Error('Could not load the patch tuning. Please try again.');
            }));
            if (token !== generation || !dialog.open) return;
            applyPatch(record.patch);
            updateStatus(`Loaded ${record.name}`);
            dialog.close();
          } else if (token === generation && dialog.open) {
            download(record);
            status.textContent = `Downloaded ${record.name}`;
          }
        } catch (error) {
          if (token === generation) status.textContent = message(error);
        } finally {
          button.disabled = false;
          if (action === 'Load') applying = false;
        }
      };
      actions.append(button);
    }
    item.append(info, actions);
    return item;
  }
  async function browse(reset = false) {
    if (loading) return;
    loading = true;
    const token = generation;
    el('refreshPatchLibrary').disabled = true;
    el('morePatches').disabled = true;
    status.textContent = 'Loading patches…';
    try {
      const data = await request(`/api/patches${!reset && cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
      if (token !== generation) return;
      if (reset) list.replaceChildren();
      for (const patch of data.patches) list.append(row(patch));
      cursor = data.nextCursor;
      el('morePatches').hidden = !cursor;
      status.textContent = list.children.length ? '' : 'No patches yet. Share the first sound.';
    } catch (error) {
      if (token === generation) status.textContent = message(error);
    } finally {
      loading = false;
      el('refreshPatchLibrary').disabled = false;
      el('morePatches').disabled = false;
      // Reopening during an outstanding request must still fetch fresh data.
      if (token !== generation && dialog.open) browse(true);
    }
  }
  function open(share) {
    generation += 1;
    el('sharePatchDetails').open = share;
    dialog.showModal();
    browse(true);
    if (share) el('sharedPatchName').focus();
  }
  el('openPatchLibrary').onclick = () => open(false);
  el('sharePatch').onclick = () => open(true);
  el('closePatchLibrary').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation += 1; });
  el('refreshPatchLibrary').onclick = () => browse(true);
  el('morePatches').onclick = () => browse();
  el('sharedPatchSource').onchange = () => {
    const fromFile = el('sharedPatchSource').value === 'file';
    el('sharedPatchFileLabel').hidden = !fromFile;
    el('sharedPatchFile').required = fromFile;
  };
  el('sharePatchForm').onsubmit = async event => {
    event.preventDefault();
    if (publishing) return;
    publishing = true;
    el('publishPatch').disabled = true;
    shareStatus.textContent = 'Publishing…';
    try {
      let patch;
      if (el('sharedPatchSource').value === 'file') {
        const file = el('sharedPatchFile').files[0];
        if (!file) throw new Error('Choose a saved JSON patch.');
        if (file.size > 16 * 1024) throw new Error('Patch is too large (16 KiB maximum).');
        try { patch = JSON.parse(await file.text()); }
        catch { throw new Error('The file must contain a valid JSON patch.'); }
      } else patch = buildPatch();
      const body = JSON.stringify({ name: el('sharedPatchName').value.trim(), author: el('sharedPatchAuthor').value.trim(), patch });
      if (new Blob([body]).size > 16 * 1024) throw new Error('Patch is too large (16 KiB maximum).');
      if (Array.isArray(patch?.chords) && patch.chords.some(chord => Object.values(chord.repeats || {}).some(count => count > 1))) {
        const library = await request('/api/patches');
        if (!library.capabilities?.noteRepeats) throw new Error('The library cannot save note repeats yet. Please save this patch locally.');
      }
      const data = await request('/api/patches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      shareStatus.textContent = `Published ${data.patch.name}. It is now available to everyone.`;
      if (dialog.open) {
        // Invalidate any list request that began before the upload completed.
        generation += 1;
        browse(true);
      }
    } catch (error) { shareStatus.textContent = message(error); }
    finally { publishing = false; el('publishPatch').disabled = false; }
  };
})();
