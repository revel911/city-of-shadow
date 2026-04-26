// ── Config — edit these two values ──────────────────────────────────
const CONFIG = {
  ROOT_FOLDER_ID: '1La--TBYjyQswMksN7EYwcbVxUlutsxTR',
  API_KEY: 'AIzaSyCvu6iSrATB8vqVxBdNrglS3IvdGlhRCFk',
  EVENTS_DOC_ID: '1xd-JLhFHlrT0aDxgDC2f2Z6pUPLsC0gt6LborBMv-dc',
};

// ── Simple in-session cache (clears on page reload) ──────────────────
const _cache = new Map();

async function cached(key, fn) {
  if (_cache.has(key)) return _cache.get(key);
  const result = await fn();
  _cache.set(key, result);
  return result;
}

function clearCache() { _cache.clear(); }

// ── Google Drive API ─────────────────────────────────────────────────
const DRIVE = 'https://www.googleapis.com/drive/v3';

async function driveList(folderId) {
  const p = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'name',
    pageSize: '100',
    key: CONFIG.API_KEY,
  });
  const res = await fetch(`${DRIVE}/files?${p}`);
  const json = await res.json();
  if (json.error) throw new Error(`Drive error: ${json.error.message}`);
  return json.files || [];
}

async function driveExport(fileId, mimeType = 'text/plain') {
  const p = new URLSearchParams({ mimeType, key: CONFIG.API_KEY });
  const res = await fetch(`${DRIVE}/files/${fileId}/export?${p}`);
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  return res.text();
}

function findFile(files, name) {
  return files.find(f => f.name === name) ?? null;
}

// Find the most recently modified file whose name matches a pattern
function findBestFile(files, pattern) {
  const matches = files.filter(f => pattern.test(f.name));
  if (!matches.length) return null;
  return matches.sort((a, b) =>
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '')
  )[0];
}

// ── Data fetchers ────────────────────────────────────────────────────
async function getRootFiles() {
  return cached('root', () => driveList(CONFIG.ROOT_FOLDER_ID));
}

async function getPlayerFolders() {
  return cached('players', async () => {
    const root = await getRootFiles();
    const playersDir = findFile(root, 'Players');
    if (!playersDir) return [];
    const children = await driveList(playersDir.id);
    return children.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  });
}

async function getPlayerData(folderId, playerName = '') {
  return cached(`player-${folderId}`, async () => {
    const files = await driveList(folderId);

    const sheetFiles = files
      .filter(f => /character\s*sheet/i.test(f.name) && f.mimeType === 'application/vnd.google-apps.document')
      .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '')); // newest first

    const storyFiles = files
      .filter(f => /story\s*thread/i.test(f.name) && f.mimeType === 'application/vnd.google-apps.document')
      .sort((a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || '')); // oldest first

    // Look for session log in player folder first; fall back to root folder
    // (session logs are often stored at root with the character name prefixed)
    const docFiles = files.filter(f => f.mimeType === 'application/vnd.google-apps.document');
    let sessionLogFile = findBestFile(docFiles, /session log/i);
    if (!sessionLogFile && playerName) {
      const rootFiles = await getRootFiles();
      const firstName = playerName.trim().split(/\s+/)[0];
      sessionLogFile = findBestFile(
        rootFiles.filter(f => f.mimeType === 'application/vnd.google-apps.document'),
        new RegExp(firstName + '.*session\\s*log', 'i')
      );
    }

    const [sheetTexts, storyTexts, sessionLogText] = await Promise.all([
      Promise.all(sheetFiles.map(f => driveExport(f.id).catch(() => ''))),
      Promise.all(storyFiles.map(f => driveExport(f.id).catch(() => ''))),
      sessionLogFile?.id ? driveExport(sessionLogFile.id).catch(() => '') : Promise.resolve(''),
    ]);

    // Most recent sheet = truth; older sheets = archive
    const sheet = sheetTexts[0] || '';
    const sheetArchive = sheetFiles.slice(1).map((f, i) => ({ name: f.name, content: sheetTexts[i + 1] || '' }));

    let handoff = '', handoffTitle = '', history = '';
    if (sessionLogText) {
      handoffTitle = sessionLogFile.name;
      // Extract just the handoff note section; everything else goes to history
      const { handoff: h, history: logHistory } = splitStoryThread(sessionLogText);
      handoff = h;
      const storyHistory = storyTexts.filter(Boolean).reverse().join('\n\n---\n\n');
      history = [logHistory, storyHistory].filter(Boolean).join('\n\n---\n\n');
    } else if (storyTexts.length) {
      // Fallback: parse handoff from the most recent story thread
      const { handoff: h, history: recentHistory } = splitStoryThread(storyTexts[storyTexts.length - 1]);
      handoff = h;
      const olderParts = storyTexts.slice(0, -1).reverse().filter(Boolean); // newer-old first
      history = [recentHistory, ...olderParts].filter(Boolean).join('\n\n---\n\n');
    }

    return { sheet, sheetArchive, handoff, handoffTitle, history };
  });
}

async function getWorldBible() {
  return cached('world-bible', async () => {
    const files = await getRootFiles();
    const f = files.find(f => /world.bible/i.test(f.name) || f.name.startsWith('00'));
    return f ? driveExport(f.id) : '';
  });
}

async function getEventsLog() {
  return cached('events', async () => {
    // Pinned doc — always use it when configured
    if (CONFIG.EVENTS_DOC_ID) {
      // Prefer markdown export — preserves heading styles as ## markers so
      // structure detection and section reversal work correctly.
      return driveExport(CONFIG.EVENTS_DOC_ID, 'text/markdown')
        .catch(() => driveExport(CONFIG.EVENTS_DOC_ID))
        .catch(() => '');
    }

    const files = await getRootFiles();
    const parts = [];

    const eventsFolder = files.find(f =>
      f.mimeType === 'application/vnd.google-apps.folder' && /^events$/i.test(f.name)
    );
    if (eventsFolder) {
      const eventFiles = await driveList(eventsFolder.id);
      const docs = eventFiles
        .filter(f => f.mimeType === 'application/vnd.google-apps.document')
        .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      if (docs.length) {
        const texts = await Promise.all(docs.map(f => driveExport(f.id).catch(() => '')));
        return texts.filter(Boolean).join('\n\n---\n\n');
      }
    }

    const logFile = findBestFile(files, /public\s*events/i) || findBestFile(files, /^02\s*[—-]/);
    if (logFile) {
      const logText = await driveExport(logFile.id).catch(() => '');
      if (logText && !/\[YYYY-MM-DD\]/.test(logText) && logText.trim().length > 150) {
        parts.push(logText);
      }
    }

    return parts.filter(Boolean).join('\n\n---\n\n');
  });
}

async function getWodFoundation() {
  return cached('wod', async () => {
    const files = await getRootFiles();
    const f = findBestFile(files, /wod\s*foundation|world\s*of\s*darkness/i);
    return f ? driveExport(f.id) : '';
  });
}

async function getHubDocs() {
  return cached('hubs', async () => {
    const files = await getRootFiles();
    const hubsFolder = files.find(f =>
      f.mimeType === 'application/vnd.google-apps.folder' && /^hubs$/i.test(f.name)
    );
    if (!hubsFolder) return [];

    const hubFiles = await driveList(hubsFolder.id);
    const docs = hubFiles
      .filter(f => f.mimeType === 'application/vnd.google-apps.document')
      .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.all(docs.map(async f => ({
      name: f.name.replace(/^Hub\s*[—–-]\s*/i, ''), // strip "Hub — " prefix for display
      rawName: f.name,
      content: await driveExport(f.id).catch(() => ''),
    })));
  });
}

// ── Parse helpers ────────────────────────────────────────────────────
function parseStats(text) {
  const statNames = ['Blood','Heart','Mind','Spirit','Shadow'];
  const found = new Map();

  // Strategy 1: stat name and value on the same line
  // Handles: "Blood: +2", "Blood  0", "Blood	-1", "Blood (+2)", etc.
  for (const name of statNames) {
    const m = text.match(new RegExp(`${name}[^\\n\\d+-]*([+-]?\\d+)`, 'i'));
    if (m) found.set(name, parseInt(m[1], 10));
  }

  // Strategy 2: column-based table — names on one line, values on the next
  // Handles Google Docs tables exported as tab-separated rows, e.g.:
  //   Blood  Heart  Mind  Spirit  Shadow
  //   +2     0      -1    +1      +2
  if (found.size < 3) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const presentStats = statNames.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(lines[i]));
      if (presentStats.length < 2) continue; // need 2+ stat names on one line to treat it as a header row
      for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
        const nums = (lines[j].match(/[+-]?\d+/g) || []).map(Number);
        if (nums.length >= presentStats.length) {
          presentStats.forEach((name, idx) => { if (!found.has(name)) found.set(name, nums[idx]); });
          break;
        }
      }
      if (found.size >= 3) break;
    }
  }

  return statNames.flatMap(n => found.has(n) ? [{ name: n, value: found.get(n) }] : []);
}

function parsePlaybook(text) {
  const m = text.match(/playbook[:\s]+([^\n]+)/i) || text.match(/\btype[:\s]+([^\n]+)/i);
  return m ? m[1].trim() : '';
}


function recentLines(text, n = 8) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 20 && !l.startsWith('#') && !l.startsWith('---'))
    .slice(-n)
    .reverse();
}

// ── Markdown section helpers ─────────────────────────────────────────

// Extract only the H2+ sections whose title matches one of the given patterns
function extractMarkdownSections(text, ...patterns) {
  const lines = text.split('\n');
  const out = [];
  let capturing = false;
  let captureDepth = 0;

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) {
      const depth = m[1].length;
      const title = m[2];
      if (capturing && depth <= captureDepth) capturing = false;
      if (!capturing && patterns.some(p => p.test(title))) {
        capturing = true;
        captureDepth = depth;
      }
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').trim();
}

// Return everything EXCEPT the H2+ sections whose title matches any of the given patterns
function excludeMarkdownSections(text, ...patterns) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  let skipDepth = 0;

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) {
      const depth = m[1].length;
      const title = m[2];
      if (skipping && depth <= skipDepth) skipping = false;
      if (!skipping && patterns.some(p => p.test(title))) {
        skipping = true;
        skipDepth = depth;
      }
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').trim();
}

// ── HTML helpers ─────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  if (!text || !text.trim()) return '<p class="empty-note">No content available.</p>';
  return typeof marked !== 'undefined' ? marked.parse(text) : `<pre>${esc(text)}</pre>`;
}

function statPills(stats) {
  if (!stats.length) return '';
  return `<div class="stat-block">${stats.map(({name, value}) =>
    `<div class="stat-pill">
      <span class="stat-name">${name.slice(0,3)}</span>
      <span class="stat-value ${value>0?'pos':value<0?'neg':'zero'}">${value>0?'+':''}${value}</span>
    </div>`).join('')}</div>`;
}

// ── DOM refs ─────────────────────────────────────────────────────────
const $content  = document.getElementById('content');
const $sideNav  = document.getElementById('side-nav');

function showLoading(msg = 'The shadows stir\u2026') {
  $content.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>${msg}</p>
    </div>`;
}

function showError(title, msg, showSetup = false) {
  $content.innerHTML = `
    <div class="error-card">
      <h3>${esc(title)}</h3>
      <p>${esc(msg)}</p>
      ${showSetup ? `<p class="error-setup">
        Open <code>app.js</code> and replace <code>YOUR_GOOGLE_API_KEY_HERE</code> with your key.
        Make sure all Drive files are shared as <em>"Anyone with link can view"</em>.
      </p>` : ''}
    </div>`;
}

function setSideNav(sections) {
  if (!sections.length) { $sideNav.innerHTML = ''; return; }
  const route = getRoute();
  $sideNav.innerHTML = sections.map(({ title, items }) => `
    <div class="side-section">
      <p class="side-section-title">${title}</p>
      <ul class="side-links">
        ${items.map(({ href, label, scrollTo }) => scrollTo
          ? `<li><a href="#" data-scroll-to="${scrollTo}">${esc(label)}</a></li>`
          : `<li><a href="${href}" class="${route === href.replace('#','') ? 'active' : ''}">${esc(label)}</a></li>`
        ).join('')}
      </ul>
    </div>`).join('');
}

function updateTopNav() {
  const route = getRoute();
  document.querySelectorAll('.nav-links a').forEach(a => {
    const r = a.dataset.route;
    const isActive = r === '/' ? (route === '/' || route === '') : route.startsWith(r);
    a.classList.toggle('active', isActive);
  });
}

// ── Page: Summary ────────────────────────────────────────────────────
async function renderSummary() {
  setSideNav([]);
  showLoading('Reading the city\u2026');

  let players = [], events = '', err = '';
  try {
    const [folders, log] = await Promise.all([getPlayerFolders(), getEventsLog()]);
    players = folders.filter(f => f.name)
      .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    events = log;
  } catch (e) { err = e.message; }

  // Load character data for the 3 most recently active players
  const recentPlayers = players.slice(0, 3);
  const recentChars = await Promise.all(
    recentPlayers.map(async p => {
      try { const d = await getPlayerData(p.id, p.name); return { ...p, ...d }; }
      catch { return { ...p, sheet: '', sheetArchive: [], handoff: '', handoffTitle: '', history: '' }; }
    })
  );

  const errorHtml = err ? `
    <div class="error-card" style="margin-bottom:1.5rem">
      <h3>Drive not connected</h3>
      <p>${esc(err)}</p>
      <p class="error-setup">Set <code>API_KEY</code> in <code>app.js</code> and share Drive files publicly.</p>
    </div>` : '';

  const charCards = recentChars.map(c => {
    const stats    = parseStats(c.sheet);
    const playbook = parsePlaybook(c.sheet);
    return `
      <div class="char-card" data-nav="/characters/${encodeURIComponent(c.name)}">
        <div class="char-card-inner">
          <div>
            <div class="char-name">${esc(c.name)}</div>
            ${playbook ? `<div class="char-playbook">${esc(playbook)}</div>` : ''}
          </div>
          ${statPills(stats)}
          <div class="char-link">View Sheet &rarr;</div>
        </div>
      </div>`;
  }).join('');

  const recentCharSection = recentChars.length ? `
    <div style="margin-bottom:1.75rem">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:.75rem">
        <h2 style="font-family:'IM Fell English',serif;font-size:1.1rem;color:var(--gold-light);letter-spacing:.04em">Recent Characters</h2>
        <span class="card-footer-link" data-nav="/characters">All Characters &rarr;</span>
      </div>
      <div class="char-grid">${charCards}</div>
    </div>` : '';

  const eventItems = recentLines(events);
  const eventHtml = eventItems.length
    ? `<div class="timeline">${eventItems.map((e, i) => `
        <div class="timeline-item">
          <div class="timeline-num">${String(eventItems.length - i).padStart(3, '0')}</div>
          <div class="timeline-text">${esc(e)}</div>
        </div>`).join('')}</div>`
    : '<p class="empty-note">Events log not loaded.</p>';

  $content.innerHTML = `
    ${errorHtml}
    <div class="page-header">
      <h1>Richmond, Virginia</h1>
      <p>The city breathes. The city bleeds. The city remembers.</p>
      <div class="ornament"><span style="font-size:.7rem">✦</span></div>
    </div>
    ${recentCharSection}
    <div class="dashboard-grid">
      <div class="sidebar-cards">
        <div class="card">
          <h2>Navigate</h2>
          <div class="quick-link purple" data-nav="/characters">Characters</div>
          <div class="quick-link purple" data-nav="/city">City</div>
          <div class="quick-link purple" data-nav="/events">Public Events Log</div>
        </div>
      </div>
      <div class="card">
        <h2>Recent Events</h2>
        ${eventHtml}
        <div class="card-footer">
          <span class="card-footer-link" data-nav="/events">Full Events Log &rarr;</span>
        </div>
      </div>
    </div>`;
}

// ── Page: Characters list ────────────────────────────────────────────
async function renderCharacters() {
  showLoading('Gathering the shadows\u2026');

  let players = [];
  try { players = await getPlayerFolders(); }
  catch (e) {
    showError('Could not load characters', e.message, true);
    setSideNav([{ title: 'Characters', items: [{ href: '#/characters', label: 'All Characters' }] }]);
    return;
  }

  setSideNav([{ title: 'Characters', items: [
    { href: '#/characters', label: 'All Characters' },
    ...players.filter(p=>p.name).map(p => ({ href: `#/characters/${encodeURIComponent(p.name)}`, label: p.name })),
  ]}]);

  const chars = await Promise.all(players.filter(p=>p.id&&p.name).map(async p => {
    try { const d = await getPlayerData(p.id, p.name); return { ...p, ...d }; }
    catch { return { ...p, sheet: '', sheetArchive: [], handoff: '', handoffTitle: '', history: '' }; }
  }));

  const cards = chars.map(c => {
    const stats    = parseStats(c.sheet);
    const playbook = parsePlaybook(c.sheet);
    // Strip markdown syntax and code fences from handoff for the card preview
    const handoffPreview = (c.handoff || '')
      .replace(/```[\s\S]*?```/g, '').replace(/^#+\s.*/gm, '')
      .split('\n').map(l => l.trim()).filter(l => l.length > 5)
      .join(' ').slice(0, 200);
    return `
      <div class="char-card" data-nav="/characters/${encodeURIComponent(c.name)}">
        <div class="char-card-inner">
          <div>
            <div class="char-name">${esc(c.name)}</div>
            ${playbook ? `<div class="char-playbook">${esc(playbook)}</div>` : ''}
          </div>
          ${statPills(stats)}
          ${handoffPreview ? `<div class="char-handoff">&ldquo;${esc(handoffPreview)}&rdquo;</div>` : ''}
          <div class="char-link">View Full Sheet &rarr;</div>
        </div>
      </div>`;
  }).join('');

  $content.innerHTML = `
    <div class="page-header">
      <h1>The Shadows</h1>
      <p>Those who walk between the world that is and the world that hungers.</p>
    </div>
    ${chars.length ? `<div class="char-grid">${cards}</div>` : '<p class="empty-note">No characters found in Drive.</p>'}`;
}

// ── Split story thread into handoff note + session history ───────────
function splitStoryThread(text) {
  if (!text.trim()) return { handoff: '', history: '' };

  // Prefer a named CURRENT HANDOFF NOTE section (the standard MC format)
  const handoffSection = extractMarkdownSections(text, /current\s*handoff/i);
  if (handoffSection) {
    return {
      handoff: handoffSection,
      history: excludeMarkdownSections(text, /current\s*handoff/i).trim(),
    };
  }

  // Fallback: cut at the first separator that isn't in the opening metadata block
  const lines = text.split('\n');
  let splitIdx = lines.length;
  for (let i = 5; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^-{3,}$/.test(t) || t === '===' || /^#{1,3}\s+(session|entry|\d{4})/i.test(t)) {
      splitIdx = i;
      break;
    }
  }
  return {
    handoff: lines.slice(0, splitIdx).join('\n').trim(),
    history: lines.slice(splitIdx).join('\n').trim(),
  };
}

// ── Page: Single character ───────────────────────────────────────────
async function renderCharacter(name) {
  showLoading(`Finding ${esc(name)}\u2026`);

  let players = [];
  try { players = await getPlayerFolders(); }
  catch (e) { showError('Could not load character', e.message, true); return; }

  setSideNav([{ title: 'Characters', items: [
    { href: '#/characters', label: '\u2190 All Characters' },
    ...players.filter(p=>p.name).map(p => ({ href: `#/characters/${encodeURIComponent(p.name)}`, label: p.name })),
  ]}]);

  const folder = players.find(p => p.name === name);
  if (!folder) { showError('Character not found', `No folder named "${esc(name)}" in Drive.`); return; }

  let sheet = '', sheetArchive = [], handoff = '', handoffTitle = '', history = '';
  try { ({ sheet, sheetArchive, handoff, handoffTitle, history } = await getPlayerData(folder.id, name)); }
  catch (e) { showError('Could not load character data', e.message); return; }

  const archiveHtml = sheetArchive.length ? `
    <details class="history-toggle">
      <summary>Previous Sheets (${sheetArchive.length})</summary>
      ${sheetArchive.map(({ name: n, content }) => `
        <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)">
          <p class="empty-note" style="margin-bottom:.5rem">${esc(n)}</p>
          <div class="prose history-body">${md(content)}</div>
        </div>`).join('')}
    </details>` : '';

  const historyHtml = history ? `
    <details class="history-toggle">
      <summary>Session History</summary>
      <div class="prose history-body">${md(history)}</div>
    </details>` : '';

  // Render handoff with paragraph-count truncation
  let handoffHtml = '<p class="empty-note">No handoff note found.</p>';
  if (handoff) {
    const grafs = handoff.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const FOLD = 5;
    if (grafs.length <= FOLD) {
      handoffHtml = `<div class="prose">${md(handoff)}</div>`;
    } else {
      const above = grafs.slice(0, FOLD).join('\n\n');
      const below = grafs.slice(FOLD).join('\n\n');
      handoffHtml = `
        <div class="prose">${md(above)}</div>
        <details class="history-toggle" style="margin-top:1rem">
          <summary>Continue reading</summary>
          <div class="prose history-body">${md(below)}</div>
        </details>`;
    }
  }

  $content.innerHTML = `
    <div class="page-header">
      <h1>${esc(name)}</h1>
      <div class="ornament"><span style="font-size:.7rem">✦</span></div>
    </div>
    <div class="two-col">
      <div class="card">
        <h2>Character Sheet</h2>
        <div class="prose">${md(sheet)}</div>
        ${archiveHtml}
      </div>
      <div class="card">
        <h2>Current Handoff</h2>
        ${handoffTitle ? `<p class="handoff-source">${esc(handoffTitle)}</p>` : ''}
        ${handoffHtml}
        ${historyHtml}
      </div>
    </div>`;
}

// ── Page: City ───────────────────────────────────────────────────────
async function renderCity() {
  showLoading('Reading the world bible\u2026');

  let worldBible = '', wod = '', hubDocs = [];
  try {
    [worldBible, wod, hubDocs] = await Promise.all([getWorldBible(), getWodFoundation(), getHubDocs()]);
  } catch (e) { showError('Could not load city data', e.message, true); return; }

  const activeHubs = hubDocs.filter(h => h.content.trim()).map(h => ({
    ...h,
    id: 'hub-' + h.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  }));

  setSideNav([
    { title: 'City', items: [{ href: '#', label: 'Overview', scrollTo: 'city-overview' }] },
    ...(activeHubs.length ? [{ title: 'Hubs', items: activeHubs.map(h => ({ href: '#/city', label: h.name, scrollTo: h.id })) }] : []),
  ]);

  const hubCards = activeHubs.map(h =>
    `<div class="card" id="${h.id}"><h2>${esc(h.name)}</h2><div class="prose">${md(h.content)}</div></div>`
  ).join('');

  const wodCollapsible = wod ? `
    <div class="card">
      <details class="history-toggle">
        <summary>World of Darkness Lore Reference</summary>
        <div class="prose history-body">${md(wod)}</div>
      </details>
    </div>` : '';

  $content.innerHTML = `
    <div id="city-overview" class="page-header">
      <h1>Richmond, Virginia</h1>
      <p>The shared world state. What is real, what is hidden, what is hunted.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:1.5rem;max-width:52rem">
      <div class="card"><h2>World Bible</h2><div class="prose">${md(worldBible)}</div></div>
      ${hubCards}
      ${wodCollapsible}
    </div>`;
}

// Split a document into { preamble, sections } for chronological reordering.
// Preamble = content before the first heading (title block, kept at top).
// Sections = each heading + its body, in document order (caller reverses).
function splitMarkdownSections(text) {
  // 1. Explicit --- separators
  const bySep = text.split(/\n\s*-{3,}\s*\n/).map(s => s.trim()).filter(Boolean);
  if (bySep.length > 1) return { preamble: '', sections: bySep };

  // 2. Any H1–H3 heading as section boundary
  const lines = text.split('\n');
  const preambleLines = [];
  const sections = [];
  let cur = null;

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (cur !== null && cur.some(l => l.trim())) sections.push(cur.join('\n').trim());
      cur = [line];
    } else if (cur !== null) {
      cur.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (cur !== null && cur.some(l => l.trim())) sections.push(cur.join('\n').trim());

  if (sections.length >= 2) {
    return { preamble: preambleLines.join('\n').trim(), sections };
  }

  // 3. No detectable structure
  return { preamble: '', sections: [text] };
}

// ── Page: Events ─────────────────────────────────────────────────────
async function renderEvents() {
  setSideNav([{ title: 'Events', items: [{ href: '#/events', label: 'Full Log' }] }]);
  showLoading('Unrolling the chronicle\u2026');

  let log = '';
  try { log = await getEventsLog(); }
  catch (e) { showError('Could not load events', e.message, true); return; }

  let body = '';
  if (!log.trim()) {
    body = '<p class="empty-note">Events log is empty.</p>';
  } else {
    const { preamble, sections } = splitMarkdownSections(log);
    if (sections.length > 1) {
      // Reverse entry sections; keep preamble (doc title/intro) pinned to top
      const reversed = [...sections].reverse();
      const parts = preamble ? [preamble, ...reversed] : reversed;
      body = `<div class="prose events-prose">${md(parts.join('\n\n---\n\n'))}</div>`;
    } else {
      // No heading/separator structure found (likely plain-text Google Docs export).
      // Normalize single newlines → double so marked.js creates proper <p> tags,
      // then group paragraphs into visual entries separated by <hr>.
      const normalized = log
        .replace(/\r\n/g, '\n')
        .replace(/([^\n])\n(?!\n)/g, '$1\n\n')
        .trim();
      const grafs = normalized.split(/\n{2,}/).map(g => g.trim()).filter(Boolean);

      if (grafs.length < 3) {
        body = `<div class="prose events-prose">${md(normalized)}</div>`;
      } else {
        // Heuristic: a short paragraph (≤ 80 chars) that isn't the very first one
        // is likely an entry title — use it as a section break.
        const chunks = [];
        let chunk = [];
        grafs.forEach((g, i) => {
          const looksLikeTitle = i > 0 && g.length <= 80 && !g.endsWith('.');
          if (looksLikeTitle && chunk.length) { chunks.push(chunk); chunk = []; }
          chunk.push(g);
        });
        if (chunk.length) chunks.push(chunk);

        const rendered = (chunks.length > 1 ? chunks : [grafs])
          .map(c => `<div class="events-entry">${md(c.join('\n\n'))}</div>`)
          .join('');
        body = `<div class="prose events-prose">${rendered}</div>`;
      }
    }
  }

  $content.innerHTML = `
    <div class="page-header">
      <h1>Public Events Log</h1>
      <p>The city&rsquo;s memory. Append-only. Everything that happened, happened.</p>
    </div>
    <div class="card" style="max-width:46rem">${body}</div>`;
}

// ── Router ───────────────────────────────────────────────────────────
function getRoute() {
  return window.location.hash.replace(/^#/, '') || '/';
}

function navigate(path) {
  window.location.hash = path;
}

async function render() {
  const route = getRoute();
  updateTopNav();

  if (route === '/' || route === '') {
    await renderSummary();
  } else if (route === '/characters') {
    await renderCharacters();
  } else if (route.startsWith('/characters/')) {
    await renderCharacter(decodeURIComponent(route.replace('/characters/', '')));
  } else if (route === '/city') {
    await renderCity();
  } else if (route === '/events') {
    await renderEvents();
  } else {
    $content.innerHTML = '<p class="empty-note">Page not found.</p>';
  }
}

// ── Mobile nav toggle ────────────────────────────────────────────────
function closeDrawer() { document.body.classList.remove('nav-open'); }

document.getElementById('nav-toggle').addEventListener('click', () => {
  document.body.classList.toggle('nav-open');
});

document.getElementById('nav-overlay').addEventListener('click', closeDrawer);

// Close drawer when a drawer link is tapped
document.querySelectorAll('[data-drawer-link]').forEach(a => {
  a.addEventListener('click', closeDrawer);
});

// ── Global click delegation (handles data-nav, quick-links, scroll anchors) ─
document.addEventListener('click', e => {
  const scrollEl = e.target.closest('[data-scroll-to]');
  if (scrollEl) {
    e.preventDefault();
    const target = document.getElementById(scrollEl.dataset.scrollTo);
    if (target) {
      const navHeight = document.getElementById('top-nav').offsetHeight;
      const y = target.getBoundingClientRect().top + window.scrollY - navHeight - 12;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
    return;
  }
  const el = e.target.closest('[data-nav]');
  if (el) { e.preventDefault(); navigate(el.dataset.nav); }
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  clearCache();
  render();
});

// ── Update drawer active state alongside top nav ──────────────────────
const _origUpdateTopNav = updateTopNav;
updateTopNav = function() {
  _origUpdateTopNav();
  const route = getRoute();
  document.querySelectorAll('#nav-drawer a').forEach(a => {
    const r = a.dataset.route;
    const isActive = r === '/' ? (route === '/' || route === '') : route.startsWith(r);
    a.classList.toggle('active', isActive);
  });
};

// ── Boot ─────────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
render();
