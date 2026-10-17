const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');

const MAX_LOADED = 2;   // only this many accounts stay alive in RAM
const SIDEBAR = 72;

// ---- slots (ids are fixed, so saved logins never move) ----
// Claude 1-9 | ChatGPT, DeepSeek
const SLOTS = [
  ...Array.from({ length: 9 }, (_, k) => ({
    id: k, group: 'claude', key: 'claude', name: 'Claude', label: String(k + 1),
    home: 'https://claude.ai', fresh: 'https://claude.ai/new',
    accel: `CmdOrCtrl+${k + 1}`, partition: `persist:acc${k}`,
  })),
  {
    id: 9, group: 'ai', key: 'chatgpt', name: 'ChatGPT', label: '1',
    home: 'https://chatgpt.com', fresh: 'https://chatgpt.com/',
    accel: 'CmdOrCtrl+Shift+1', partition: 'persist:acc9',
  },
  {
    id: 11, group: 'ai', key: 'deepseek', name: 'DeepSeek', label: '2',
    home: 'https://chat.deepseek.com', fresh: 'https://chat.deepseek.com/',
    accel: 'CmdOrCtrl+Shift+2', partition: 'persist:acc11', // keeps the old DeepSeek login
  },
];
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));

const hint = (s) => s.accel.replace('CmdOrCtrl', 'Cmd');
const titleOf = (s) => `${s.name} ${s.label}  (${hint(s)})`;

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

// ---- views ----
let win;
let sidebar;
let active = 0;
const views = new Map(); // id -> { view, lastUsed }

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

function createView(id) {
  const slot = SLOT_BY_ID.get(id);

  const view = new WebContentsView({
    webPreferences: { partition: slot.partition }, // own saved login per slot
  });
  view.setBackgroundColor(bg()); // no white flash while loading
  const wc = view.webContents;
  wc.session.setUserAgent(UA); // also covers popups and service workers
  wc.setUserAgent(UA);

  wc.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (INAPP_HOSTS.some((d) => hostMatches(host, d))) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  view.setVisible(false);
  win.contentView.addChildView(view);
  view.setBounds(bounds());
  wc.loadURL(slot.home); // always a fresh chat

  const entry = { view, lastUsed: Date.now() };
  views.set(id, entry);
  return entry;
}

function unload(id) {
  const entry = views.get(id);
  if (!entry) return;
  win.contentView.removeChildView(entry.view);
  entry.view.webContents.close();
  views.delete(id);
}

// Drop the least recently used account(s) once over the limit.
// An evicted account is fully closed; clicking it later opens a fresh chat.
function evict(keep) {
  while (views.size > MAX_LOADED) {
    let oldest = null;
    for (const [id, v] of views) {
      if (id === keep) continue;
      if (oldest === null || v.lastUsed < views.get(oldest).lastUsed) oldest = id;
    }
    if (oldest === null) break;
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
  if (slot && v) v.view.webContents.loadURL(slot.fresh);
}

function buildMenu() {
  const items = [];
  SLOTS.forEach((s, idx) => {
    if (idx > 0 && SLOTS[idx - 1].group !== s.group) items.push({ type: 'separator' });
    items.push({
      label: `${s.name} ${s.label}`,
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
    switchTo(0);
    const second = createView(1); // preload Claude 2 in the background
    second.lastUsed = 0;          // oldest, so it's the first to go if you open a third
    notify();
  });
}

ipcMain.on('switch', (_e, id) => switchTo(id));
ipcMain.handle('config', () =>
  SLOTS.map((s) => ({ id: s.id, group: s.group, key: s.key, label: s.label, title: titleOf(s) }))
);

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
