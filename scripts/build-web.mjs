import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_WEB = path.join(ROOT, 'dist-web');
const PDFJS_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const VAZIR_DIR = path.join(ROOT, 'node_modules', 'vazirmatn');

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

fs.rmSync(DIST_WEB, { recursive: true, force: true });
copyDirRecursive(PUBLIC_DIR, DIST_WEB);

// Bundle Vazirmatn CSS & webfonts
const vazirOut = path.join(DIST_WEB, 'vendor', 'vazirmatn');
fs.mkdirSync(vazirOut, { recursive: true });
fs.copyFileSync(path.join(VAZIR_DIR, 'Vazirmatn-font-face.css'), path.join(vazirOut, 'Vazirmatn-font-face.css'));
copyDirRecursive(path.join(VAZIR_DIR, 'fonts', 'webfonts'), path.join(vazirOut, 'fonts', 'webfonts'));

// Bundle PDF.js minified runtime + cmaps/fonts/wasm/iccs
const pdfjsOut = path.join(DIST_WEB, 'vendor', 'pdfjs');
const pdfBuildOut = path.join(pdfjsOut, 'legacy', 'build');
fs.mkdirSync(pdfBuildOut, { recursive: true });
fs.copyFileSync(path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.min.mjs'), path.join(pdfBuildOut, 'pdf.mjs'));
fs.copyFileSync(path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(pdfBuildOut, 'pdf.worker.mjs'));

for (const sub of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const srcSub = path.join(PDFJS_DIR, sub);
  if (fs.existsSync(srcSub)) {
    copyDirRecursive(srcSub, path.join(pdfjsOut, sub));
  }
}

console.log(`Built static web bundle at ${DIST_WEB}`);
