# Decision Record: Local Node.js 24 + Native SQLite Architecture

- **Decision ID**: `ADR-20261125-01`
- **Status**: Accepted
- **Date**: 2026-11-25
- **Author(s)**: Ameeen / Antigravity
- **Supersedes / Superseded By**: N/A

---

## 1. Problem & Context
The user requested a local PDF book reading service with a refined UI, highlighting, bookmarking, named page pins, an accessible Table of Contents, and high readability — running locally on macOS without heavy container setup.

---

## 2. Alternatives Considered

### Option A: Self-host `mrmn2/PdfDing` (Python/Django)
- **Pros / Advantages**: Existing open-source PDF manager with highlights and reading position memory.
- **Cons / Disadvantages**: Requires Python virtualenv, Django migrations, admin user creation, and lacks RTL Persian book-spread ergonomics, dual-mode area highlighting for scanned Persian PDFs, custom TOC builder, and native Obsidian Vault export.
- **Rejection Reason**: Less tailored to Persian RTL book reading and requires Django runtime overhead.
- **Empirical Status**: Literature / Documentation benchmark (Docker is also not installed on this macOS host).

### Option B: Self-host `readest/readest` (Next.js / Tauri)
- **Pros / Advantages**: Modern EPUB/PDF reader UI.
- **Cons / Disadvantages**: Primarily optimized for EPUB; self-hosted sync requires Supabase/PostgREST/object storage stack.
- **Rejection Reason**: Heavy multi-service setup for a single-user local PDF book workflow.
- **Empirical Status**: Literature / Documentation benchmark.

---

## 3. Selected Approach: Custom Local Node.js 24 + `node:sqlite` + `pdfjs-dist` v6 Studio

### 3.1 Why this approach was selected
Node `v24.18.0` is already installed on the host and provides built-in `node:sqlite` (`DatabaseSync`) with zero native C++ compilation (`node-gyp`) required. Combined with `pdfjs-dist@6.5.438` and `vazirmatn@33.0.3`, the entire application runs in a single process on `127.0.0.1:3847` with HTTP `206 Partial Content` Range streaming for large PDFs.

### 3.2 Evidence & Justification
- **Observed Facts**:
  - `node -v` -> `v24.18.0`, `typeof DatabaseSync === 'function'` verified locally.
  - `docker --version` -> `no docker` on host.
- **Interpretations**: A zero-Docker, zero-native-addon Node.js server starts in <100ms and persists annotations reliably in WAL-mode SQLite.
- **Assumptions**: Single-user local workstation usage (`127.0.0.1`).

---

## 4. Trade-Offs Accepted
- **What did we gain?**: Instant startup, zero external dependencies, Persian RTL + English LTR spread support, custom TOC for scanned PDFs, and direct Obsidian export.
- **What did we give up?**: Multi-user authentication and cloud sync across remote devices.
- **Why this trade-off is acceptable**: The user explicitly requested a local service (`سرویس محلی`).

---

## 5. Consequences & Dependencies
- **Reconsideration Trigger**: If multi-device remote sync or multi-user accounts are needed later, add authentication and sync endpoints on top of the SQLite schema.
