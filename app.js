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

    // Interaction Queue — per-player NPC interaction planning doc
    const interactionQueueFile = findBestFile(docFiles, /interaction\s*queue/i);

    const [sheetTexts, storyTexts, sessionLogText, interactionQueueText] = await Promise.all([
      Promise.all(sheetFiles.map(f => driveExport(f.id).catch(() => ''))),
      Promise.all(storyFiles.map(f => driveExport(f.id).catch(() => ''))),
      sessionLogFile?.id ? driveExport(sessionLogFile.id).catch(() => '') : Promise.resolve(''),
      interactionQueueFile?.id
        ? driveExport(interactionQueueFile.id, 'text/markdown').catch(() => driveExport(interactionQueueFile.id)).catch(() => '')
        : Promise.resolve(''),
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

    return { sheet, sheetArchive, handoff, handoffTitle, history, interactionQueue: interactionQueueText };
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
      // markdown export preserves tables and headings for NPC parsing + better display
      content: await driveExport(f.id, 'text/markdown').catch(() => driveExport(f.id)).catch(() => ''),
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

// ── NPC helpers ──────────────────────────────────────────────────────

function normalizeNPCStatus(text) {
  const t = (text || '').toLowerCase();
  if (/\b(deceased|dead|killed|terminated|died|murdered|no longer)\b/.test(t)) return 'deceased';
  if (/\b(gone|missing|fled|removed|departed|vanished|exiled)\b/.test(t)) return 'gone';
  return 'active';
}

function normalizeFaction(text) {
  const m = (text || '').match(/\b(Night|Power|Wild|Mortalis)\b/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : '';
}

// Canonical dedup key: strip all common titles iteratively, remove quoted nicknames.
function npcKey(name) {
  const TITLE = /^(?:det\.?|sgt\.?|dr\.?|father|fr\.?|mr\.?|ms\.?|mrs\.?|prof\.?|sir|lady|judge|councilor|the|rev\.?|lt\.?|col\.?|officer|chief)\s+/i;
  let k = name.toLowerCase().trim();
  // Strip titles from the front repeatedly to handle chained prefixes ("Det. Sgt. …")
  let prev;
  do { prev = k; k = k.replace(TITLE, ''); } while (k !== prev);
  // Remove quoted nicknames e.g. 'Ghost' or "Iron"
  return k.replace(/["'"'][^"'"']{1,30}["'"']/g, ' ').replace(/\s+/g, ' ').trim();
}

// Extract NPCs from any document text (handles markdown tables + bold-list entries under NPC headings).
function parseNPCsFromText(text, sourceLabel) {
  if (!text) return [];
  const npcs = [];
  const lines = text.split('\n');

  let inNPCSection = false;
  let sectionDepth = 0;
  let tableHeaders = null;
  let afterSeparator = false;

  for (const line of lines) {
    const raw = line.trim();

    // ── Heading ──
    const hm = raw.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const depth = hm[1].length;
      const title = hm[2];
      if (inNPCSection && depth <= sectionDepth) inNPCSection = false;
      // Broad set of headings that signal an NPC listing follows
      if (/\bnpcs?|cast|characters?|(?:key\s+)?figures?|notable|roster|dramatis|who.?s\s*here|residents?|personalities|people\b/i.test(title)) {
        inNPCSection = true;
        sectionDepth = depth;
      }
      tableHeaders = null;
      afterSeparator = false;
      continue;
    }

    // ── Markdown table row ──
    if (raw.startsWith('|')) {
      const cells = raw.split('|').slice(1, -1).map(c => c.trim());
      if (!cells.length) continue;

      // Separator row
      if (cells.every(c => /^[-:]+$/.test(c))) { afterSeparator = true; continue; }

      if (!afterSeparator) {
        // Header row — record column map
        const hl = cells.map(c => c.toLowerCase().replace(/\*+/g, '').trim());
        const hasStatus = hl.some(h => /^status$/.test(h));
        const hasName   = hl.some(h => /^(npc|name|character|person)$/.test(h));
        tableHeaders = (hasName || hasStatus || inNPCSection) ? hl : null;
        continue;
      }

      // Data row — only parse if we have column context or are in an NPC section
      if (!tableHeaders && !inNPCSection) continue;

      const hl = tableHeaders || [];
      const ni = Math.max(0, hl.findIndex(h => /^(npc|name|character|person)$/.test(h)));
      const si = hl.findIndex(h => /^status$/.test(h));
      const fi = hl.findIndex(h => /^(faction|affiliation)$/.test(h));
      const ri = hl.findIndex(h => /^(role|description|notes|context|relationship|key\s*notes?)$/.test(h));

      const name = (cells[ni] || '').replace(/\*+|\[|\]/g, '').trim();
      if (!name || name.length < 2 || /^[-=]+$/.test(name)) continue;

      const statusSrc  = si >= 0 ? cells[si] : cells.filter((_, j) => j !== ni).join(' ');
      const factionSrc = fi >= 0 ? cells[fi] : cells.join(' ');
      const roleText   = ri >= 0 ? cells[ri]
        : cells.filter((_, j) => j !== ni && j !== si && j !== fi).join(' | ');

      npcs.push({
        name,
        status:  normalizeNPCStatus(statusSrc),
        faction: normalizeFaction(factionSrc),
        role:    (roleText || (si >= 0 ? cells[si] : '')).slice(0, 160),
        source:  sourceLabel,
      });
      continue;
    }

    // Reset table state when leaving the table block
    if (raw && !raw.startsWith('|')) {
      if (afterSeparator) { afterSeparator = false; tableHeaders = null; }
    }

    // ── Bold/list entry under an NPC heading ──
    // e.g. "**Name** — role" or "- **Name**: description"
    if (inNPCSection && raw) {
      const m = raw.match(/^[-*•]?\s*\*{1,2}([A-Z][^*\n]{1,65}?)\*{1,2}\s*[—–:]\s*(.{5,})/);
      if (m) {
        const name = m[1].trim();
        const rest = m[2].trim();
        if (!/^[-=]+$/.test(name)) {
          npcs.push({
            name,
            status:  normalizeNPCStatus(rest),
            faction: normalizeFaction(rest),
            role:    rest.slice(0, 160),
            source:  sourceLabel,
          });
        }
      }
    }
  }

  return npcs;
}

// Pull NPCs from the structured YAML handoff fields that the markdown table parser cannot reach.
// open_interactions format: "Name — context"; tension_threads / must_not_forget are free-text
// but we mine them for deceased/gone indicators since those signal irreversible status changes.
function extractNPCsFromYamlHandoff(handoffText, sourceLabel) {
  if (!handoffText || !isYamlHandoff(handoffText)) return [];
  const data = parseYamlHandoff(handoffText);
  const npcs = [];

  // open_interactions — most reliable: "NPC Name — what's happening"
  for (const item of data.open_interactions) {
    const s = (item || '').trim();
    if (!s) continue;
    // Require em/en-dash separator so we can cleanly split name from context
    const sep = s.search(/\s*[—–]\s*/);
    if (sep <= 0) continue;
    const name = s.slice(0, sep).replace(/^["'`]|["'`]$/g, '').trim();
    const context = s.slice(sep).replace(/^[—–]\s*/, '').trim();
    // Sanity-check: name should start uppercase and not contain lowercase interior words
    if (!name || name.length < 2 || name.length > 70) continue;
    if (!/^[A-Z"']/.test(name) || /[a-z]\s+[a-z]/.test(name)) continue;
    npcs.push({
      name,
      status:  normalizeNPCStatus(context || s),
      faction: normalizeFaction(context || s),
      role:    context.slice(0, 160),
      source:  sourceLabel,
    });
  }

  // tension_threads + must_not_forget — mine only for deceased/gone signals;
  // 'active' entries here are too ambiguous to extract reliably as NPC records.
  const mineForDeceased = [...data.tension_threads, ...data.must_not_forget];
  for (const item of mineForDeceased) {
    const s = (item || '').trim();
    if (!s) continue;
    const status = normalizeNPCStatus(s);
    if (status === 'active') continue; // skip — can't safely identify the NPC from free text
    // Extract 2-word+ Title Case proper names from the text
    const nameRe = /\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+)\b/g;
    let m;
    while ((m = nameRe.exec(s)) !== null) {
      const name = m[1];
      if (name.length < 4 || name.length > 60) continue;
      npcs.push({ name, status, faction: normalizeFaction(s), role: s.slice(0, 160), source: sourceLabel });
    }
  }

  return npcs;
}

async function getAllNPCRoster() {
  return cached('npc-roster', async () => {
    // Gather all source documents in parallel
    const [worldBible, hubDocs, eventsLog, playerFolders] = await Promise.all([
      getWorldBible(),
      getHubDocs(),
      getEventsLog(),
      getPlayerFolders(),
    ]);

    const STATUS_RANK = { deceased: 3, gone: 2, active: 1 };
    const roster = new Map(); // npcKey → record

    // Sources are processed from least-to-most authoritative.
    // For the SAME status rank, later sources overwrite (last-seen wins = most specific/recent).
    // A higher status rank (deceased > gone > active) ALWAYS wins regardless of order —
    // once an NPC is known dead they stay dead even if an older document lists them as active.
    function addNPC(npc, source) {
      const key = npcKey(npc.name);
      if (!key || key.length < 2) return;
      const existing = roster.get(key);
      if (!existing) { roster.set(key, { ...npc, source }); return; }
      const rankNew = STATUS_RANK[npc.status] || 0;
      const rankOld = STATUS_RANK[existing.status] || 0;
      // Only replace if new record is same-or-higher rank (never downgrade deceased→active)
      if (rankNew >= rankOld) roster.set(key, { ...npc, source });
    }

    // 1. World Bible — foundational lore, least authoritative for current state
    for (const npc of parseNPCsFromText(worldBible, 'World Bible')) addNPC(npc, 'World Bible');

    // 2. Hub docs — current location/faction rosters
    for (const hub of hubDocs)
      for (const npc of parseNPCsFromText(hub.content, hub.name)) addNPC(npc, hub.name);

    // 3. Events Log — public events often mention NPCs with status context
    if (eventsLog)
      for (const npc of parseNPCsFromText(eventsLog, 'Events Log')) addNPC(npc, 'Events Log');

    // 5. Player story threads + interaction queues — most authoritative (session outcomes)
    const playerData = await Promise.all(
      playerFolders.filter(p => p.id && p.name).map(async p => {
        try { return { player: p.name, data: await getPlayerData(p.id, p.name) }; }
        catch { return null; }
      })
    );

    for (const pd of playerData.filter(Boolean)) {
      const label = pd.player + "'s story";

      // Pass 1 — YAML fields: open_interactions, tension_threads, must_not_forget
      // This is where most session NPCs live in structured handoffs
      for (const npc of extractNPCsFromYamlHandoff(pd.data.handoff, label))
        addNPC(npc, label);

      // Pass 2 — Markdown tables + bold-list entries across all fetched text
      // Covers story threads with explicit NPC tables and any non-YAML content
      const fullText = [
        pd.data.handoff          || '',
        pd.data.interactionQueue || '',
        pd.data.history          || '',
      ].join('\n\n');
      for (const npc of parseNPCsFromText(fullText, label))
        addNPC(npc, label);
    }

    // Sort: active (1) first, gone (2) next, deceased (3) last; alpha within each group
    return [...roster.values()].sort((a, b) => {
      const ra = STATUS_RANK[a.status] || 0;
      const rb = STATUS_RANK[b.status] || 0;
      return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
    });
  });
}

function renderNPCRoster(npcs) {
  if (!npcs.length) return '<p class="empty-note">No NPCs found.</p>';

  const factionClass = f => f ? `npc-faction npc-faction-${f.toLowerCase()}` : 'npc-faction npc-faction-none';
  const statusLabel  = { active: 'Active', deceased: 'Deceased', gone: 'Gone' };

  const card = npc => {
    const isGone = npc.status === 'deceased' || npc.status === 'gone';
    return `
    <div class="npc-card${isGone ? ' npc-card-gone' : ''}">
      <div class="npc-name">${esc(npc.name)}</div>
      <div class="npc-badges">
        ${npc.faction ? `<span class="${factionClass(npc.faction)}">${esc(npc.faction)}</span>` : ''}
        <span class="npc-status npc-status-${npc.status}">${statusLabel[npc.status] || 'Active'}</span>
      </div>
    </div>`;
  };

  // Group: active/gone first, deceased at bottom behind a toggle
  const living  = npcs.filter(n => n.status !== 'deceased');
  const dead    = npcs.filter(n => n.status === 'deceased');

  const deadSection = dead.length ? `
    <details class="history-toggle npc-dead-toggle" style="margin-top:1rem">
      <summary>Deceased (${dead.length})</summary>
      <div class="npc-grid history-body" style="margin-top:0.75rem">${dead.map(card).join('')}</div>
    </details>` : '';

  return `
    <div class="npc-grid">${living.map(card).join('')}</div>
    ${deadSection}`;
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

  const recentPlayers = players;
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
        <h2 style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:400;color:var(--gold-light);letter-spacing:.16em;text-transform:uppercase">Recent Characters</h2>
        <span class="card-footer-link" data-nav="/characters">All Characters (${players.length}) &rarr;</span>
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

// ── Structured handoff (YAML session log format) ────────────────────

function isYamlHandoff(text) {
  // Matches both the new top-level `handoff:` block and the old `current_handoff:` key
  return /^handoff\s*:/m.test(text) || /\b(where_we_are|who_is_present|last_beat)\s*:/m.test(text);
}

// Extract the text block nested under a given top-level YAML key.
// Stops when it hits another top-level key (no leading whitespace before `key:`).
function extractYamlBlock(text, topKey) {
  const re = new RegExp(`^${topKey}\\s*:\\s*\\n([\\s\\S]*?)(?=^\\S|\\Z)`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}

// Extract a scalar field from a YAML block (handles quoted, unquoted, block scalars |).
// blockText is the indented content under the parent key.
function extractYamlField(blockText, field) {
  // Block scalar (|): field followed by | then indented lines until next key
  const blockScalarRe = new RegExp(
    `^[ \\t]*${field}:\\s*\\|[ \\t]*\\n((?:[ \\t]+[^\\n]*\\n?)*)`,
    'm'
  );
  const bsm = blockText.match(blockScalarRe);
  if (bsm) {
    // Strip common leading indentation
    const lines = bsm[1].split('\n');
    const indent = lines[0].match(/^([ \t]*)/)[1].length;
    return lines.map(l => l.slice(indent)).join('\n').trim();
  }

  // Quoted scalar: field: "value" or field: 'value'
  const quotedRe = new RegExp(
    `^[ \\t]*${field}:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    'm'
  );
  const qm = blockText.match(quotedRe);
  if (qm) return (qm[1] ?? qm[2] ?? '').trim();

  // Unquoted scalar: field: value (stop at next same-or-lower-indent key or newline)
  const unquotedRe = new RegExp(`^[ \\t]*${field}:\\s+([^\\n|>][^\\n]*)`, 'm');
  const um = blockText.match(unquotedRe);
  if (um) return um[1].trim();

  return '';
}

// Extract a YAML list field (block `- item` format or inline `[a, b]`).
function extractYamlList(blockText, field) {
  // Inline: field: ["a", "b"]
  const inlineRe = new RegExp(`^[ \\t]*${field}:\\s*\\[([^\\]]+)\\]`, 'm');
  const im = blockText.match(inlineRe);
  if (im) {
    return im[1].split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
  }

  // Block: field:\n  - item
  const blockRe = new RegExp(`^[ \\t]*${field}:[^\\n]*\\n((?:[ \\t]+-[^\\n]+\\n?)*)`, 'm');
  const bm = blockText.match(blockRe);
  if (bm) {
    return bm[1].split('\n')
      .map(l => l.replace(/^[ \t]*-\s*["']?|["']?\s*$/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function parseYamlHandoff(text) {
  // Prefer the top-level `handoff:` block (schema v2).
  // Fall back to searching the full text (older format or flat YAML).
  const block = extractYamlBlock(text, 'handoff') || text;

  // Archive: collect all `label:` values from handoff_archive block
  const archiveBlock = extractYamlBlock(text, 'handoff_archive') || '';
  const archiveLabels = [...archiveBlock.matchAll(/[ \t]*label:\s*["']?([^"'\n]+)/g)]
    .map(m => m[1].trim()).filter(Boolean);

  // Also grab the current handoff label for the title
  const currentLabel = extractYamlField(block, 'label');

  return {
    label:             currentLabel,
    where_we_are:      extractYamlField(block, 'where_we_are'),
    who_is_present:    extractYamlField(block, 'who_is_present'),
    last_beat:         extractYamlField(block, 'last_beat'),
    player_intent:     extractYamlField(block, 'player_intent'),
    must_not_forget:   extractYamlList(block, 'must_not_forget'),
    mood:              extractYamlField(block, 'mood'),
    lore_flags:        extractYamlList(block, 'lore_flags'),
    harm:              extractYamlField(block, 'harm'),
    hold_remaining:    extractYamlField(block, 'hold_remaining'),
    tension_threads:   extractYamlList(block, 'tension_threads'),
    open_interactions: extractYamlList(block, 'open_interactions'),
    active_bonuses:    extractYamlList(block, 'active_bonuses'),
    hubs_touched:      extractYamlList(block, 'hubs_touched'),
    archive_labels:    archiveLabels,
  };
}

function renderYamlHandoff(data) {
  const fieldRow = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return '';
    if (Array.isArray(value)) {
      return `<div class="handoff-row">
        <div class="handoff-row-label">${esc(label)}</div>
        <ul class="handoff-list">${value.map(v => `<li>${esc(String(v))}</li>`).join('')}</ul>
      </div>`;
    }
    // Multiline prose (last_beat) — preserve line breaks, don't escape newlines away
    const hasNewlines = String(value).includes('\n');
    const bodyContent = hasNewlines
      ? `<div class="handoff-row-body handoff-prose">${esc(String(value)).replace(/\n/g, '<br>')}</div>`
      : `<div class="handoff-row-body">${esc(String(value))}</div>`;
    return `<div class="handoff-row">
      <div class="handoff-row-label">${esc(label)}</div>
      ${bodyContent}
    </div>`;
  };

  // Mechanical state row — only show if there's anything
  const mechParts = [
    data.harm         ? `Harm&nbsp;<strong>${esc(data.harm)}</strong>` : '',
    data.hold_remaining !== '' && data.hold_remaining !== '0' && data.hold_remaining
      ? `Hold&nbsp;<strong>${esc(data.hold_remaining)}</strong>` : '',
  ].filter(Boolean);
  const mechHtml = mechParts.length
    ? `<div class="handoff-row">
        <div class="handoff-row-label">State</div>
        <div class="handoff-row-body">${mechParts.join(' &nbsp;·&nbsp; ')}</div>
      </div>` : '';

  const archiveHtml = data.archive_labels.length
    ? `<details class="history-toggle" style="margin-top:1.25rem">
        <summary>Handoff Archive (${data.archive_labels.length} previous)</summary>
        <ul class="handoff-list history-body" style="margin-top:0.75rem">
          ${data.archive_labels.map(l => `<li>${esc(l)}</li>`).join('')}
        </ul>
      </details>`
    : '';

  return `<div class="structured-handoff">
    ${data.label ? `<div class="handoff-title">${esc(data.label)}</div>` : ''}
    ${fieldRow('Where We Are', data.where_we_are)}
    ${fieldRow('Present', data.who_is_present)}
    ${fieldRow('Last Beat', data.last_beat)}
    ${fieldRow('Tension Threads', data.tension_threads)}
    ${fieldRow('Must Not Forget', data.must_not_forget)}
    ${mechHtml}
    ${fieldRow('Active Bonuses', data.active_bonuses)}
    ${fieldRow('Player Intent', data.player_intent)}
    ${fieldRow('Mood', data.mood)}
    ${fieldRow('Lore Flags', data.lore_flags)}
    ${fieldRow('Open Interactions', data.open_interactions)}
    ${archiveHtml}
  </div>`;
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

  // Render handoff — use structured renderer for YAML session logs
  let handoffHtml = '<p class="empty-note">No handoff note found.</p>';
  if (handoff) {
    if (isYamlHandoff(handoff)) {
      handoffHtml = renderYamlHandoff(parseYamlHandoff(handoff));
    } else {
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

  let worldBible = '', wod = '', hubDocs = [], npcs = [];
  try {
    [worldBible, wod, hubDocs, npcs] = await Promise.all([
      getWorldBible(), getWodFoundation(), getHubDocs(), getAllNPCRoster(),
    ]);
  } catch (e) { showError('Could not load city data', e.message, true); return; }

  const activeHubs = hubDocs.filter(h => h.content.trim()).map(h => ({
    ...h,
    id: 'hub-' + h.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  }));

  setSideNav([
    { title: 'City', items: [
      { href: '#', label: 'Overview', scrollTo: 'city-overview' },
      ...(npcs.length ? [{ href: '#', label: 'NPCs', scrollTo: 'city-npcs' }] : []),
    ]},
    ...(activeHubs.length ? [{ title: 'Hubs', items: activeHubs.map(h => ({ href: '#/city', label: h.name, scrollTo: h.id })) }] : []),
  ]);

  const npcSection = `
    <div class="card" id="city-npcs">
      <h2>NPC Roster</h2>
      ${npcs.length ? renderNPCRoster(npcs) : '<p class="empty-note">No NPC data found.</p>'}
    </div>`;

  // Strip NPC sections before display — personality mechanics are GM-only.
  // The NPC roster card above the hubs is the player-facing view of who's here.
  const NPC_HEADINGS = /\bnpcs?|cast|characters?|(?:key\s+)?figures?|notable|roster|personalities|residents?|people\b/i;

  const hubCards = activeHubs.map(h => {
    const display = excludeMarkdownSections(h.content, NPC_HEADINGS);
    return `<div class="card" id="${h.id}"><h2>${esc(h.name)}</h2><div class="prose">${md(display)}</div></div>`;
  }).join('');

  const worldBibleCollapsible = worldBible ? `
    <div class="card">
      <details class="history-toggle">
        <summary>World Bible</summary>
        <div class="prose history-body">${md(worldBible)}</div>
      </details>
    </div>` : '';

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
    <div class="page-stack">
      ${npcSection}
      ${hubCards}
      ${worldBibleCollapsible}
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
    <div class="card">${body}</div>`;
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

// ── Dice Roller ───────────────────────────────────────────────────────
(function () {
  const fab    = document.getElementById('dice-fab');
  const panel  = document.getElementById('dice-panel');
  const close  = document.getElementById('dice-close');
  const rollBtn= document.getElementById('dice-roll-btn');
  const die1   = document.getElementById('die1');
  const die2   = document.getElementById('die2');
  const total  = document.getElementById('die-total');

  function d6() { return Math.floor(Math.random() * 6) + 1; }

  function roll() {
    const a = d6(), b = d6();
    die1.textContent  = a;
    die2.textContent  = b;
    total.textContent = a + b;
  }

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  close.addEventListener('click', () => panel.classList.remove('open'));
  rollBtn.addEventListener('click', roll);
}());
