const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const paths = (files) =>
  Array.from(files || []).map((f) => webUtils.getPathForFile(f)).filter(Boolean);

contextBridge.exposeInMainWorld('local', {
  // clipboard + links
  clipRead: () => call('clip:read'),
  clipWrite: (t) => call('clip:write', t),
  openExternal: (u) => call('sys:open', u),

  // progress notes
  notesLoad: () => call('notes:load'),
  notesSave: (t) => call('notes:save', t),
  notesReplace: (t) => call('notes:replace', t),
  notesDownload: () => call('notes:download'),
  handoff: () => call('notes:handoff'),

  // shelf
  list: (rel) => call('shelf:list', rel),
  text: (rel) => call('shelf:text', rel),
  mkdir: (rel, name) => call('shelf:mkdir', rel, name),
  trash: (rel) => call('shelf:trash', rel),
  reveal: (rel) => call('shelf:reveal', rel),
  importFiles: (rel, files) => call('shelf:import', rel, paths(files)),
  startDrag: (rel) => call('shelf:drag', rel),
  saveClip: () => call('shelf:saveClip'),

  // video
  videoPick: () => call('video:pick'),
  videoImport: (files) => call('video:import', paths(files)[0]),
  videoUrl: (name) => call('video:url', name),

  // messages from the app: 'refresh', 'reload', 'new'
  on: (channel, cb) => {
    if (['refresh', 'reload', 'new'].includes(channel)) ipcRenderer.on(channel, () => cb());
  },
});
