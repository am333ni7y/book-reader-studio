import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBookFromFile, startServer } from '../server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let serverInfo = null;
const pendingFiles = [];

function extractBookPaths(argv) {
  return (argv || []).filter((arg) => {
    if (!arg || arg.startsWith('-')) return false;
    const lower = arg.toLowerCase();
    return (lower.endsWith('.pdf') || lower.endsWith('.epub')) && fs.existsSync(arg);
  });
}

function resolveDesktopPaths() {
  const configPath = path.join(os.homedir(), '.ketabkhan-studio', 'desktop-config.json');
  let custom = {};
  try {
    if (fs.existsSync(configPath)) {
      custom = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    custom = {};
  }

  const dataDir = custom.dataDir || path.join(app.getPath('userData'), 'data');
  const obsidianDir = custom.obsidianDir || path.join(app.getPath('documents'), 'Ketabkhan-Notes');
  return { dataDir, obsidianDir };
}

async function importAndNotify(filePaths) {
  if (!serverInfo || !Array.isArray(filePaths) || filePaths.length === 0) return [];
  const imported = [];
  for (const fp of filePaths) {
    try {
      const book = await importBookFromFile({
        store: serverInfo.store,
        booksDir: serverInfo.store.booksDir,
        filePath: fp,
      });
      imported.push(book);
    } catch (err) {
      console.error('[Ketabkhan Desktop] Failed to import:', fp, err.message);
    }
  }
  if (imported.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ketabkhan:books-opened', imported);
  }
  return imported;
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'درباره کتاب‌خان استودیو' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'خروج' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Book (PDF / EPUB)…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const books = await pickBooksWithDialog();
            if (books.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ketabkhan:books-opened', books);
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickBooksWithDialog() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'انتخاب کتاب PDF یا EPUB',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Books (PDF, EPUB)', extensions: ['pdf', 'epub'] }],
  });
  if (result.canceled || !result.filePaths?.length) return [];
  const imported = [];
  for (const fp of result.filePaths) {
    const book = await importBookFromFile({
      store: serverInfo.store,
      booksDir: serverInfo.store.booksDir,
      filePath: fp,
    });
    imported.push(book);
  }
  return imported;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: 'Ketabkhan Studio — کتاب‌خان استودیو',
    backgroundColor: '#f6f3ec',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingFiles.push(...extractBookPaths(process.argv.slice(1)));

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (serverInfo) {
      importAndNotify([filePath]);
    } else {
      pendingFiles.push(filePath);
    }
  });

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const files = extractBookPaths(argv.slice(1));
    if (files.length > 0) importAndNotify(files);
  });

  app.whenReady().then(async () => {
    const { dataDir, obsidianDir } = resolveDesktopPaths();
    serverInfo = await startServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      obsidianDir,
    });

    buildAppMenu();

    ipcMain.handle('ketabkhan:pick-books', async () => {
      const books = await pickBooksWithDialog();
      return { books };
    });

    ipcMain.handle('ketabkhan:reveal-file', async (_event, targetPath) => {
      if (targetPath && fs.existsSync(targetPath)) {
        shell.showItemInFolder(targetPath);
        return true;
      }
      return false;
    });

    createWindow(serverInfo.port);

    if (pendingFiles.length > 0) {
      const toImport = pendingFiles.splice(0, pendingFiles.length);
      mainWindow.webContents.once('did-finish-load', () => {
        importAndNotify(toImport);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(serverInfo.port);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    try {
      serverInfo?.store?.close?.();
      serverInfo?.server?.close?.();
    } catch {}
  });
}
