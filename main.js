const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, nativeTheme,
  clipboard, dialog, nativeImage, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const MAX_LOADED = 2;   // only this many chat accounts stay alive in RAM
const SIDEBAR = 72;

// ---- slots (ids are fixed, so saved logins never move) ----
// Claude 1-9 | ChatGPT, DeepSeek | Video, Progress notes, Shelf
const CLAUDE = Array.from({ length: 9 }, (_, k) => ({
  id: k, group: 'claude', kind: 'chat', key: 'claude', name: 'Claude', label: String(k + 1),
  home: 'https://claude.ai', fresh: 'https://claude.ai/new',
  accel: `CmdOrCtrl+${k + 1}`, partition: `persist:acc${k}`,
}));

const SLOTS = [
  ...CLAUDE,
  {
    id: 9, group: 'ai', kind: 'chat', key: 'chatgpt', name: 'ChatGPT', label: '1',
    home: 'https://chatgpt.com', fresh: 'https://chatgpt.com/',
    accel: 'CmdOrCtrl+Shift+1', partition: 'persist:acc9',
  },
  {
    id: 11, group: 'ai', kind: 'chat', key: 'deepseek', name: 'DeepSeek', label: '2',
    home: 'https://chat.deepseek.com', fresh: 'https://chat.deepseek.com/',
    accel: 'CmdOrCtrl+Shift+2', partition: 'persist:acc11', // keeps the old DeepSeek login
  },
  { id: 20, group: 'tools', kind: 'tool', key: 'video', name: 'Video', icon: 'tv',
    file: 'video.html', accel: 'CmdOrCtrl+Alt+1', partition: 'persist:video' },
  { id: 21, group: 'tools', kind: 'tool', key: 'notes', name: 'Progress notes', icon: 'doc',
    file: 'notes.html', accel: 'CmdOrCtrl+Alt+2', partition: 'persist:local' },
  { id: 22, group: 'tools', kind: 'tool', key: 'shelf', name: 'Shelf', icon: 'folder',
    file: 'shelf.html', accel: 'CmdOrCtrl+Alt+3', partition: 'persist:local' },
];
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));
const CHAT_IDS = SLOTS.filter((s) => s.kind === 'chat').map((s) => s.id);
const TOOL_IDS = SLOTS.filter((s) => s.kind === 'tool').map((s) => s.id);
const VIDEO = 20, NOTES = 21, SHELF_ID = 22;

const hint = (s) => s.accel.replace('CmdOrCtrl', 'Cmd').replace('Alt', 'Opt');
const titleOf = (s) =>
  (s.kind === 'chat' ? `${s.name} ${s.label}` : s.name) + `  (${hint(s)})`;

// Plain Chrome UA with the Chrome version Electron really runs
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Login popups stay inside the app, everything else opens in your browser
const INAPP_HOSTS = [
  'claude.ai', 'anthropic.com',
  'chatgpt.com', 'openai.com', 'auth0.com',
  'deepseek.com',
  'google.com', 'microsoft.com', 'microsoftonline.com', 'live.com', 'apple.com',
];
const hostMatches = (host, d) => host === d || host.endsWith('.' + d);

const bg = () => (nativeTheme.shouldUseDarkColors ? '#161616' : '#fafafa');

// ---- shelf (local folder) ----
const SHELF = path.join(app.getPath('documents'), 'Parallax Shelf');
const SUBFOLDERS = ['Resources', 'Generated', 'Videos', 'Notes'];
const NOTES_FILE = () => path.join(SHELF, 'Notes', 'progress.md');
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.py', '.js', '.ts', '.jsx', '.tsx',
  '.html', '.css', '.c', '.cpp', '.h', '.java', '.go', '.rs', '.sh', '.yml', '.yaml', '.toml', '.xml', '.log', '.tex',
]);

function ensureShelf() {
  for (const s of SUBFOLDERS) fs.mkdirSync(path.join(SHELF, s), { recursive: true });
}

// resolves a path inside the shelf, refuses anything outside it
function safe(rel = '') {
  const p = path.resolve(SHELF, rel);
  if (p !== SHELF && !p.startsWith(SHELF + path.sep)) throw new Error('outside shelf');
  return p;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let out = name, n = 1;
  while (fs.existsSync(path.join(dir, out))) out = `${base} (${n++})${ext}`;
  return out;
}

function copyIn(dir, src) {
  const dest = path.join(dir, uniqueName(dir, path.basename(src)));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function toast(body) {
  try { new Notification({ title: 'Parallax', body, silent: true }).show(); } catch {}
}

// ---- views ----
let win;
let sidebar;
let active = 0;
const views = new Map();       // id -> { view, lastUsed }
const localIds = new Set();    // webContents ids of our own tool pages (allowed to use IPC)

function bounds() {
  const [w, h] = win.getContentSize();
  return { x: SIDEBAR, y: 0, width: w - SIDEBAR, height: h };
}

function layout() {
  if (!win) return;
  for (const { view } of views.values()) view.setBounds(bounds());
}

function notify() {
  if (sidebar) sidebar.send('state', { active, loaded: [...views.keys()] });
}

// YouTube refuses embeds that arrive with no referrer (error 153), and a local
// page has none. Give the embed request one.
function setupVideoSession(ses) {
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*', 'https://player.vimeo.com/*'] },
    (details, cb) => {
      const headers = details.requestHeaders;
      if (details.resourceType === 'subFrame') headers['Referer'] = 'https://parallax.local/';
      cb({ requestHeaders: headers });
    }
  );
}

function createView(id) {
  const slot = SLOT_BY_ID.get(id);
  const isTool = slot.kind === 'tool';

  const view = new WebContentsView({
    webPreferences: isTool
      ? { partition: slot.partition, preload: path.join(__dirname, 'local-preload.js'), sandbox: true, contextIsolation: true }
      : { partition: slot.partition }, // own saved login per slot
  });
  view.setBackgroundColor(bg()); // no white flash while loading
  const wc = view.webContents;

  if (isTool) {
    localIds.add(wc.id);
    if (slot.key === 'video') {
      wc.session.setUserAgent(UA);
      setupVideoSession(wc.session);
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.loadFile(slot.file);
  } else {
    wc.session.setUserAgent(UA); // also covers popups and service workers
    wc.setUserAgent(UA);
    wc.setWindowOpenHandler(({ url }) => {
      let host = '';
      try { host = new URL(url).hostname; } catch {}
      if (INAPP_HOSTS.some((d) => hostMatches(host, d))) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.loadURL(slot.home); // always a fresh chat
  }

  view.setVisible(false);
  win.contentView.addChildView(view);
  view.setBounds(bounds());

  const entry = { view, lastUsed: Date.now() };
  views.set(id, entry);
  return entry;
}

function unload(id) {
  const entry = views.get(id);
  if (!entry) return;
  win.contentView.removeChildView(entry.view);
  localIds.delete(entry.view.webContents.id);
  entry.view.webContents.close();
  views.delete(id);
}

const loadedChats = () => [...views.keys()].filter((id) => SLOT_BY_ID.get(id).kind === 'chat');

// Only chat accounts count toward the limit. The 3 tool pages are always loaded.
// An evicted account is fully closed; clicking it later opens a fresh chat.
function evict(keep) {
  while (loadedChats().length > MAX_LOADED) {
    const candidates = loadedChats().filter((id) => id !== keep);
    if (!candidates.length) break;
    const oldest = candidates.reduce((a, b) => (views.get(a).lastUsed <= views.get(b).lastUsed ? a : b));
    unload(oldest);
  }
}

function switchTo(id) {
  if (!SLOT_BY_ID.has(id)) return;

  // stamp the slot we're leaving, so "last used" means when you stopped using it
  if (views.has(active)) views.get(active).lastUsed = Date.now();

  const entry = views.get(id) || createView(id);
  entry.lastUsed = Date.now();
  evict(id);

  // views stay alive and just hide/show, so chats are never reset
  for (const [vid, v] of views) v.view.setVisible(vid === id);
  active = id;
  entry.view.webContents.focus();
  notify();
}

// Cmd+N: fresh chat in the active account (same as the desktop app)
function newChat() {
  const slot = SLOT_BY_ID.get(active);
  const v = views.get(active);
  if (!slot || !v) return;
  if (slot.kind === 'chat') v.view.webContents.loadURL(slot.fresh);
  else if (slot.key === 'video') v.view.webContents.send('new');
}

// ---- progress notes + handoff ----
function readNotes() {
  try { return fs.readFileSync(NOTES_FILE(), 'utf8'); } catch { return ''; }
}

function writeNotes(text, backup) {
  const file = NOTES_FILE();
  if (backup) {
    try {
      const prev = fs.readFileSync(file, 'utf8');
      if (prev.trim()) fs.writeFileSync(path.join(path.dirname(file), 'progress.prev.md'), prev);
    } catch {}
  }
  fs.writeFileSync(file, String(text));
}

function newestProgressDownload() {
  try {
    const dir = app.getPath('downloads');
    let best = null;
    for (const f of fs.readdirSync(dir)) {
      if (!/^progress.*\.md$/i.test(f)) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
    return best ? fs.readFileSync(best.p, 'utf8') : null;
  } catch { return null; }
}

function wrapHandoff(notes) {
  return [
    'Continue the task described in the progress notes below.',
    'Read them fully first. Do not redo anything marked done. Resume from the first unfinished step, keep the decisions already made, and update the progress notes after every step.',
    '',
    '--- PROGRESS NOTES ---',
    notes.trim(),
    '--- END OF NOTES ---',
    '',
    'My next instruction: ',
  ].join('\n');
}

function nextChat(id) {
  const i = CHAT_IDS.indexOf(id);
  return CHAT_IDS[(i + 1) % CHAT_IDS.length];
}

// goNext: also jump to the next account (hotkey). The pad's button only copies.
function doHandoff(goNext) {
  let text = readNotes();
  if (!text.trim()) {
    const dl = newestProgressDownload();
    if (dl) {
      text = dl;
      writeNotes(dl, false);
      views.get(NOTES)?.view.webContents.send('reload');
    }
  }
  if (!text.trim()) { toast('Progress notes are empty'); return false; }

  clipboard.writeText(wrapHandoff(text));
  if (goNext && SLOT_BY_ID.get(active).kind === 'chat') switchTo(nextChat(active));
  toast('Handoff copied. Paste it in the chat.');
  return true;
}

// ---- shelf: save a copied response ----
function saveClipboardToShelf() {
  const text = clipboard.readText();
  if (!text.trim()) { toast('Clipboard is empty'); return null; }
  const name = `response-${stamp()}.md`;
  fs.writeFileSync(path.join(SHELF, 'Generated', name), text);
  views.get(SHELF_ID)?.view.webContents.send('refresh');
  toast(`Saved to Shelf / Generated`);
  return name;
}

function importVideo(src) {
  if (!src) return null;
  const dir = path.join(SHELF, 'Videos');
  const dest = copyIn(dir, src);
  views.get(SHELF_ID)?.view.webContents.send('refresh');
  return { name: path.basename(dest), url: pathToFileURL(dest).href };
}

// ---- IPC (only our own tool pages may call these) ----
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!localIds.has(e.sender.id)) throw new Error('denied');
    return fn(e, ...args);
  });
}

handle('clip:read', () => clipboard.readText());
handle('clip:write', (_e, t) => { clipboard.writeText(String(t)); return true; });
handle('sys:open', (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch {}
});

handle('notes:load', () => readNotes());
handle('notes:save', (_e, t) => { writeNotes(t, false); return true; });
handle('notes:replace', (_e, t) => { writeNotes(t, true); return true; });
handle('notes:download', () => newestProgressDownload());
handle('notes:handoff', () => doHandoff(false));

handle('shelf:list', (_e, rel) => {
  const dir = safe(rel);
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(dir, d.name));
      out.push({ name: d.name, dir: d.isDirectory(), size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
});
handle('shelf:text', (_e, rel) => {
  const p = safe(rel);
  const st = fs.statSync(p);
  if (!st.isFile() || st.size > 1024 * 1024 || !TEXT_EXT.has(path.extname(p).toLowerCase())) return null;
  return fs.readFileSync(p, 'utf8');
});
handle('shelf:mkdir', (_e, rel, name) => {
  const clean = String(name).replace(/[\\/:*?"<>|]/g, '').trim();
  if (!clean || clean.startsWith('.')) return false;
  fs.mkdirSync(path.join(safe(rel), clean), { recursive: true });
  return true;
});
handle('shelf:trash', async (_e, rel) => {
  const p = safe(rel);
  if (p === SHELF || SUBFOLDERS.includes(path.relative(SHELF, p))) return false; // keep the base folders
  await shell.trashItem(p); // goes to the Trash, so it can be recovered
  return true;
});
handle('shelf:reveal', (_e, rel) => {
  const p = safe(rel);
  if (p === SHELF) shell.openPath(SHELF);
  else shell.showItemInFolder(p);
});
handle('shelf:import', (_e, rel, files) => {
  const dir = safe(rel);
  let n = 0;
  for (const f of files || []) {
    try { copyIn(dir, f); n++; } catch {}
  }
  return n;
});
handle('shelf:drag', (e, rel) => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 32 });
  e.sender.startDrag({ file: safe(rel), icon });
});
handle('shelf:saveClip', () => saveClipboardToShelf());

handle('video:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'ogv'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return importVideo(r.filePaths[0]);
});
handle('video:import', (_e, p) => importVideo(p));
handle('video:url', (_e, name) => pathToFileURL(safe(path.join('Videos', name))).href);

// ---- menu ----
function buildMenu() {
  const items = [];
  SLOTS.forEach((s, idx) => {
    if (idx > 0 && SLOTS[idx - 1].group !== s.group) items.push({ type: 'separator' });
    items.push({
      label: s.kind === 'chat' ? `${s.name} ${s.label}` : s.name,
      accelerator: s.accel,
      click: () => switchTo(s.id),
    });
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'Account',
        submenu: [
          ...items,
          { type: 'separator' },
          { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: newChat },
          {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            click: () => views.get(active)?.view.webContents.reload(),
          },
          { type: 'separator' },
          { label: 'Copy handoff and go to next account', accelerator: 'CmdOrCtrl+Shift+H', click: () => doHandoff(true) },
          { label: 'Save clipboard to Shelf', accelerator: 'CmdOrCtrl+Shift+S', click: saveClipboardToShelf },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: bg(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  sidebar = win.webContents;
  win.loadFile('sidebar.html');
  win.on('resize', layout);

  sidebar.once('did-finish-load', () => {
    for (const id of TOOL_IDS) createView(id); // video, notes, shelf: always loaded
    switchTo(0);
    const second = createView(1); // preload Claude 2 in the background
    second.lastUsed = 0;          // oldest, so it's the first to go if you open a third
    notify();
  });
}

ipcMain.on('switch', (_e, id) => switchTo(id));
ipcMain.handle('config', () =>
  SLOTS.map((s) => ({
    id: s.id, group: s.group, key: s.key, label: s.label || '', icon: s.icon || '', title: titleOf(s),
  }))
);

app.whenReady().then(() => {
  ensureShelf();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
