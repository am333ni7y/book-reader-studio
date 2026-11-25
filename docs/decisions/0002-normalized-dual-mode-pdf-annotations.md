# Decision Record: Normalized Dual-Mode PDF Annotations

- **Decision ID**: `ADR-20261125-02`
- **Status**: Accepted
- **Date**: 2026-11-25
- **Author(s)**: Ameeen / Antigravity
- **Supersedes / Superseded By**: N/A

---

## 1. Problem & Context
Persian PDF books fall into two categories: modern digital PDFs with embedded text layers, and scanned image-based PDFs without selectable text. Furthermore, mutating the binary PDF file on every highlight risks corrupting large files or breaking undo/filtering.

---

## 2. Alternatives Considered

### Option A: Mutate PDF bytes in-place (e.g., via `pdf-lib`)
- **Pros / Advantages**: Annotations embedded inside the PDF file.
- **Cons / Disadvantages**: Slow on 300MB+ books, cannot easily filter/search/export highlights, and requires re-downloading/re-parsing the PDF on each edit.
- **Rejection Reason**: Poor UX latency and fragility on large Persian PDFs.
- **Empirical Status**: Architectural analysis.

---

## 3. Selected Approach: SQLite-Stored Normalized `0..1` Rectangles (Text + Area Modes)

### 3.1 Why this approach was selected
Storing highlight rectangles as normalized `[0..1]` coordinates (`x, y, w, h`) relative to the rendered page shell allows overlays to scale cleanly across `Fit Width`, `Fit Page`, `50%–250%` zoom, and `Two-Page Spread` views. Providing both `Text Selection` highlighting and `Area Drag` highlighting ensures scanned Persian PDFs are first-class citizens.

### 3.2 Evidence & Justification
- **Observed Facts**: `pdfjs-dist@6.5.438` `TextLayer` exposes DOM `Range.getClientRects()`, and CSS `filter` on `.pdf-page-canvas` (isolated from `.pdf-annotation-layer`) preserves highlight color fidelity in `Smart Dark` mode.
- **Assumptions**: Highlighted PDFs are not externally re-cropped after import.

---

## 4. Trade-Offs Accepted
- **What did we gain?**: Instantaneous highlight CRUD, color filtering, full-text note search, scanned-PDF support, and 1-click Obsidian Markdown export.
- **What did we give up?**: Highlights are stored in `data/library.sqlite` rather than inside the raw `.pdf` binary.
- **Reconsideration Trigger**: If exporting annotated `.pdf` binaries for external viewers is requested later, add an optional `pdf-lib` export endpoint.
