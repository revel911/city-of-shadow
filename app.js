// ── Config — edit these two values ──────────────────────────────────
const CONFIG = {
  ROOT_FOLDER_ID: '1La--TBYjyQswMksN7EYwcbVxUlutsxTR',
  API_KEY: 'AIzaSyCvu6iSrATB8vqVxBdNrglS3IvdGlhRCFk',
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
    fields: 'files(id,name,mimeType)',
    orderBy: 'name',
    pageSize: '100',
    key: CONFIG.API_KEY,
  });
  const res = await fetch(`${DRIVE}/files?${p}`);
  const json = await res.json();
  if (json.error) throw new Error(`Drive error: ${json.error.message}`);
  return json.files || [];
}

async function driveExport(fileId) {
  const p = new URLSearchParams({ mimeType: 'text/plain', key: CONFIG.API_KEY });
  const res = await fetch(`${DRIVE}/files/${fileId}/export?${p}`);
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  return res.text();
}

function findFile(files, name) {
  return files.find(f => f.name === name) ?? null;
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

async function getPlayerData(folderId) {
  return cached(`player-${folderId}`, async () => {
    const files = await driveList(folderId);
    const sheetFile = findFile(files, 'Character Sheet');
    const storyFile = findFile(files, 'Story Thread');
    const [sheet, story] = await Promise.all([
      sheetFile ? driveExport(sheetFile.id) : Promise.resolve(''),
      storyFile ? driveExport(storyFile.id) : Promise.resolve(''),
    ]);
    return { sheet, story };
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
    const files = await getRootFiles();
    const f = findFile(files, 'Public Events Log');
    return f ? driveExport(f.id) : '';
  });
}

async function getWodFoundation() {
  return cached('wod', async () => {
    const files = await getRootFiles();
    const f = findFile(files, 'WoD Foundation');
    return f ? driveExport(f.id) : '';
  });
}

// ── Parse helpers ────────────────────────────────────────────────────
function parseStats(text) {
  return ['Blood','Heart','Mind','Spirit','Shadow'].flatMap(name => {
    const m = text.match(new RegExp(`${name}[:\\s]+([+-]?\\d+)`, 'i'));
    return m ? [{ name, value: parseInt(m[1], 10) }] : [];
  });
}

function parsePlaybook(text) {
  const m = text.match(/playbook[:\s]+([^\n]+)/i) || text.match(/\btype[:\s]+([^\n]+)/i);
  return m ? m[1].trim() : '';
}

function parseHandoff(story) {
  const lines = story.split('\n');
  const i = lines.findIndex(l => /handoff/i.test(l));
  if (i === -1) return '';
  return lines.slice(i + 1, i + 6).filter(Boolean).join(' ').slice(0, 200);
}

function recentLines(text, n = 8) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 20 && !l.startsWith('#') && !l.startsWith('---'))
    .slice(-n)
    .reverse();
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
        ${items.map(({ href, label }) =>
          `<li><a href="${href}" class="${route === href.replace('#','') ? 'active' : ''}">${esc(label)}</a></li>`
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

  let players = [], events = [], err = '';
  try {
    const [folders, log] = await Promise.all([getPlayerFolders(), getEventsLog()]);
    players = folders.filter(f => f.name);
    events  = recentLines(log);
  } catch (e) { err = e.message; }

  const errorHtml = err ? `
    <div class="error-card" style="margin-bottom:1.5rem">
      <h3>Drive not connected</h3>
      <p>${esc(err)}</p>
      <p class="error-setup">Set <code>API_KEY</code> in <code>app.js</code> and share Drive files publicly.</p>
    </div>` : '';

  const playerItems = players.length
    ? players.map(p => `<div class="quick-link" data-nav="/characters/${encodeURIComponent(p.name)}">${esc(p.name)}</div>`).join('')
    : '<p class="empty-note">No characters found.</p>';

  const eventItems = events.length
    ? `<div class="timeline">${events.map((e,i) => `
        <div class="timeline-item">
          <div class="timeline-num">${String(events.length-i).padStart(3,'0')}</div>
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
    <div class="dashboard-grid">
      <div class="sidebar-cards">
        <div class="card">
          <h2>Active Shadows</h2>
          ${playerItems}
          <div class="card-footer">
            <span class="card-footer-link" data-nav="/characters">All Characters &rarr;</span>
          </div>
        </div>
        <div class="card">
          <h2>Navigate</h2>
          <div class="quick-link purple" data-nav="/city">World Bible</div>
          <div class="quick-link purple" data-nav="/npcs">NPCs &amp; Factions</div>
          <div class="quick-link purple" data-nav="/events">Public Events Log</div>
        </div>
      </div>
      <div class="card">
        <h2>Recent Events</h2>
        ${eventItems}
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
    try { const d = await getPlayerData(p.id); return { ...p, ...d }; }
    catch { return { ...p, sheet: '', story: '' }; }
  }));

  const cards = chars.map(c => {
    const stats   = parseStats(c.sheet);
    const playbook = parsePlaybook(c.sheet);
    const handoff  = parseHandoff(c.story);
    return `
      <div class="char-card" data-nav="/characters/${encodeURIComponent(c.name)}">
        <div class="char-card-inner">
          <div>
            <div class="char-name">${esc(c.name)}</div>
            ${playbook ? `<div class="char-playbook">${esc(playbook)}</div>` : ''}
          </div>
          ${statPills(stats)}
          ${handoff ? `<div class="char-handoff">&ldquo;${esc(handoff)}&rdquo;</div>` : ''}
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

  let sheet = '', story = '';
  try { ({ sheet, story } = await getPlayerData(folder.id)); }
  catch (e) { showError('Could not load character data', e.message); return; }

  $content.innerHTML = `
    <div class="page-header">
      <h1>${esc(name)}</h1>
      <div class="ornament"><span style="font-size:.7rem">✦</span></div>
    </div>
    <div class="two-col">
      <div class="card">
        <h2>Character Sheet</h2>
        <div class="prose">${md(sheet)}</div>
      </div>
      <div class="card">
        <h2>Story Thread</h2>
        <div class="prose">${md(story)}</div>
      </div>
    </div>`;
}

// ── Page: NPCs ───────────────────────────────────────────────────────
async function renderNpcs() {
  setSideNav([{ title: 'NPCs', items: [{ href: '#/npcs', label: 'All NPCs' }] }]);
  showLoading('Consulting the city records\u2026');

  let worldBible = '', wod = '';
  try { [worldBible, wod] = await Promise.all([getWorldBible(), getWodFoundation()]); }
  catch (e) { showError('Could not load NPC data', e.message, true); return; }

  $content.innerHTML = `
    <div class="page-header">
      <h1>NPCs &amp; Factions</h1>
      <p>The city is full of players. Most of them will bleed you dry if you let them.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:1.5rem;max-width:52rem">
      <div class="card">
        <h2>World Bible</h2>
        <div class="prose">${md(worldBible)}</div>
      </div>
      ${wod ? `<div class="card"><h2>WoD Foundation</h2><div class="prose">${md(wod)}</div></div>` : ''}
    </div>`;
}

// ── Page: City ───────────────────────────────────────────────────────
async function renderCity() {
  setSideNav([{ title: 'City Notes', items: [{ href: '#/city', label: 'Overview' }] }]);
  showLoading('Reading the world bible\u2026');

  let worldBible = '', wod = '';
  try { [worldBible, wod] = await Promise.all([getWorldBible(), getWodFoundation()]); }
  catch (e) { showError('Could not load city data', e.message, true); return; }

  $content.innerHTML = `
    <div class="page-header">
      <h1>Richmond, Virginia</h1>
      <p>The shared world state. What is real, what is hidden, what is hunted.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:1.5rem;max-width:52rem">
      <div class="card"><h2>World Bible</h2><div class="prose">${md(worldBible)}</div></div>
      <div class="card"><h2>World of Darkness Lore</h2><div class="prose">${md(wod)}</div></div>
    </div>`;
}

// ── Page: Events ─────────────────────────────────────────────────────
async function renderEvents() {
  setSideNav([{ title: 'Events', items: [{ href: '#/events', label: 'Full Log' }] }]);
  showLoading('Unrolling the chronicle\u2026');

  let log = '';
  try { log = await getEventsLog(); }
  catch (e) { showError('Could not load events', e.message, true); return; }

  const hasHeaders = log.split('\n').filter(l => /^#+\s/.test(l)).length >= 3;

  let body = '';
  if (!log.trim()) {
    body = '<p class="empty-note">Events log is empty.</p>';
  } else if (hasHeaders) {
    body = `<div class="prose">${md(log)}</div>`;
  } else {
    const lines = log.split('\n').map(l=>l.trim()).filter(l=>l.length>0&&!l.startsWith('#')&&!l.startsWith('---'));
    body = `<div class="timeline">${[...lines].reverse().map((e,i)=>`
      <div class="timeline-item">
        <div class="timeline-num">${String(lines.length-i).padStart(3,'0')}</div>
        <div class="timeline-text">${esc(e)}</div>
      </div>`).join('')}</div>`;
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
  } else if (route === '/npcs') {
    await renderNpcs();
  } else if (route === '/city') {
    await renderCity();
  } else if (route === '/events') {
    await renderEvents();
  } else {
    $content.innerHTML = '<p class="empty-note">Page not found.</p>';
  }
}

// ── Global click delegation (handles data-nav and quick-links) ───────
document.addEventListener('click', e => {
  const el = e.target.closest('[data-nav]');
  if (el) { e.preventDefault(); navigate(el.dataset.nav); }
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  clearCache();
  render();
});

// ── Boot ─────────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
render();
