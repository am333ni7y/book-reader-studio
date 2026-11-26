const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ketabkhanDesktop', {
  isDesktop: true,
  platform: process.platform,
  pickBooks: () => ipcRenderer.invoke('ketabkhan:pick-books'),
  revealFile: (filePath) => ipcRenderer.invoke('ketabkhan:reveal-file', filePath),
  onBooksOpened: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, books) => callback(books);
    ipcRenderer.on('ketabkhan:books-opened', listener);
    return () => ipcRenderer.removeListener('ketabkhan:books-opened', listener);
  },
});
