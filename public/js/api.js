// Dual-Backend API Client for Ketabkhan Studio
// Automatically uses embedded HTTP server (Desktop / CLI) or pure IndexedDB + WebAssembly/DecompressionStream (Android APK)
import { clientBackend } from './client-backend.js';

let backendModePromise = null;

async function isServerAvailable() {
  if (backendModePromise) return backendModePromise;
  backendModePromise = (async () => {
    if (window.Capacitor?.isNativePlatform?.() || location.protocol === 'capacitor:' || location.protocol === 'file:') {
      return false;
    }
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(1200) });
      return res.ok;
    } catch {
      return false;
    }
  })();
  return backendModePromise;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  async isClientOnly() {
    return !(await isServerAvailable());
  },

  async listBooks() {
    return (await isServerAvailable()) ? request('/api/books') : clientBackend.listBooks();
  },

  async getBook(id) {
    return (await isServerAvailable()) ? request(`/api/books/${encodeURIComponent(id)}`) : clientBackend.getBook(id);
  },

  async getBookPdfSource(id) {
    if (await isServerAvailable()) {
      return { url: `/api/books/${encodeURIComponent(id)}/file`, rangeChunkSize: 65536 };
    }
    return clientBackend.getBookPdfSource(id);
  },

  async getEpubManifest(id) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(id)}/epub-manifest`)
      : clientBackend.getEpubManifest(id);
  },

  async getEpubChapter(id, chapterNum) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(id)}/epub-chapter/${Number(chapterNum)}`)
      : clientBackend.getEpubChapter(id, chapterNum);
  },

  async searchEpub(id, q) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(id)}/epub-search?q=${encodeURIComponent(q)}`)
      : clientBackend.searchEpub(id, q);
  },

  releaseBookResources(id) {
    clientBackend.releaseBookResources(id);
  },

  async updateBook(id, patch) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
      : clientBackend.updateBook(id, patch);
  },

  async deleteBook(id) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' })
      : clientBackend.deleteBook(id);
  },

  importFromPath: (filePath, title = '') =>
    request('/api/books/import-path', {
      method: 'POST',
      body: JSON.stringify({ filePath, title }),
    }),

  async seedSampleBook() {
    return (await isServerAvailable())
      ? request('/api/books/seed', { method: 'POST' })
      : clientBackend.seedSampleBook();
  },

  async pickDesktopBooks() {
    if (!window.ketabkhanDesktop?.isDesktop) return null;
    return window.ketabkhanDesktop.pickBooks();
  },

  async uploadBookFile(file, onProgress) {
    if (!(await isServerAvailable())) {
      return clientBackend.uploadBookFile(file, onProgress);
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/books');
      const isEpub = file.name.toLowerCase().endsWith('.epub');
      xhr.setRequestHeader('Content-Type', isEpub ? 'application/epub+zip' : 'application/pdf');
      xhr.setRequestHeader('x-book-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || `Upload failed (${xhr.status})`));
        } catch {
          reject(new Error('پاسخ نامعتبر از سرور'));
        }
      };
      xhr.onerror = () => reject(new Error('خطای شبکه هنگام ارسال فایل'));
      xhr.send(file);
    });
  },

  uploadPdfFile: (file, onProgress) => api.uploadBookFile(file, onProgress),

  async toggleRibbonBookmark(bookId, page) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
          method: 'POST',
          body: JSON.stringify({ page, kind: 'ribbon', toggle: true }),
        })
      : clientBackend.toggleRibbonBookmark(bookId, page);
  },

  async createPinBookmark(bookId, payload) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
          method: 'POST',
          body: JSON.stringify({ ...payload, kind: 'pin' }),
        })
      : clientBackend.createPinBookmark(bookId, payload);
  },

  async deleteBookmark(bookmarkId) {
    return (await isServerAvailable())
      ? request(`/api/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' })
      : clientBackend.deleteBookmark(bookmarkId);
  },

  async createHighlight(bookId, payload) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(bookId)}/highlights`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      : clientBackend.createHighlight(bookId, payload);
  },

  async updateHighlight(highlightId, patch) {
    return (await isServerAvailable())
      ? request(`/api/highlights/${encodeURIComponent(highlightId)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
      : clientBackend.updateHighlight(highlightId, patch);
  },

  async deleteHighlight(highlightId) {
    return (await isServerAvailable())
      ? request(`/api/highlights/${encodeURIComponent(highlightId)}`, { method: 'DELETE' })
      : clientBackend.deleteHighlight(highlightId);
  },

  async createTocEntry(bookId, payload) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(bookId)}/toc`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      : clientBackend.createTocEntry(bookId, payload);
  },

  async deleteTocEntry(tocId) {
    return (await isServerAvailable())
      ? request(`/api/toc/${encodeURIComponent(tocId)}`, { method: 'DELETE' })
      : clientBackend.deleteTocEntry(tocId);
  },

  async exportObsidian(bookId) {
    return (await isServerAvailable())
      ? request(`/api/books/${encodeURIComponent(bookId)}/export-obsidian`, { method: 'POST' })
      : clientBackend.exportObsidian(bookId);
  },
};
