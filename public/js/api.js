// Typed REST API client for Ketabkhan Studio

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
  listBooks: () => request('/api/books'),

  getBook: (id) => request(`/api/books/${encodeURIComponent(id)}`),

  getEpubManifest: (id) => request(`/api/books/${encodeURIComponent(id)}/epub-manifest`),

  getEpubChapter: (id, chapterNum) =>
    request(`/api/books/${encodeURIComponent(id)}/epub-chapter/${Number(chapterNum)}`),

  searchEpub: (id, q) =>
    request(`/api/books/${encodeURIComponent(id)}/epub-search?q=${encodeURIComponent(q)}`),

  updateBook: (id, patch) =>
    request(`/api/books/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteBook: (id) =>
    request(`/api/books/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  importFromPath: (filePath, title = '') =>
    request('/api/books/import-path', {
      method: 'POST',
      body: JSON.stringify({ filePath, title }),
    }),

  uploadBookFile: (file, onProgress) =>
    new Promise((resolve, reject) => {
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
    }),

  uploadPdfFile: (file, onProgress) => api.uploadBookFile(file, onProgress),

  toggleRibbonBookmark: (bookId, page) =>
    request(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify({ page, kind: 'ribbon', toggle: true }),
    }),

  createPinBookmark: (bookId, payload) =>
    request(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, kind: 'pin' }),
    }),

  deleteBookmark: (bookmarkId) =>
    request(`/api/bookmarks/${encodeURIComponent(bookmarkId)}`, {
      method: 'DELETE',
    }),

  createHighlight: (bookId, payload) =>
    request(`/api/books/${encodeURIComponent(bookId)}/highlights`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateHighlight: (highlightId, patch) =>
    request(`/api/highlights/${encodeURIComponent(highlightId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteHighlight: (highlightId) =>
    request(`/api/highlights/${encodeURIComponent(highlightId)}`, {
      method: 'DELETE',
    }),

  createTocEntry: (bookId, payload) =>
    request(`/api/books/${encodeURIComponent(bookId)}/toc`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteTocEntry: (tocId) =>
    request(`/api/toc/${encodeURIComponent(tocId)}`, {
      method: 'DELETE',
    }),

  exportObsidian: (bookId) =>
    request(`/api/books/${encodeURIComponent(bookId)}/export-obsidian`, {
      method: 'POST',
    }),
};
