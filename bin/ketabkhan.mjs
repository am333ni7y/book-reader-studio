#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  PROJECT_ROOT,
  loadDotEnv,
  resolveDataDir,
  resolveObsidianDir,
  isTermux,
} from '../lib/paths.mjs';
import { openDatabase, importBookFromFile, startServer } from '../server.mjs';

loadDotEnv();

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

function printHelp() {
  console.log(`
Ketabkhan Studio v${pkg.version} — Local PDF & EPUB Book Reader

Usage:
  ketabkhan [start] [options]      Start the local reader server
  ketabkhan add <file> [options]   Add a .pdf or .epub book to the library
  ketabkhan seed [--data-dir dir]  Seed sample PDF & bilingual EPUB books
  ketabkhan doctor                 Check Node.js, SQLite, OS, and paths
  ketabkhan --help | --version     Show help or version

Options:
  --port <num>         Port to listen on (default: 3847)
  --host <addr>        Host address (default: 127.0.0.1)
  --lan                Bind 0.0.0.0 and print LAN URLs for Android/mobile
  --open               Open the reader in your default browser
  --data-dir <path>    Override SQLite & books storage directory
  --notes-dir <path>   Override Obsidian Markdown export directory
  --title <text>       Custom book title (for "add")
`);
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      args.push(token);
      continue;
    }
    if (token === '--lan' || token === '--open' || token === '--help' || token === '-h' || token === '--version' || token === '-v') {
      flags[token.replace(/^-+/, '')] = true;
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (i + 1 < argv.length) {
      flags[token.replace(/^-+/, '')] = argv[++i];
    }
  }
  return { args, flags };
}

function openBrowser(url) {
  if (isTermux()) {
    execFile('termux-open-url', [url], () => {});
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  execFile('xdg-open', [url], () => {});
}

async function runDoctor(flags) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  let sqliteOk = false;
  try {
    const mod = await import('node:sqlite');
    sqliteOk = typeof mod.DatabaseSync === 'function';
  } catch {}

  const dataDir = resolveDataDir(flags['data-dir']);
  const obsidianDir = resolveObsidianDir(flags['notes-dir']);

  console.log(`Ketabkhan Studio v${pkg.version}`);
  console.log(`Platform      : ${process.platform} (${process.arch})${isTermux() ? ' [Android Termux]' : ''}`);
  console.log(`Node.js       : ${process.version} ${nodeOk ? 'OK' : '(Requires >= 22.5.0)'}`);
  console.log(`node:sqlite   : ${sqliteOk ? 'OK' : 'MISSING'}`);
  console.log(`Project Root  : ${PROJECT_ROOT}`);
  console.log(`Data Dir      : ${dataDir}`);
  console.log(`Obsidian Dir  : ${obsidianDir}`);

  if (!nodeOk || !sqliteOk) {
    process.exitCode = 1;
  }
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printHelp();
    return;
  }
  if (flags.version || flags.v) {
    console.log(pkg.version);
    return;
  }

  const cmd = args[0] || 'start';

  if (cmd === 'doctor') {
    await runDoctor(flags);
    return;
  }

  if (cmd === 'seed') {
    const dataDir = resolveDataDir(flags['data-dir']);
    process.env.KETABKHAN_DATA_DIR = dataDir;
    await import('../scripts/generate-sample-book.mjs');
    return;
  }

  if (cmd === 'add') {
    const targetFile = args[1];
    if (!targetFile) {
      console.error('Error: Please provide a .pdf or .epub file path.\nUsage: ketabkhan add <file> [--title "Book Title"]');
      process.exit(1);
    }
    const { db, booksDir } = await openDatabase(resolveDataDir(flags['data-dir']));
    try {
      const book = await importBookFromFile({
        db,
        booksDir,
        filePath: targetFile,
        title: flags.title || '',
      });
      console.log(`Added [${book.format.toUpperCase()}]: ${book.title} (${book.id})`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === 'start' || !args[0]) {
    const port = Number(flags.port || process.env.PORT || 3847);
    const host = flags.lan ? '0.0.0.0' : String(flags.host || process.env.HOST || '127.0.0.1');
    const dataDir = resolveDataDir(flags['data-dir']);
    const obsidianDir = resolveObsidianDir(flags['notes-dir']);

    await startServer({
      host,
      port,
      dataDir,
      obsidianDir,
      onReady: () => {
        if (flags.open) {
          openBrowser(`http://127.0.0.1:${port}`);
        }
      },
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
