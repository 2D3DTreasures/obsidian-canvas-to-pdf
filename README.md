# Canvas to PDF

Export your Obsidian canvases into clean, searchable vector PDF and HTML documents directly on your computer.

Convert canvas notes, connections, arrows, embedded images, web previews, and nested canvases into high-quality PDFs or standalone HTML files where text stays sharp, selectable, and copy-pasteable at any zoom level.

---

## Key features

* **Searchable text**: Text in your exported PDFs remains selectable, copy-pasteable, and searchable in any PDF viewer.
* **Dual PDF & HTML export**: Choose to export as a vector PDF document, a standalone HTML file, or both simultaneously.
* **Canvas connections & arrows**: Keeps all connector lines, directional arrows, custom colors, and text labels exactly where they belong.
* **Nested canvases**: Automatically renders sub-canvases embedded inside your main canvas (up to 5 levels deep).
* **Embedded media**: Supports Markdown note cards, images, web link cards, YouTube video thumbnails, and embedded PDFs.
* **100% local & private**: Everything runs locally on your computer with zero account creation, zero tracking, and zero cloud server dependencies.

---

## System requirements

* **Obsidian**: Version `v1.4.0` or newer.
* **Desktop operating system**: Windows, macOS, or Linux.
* **Local browser**: Google Chrome or Microsoft Edge installed on your computer.

---

## Installation

### Option 1: Community plugin store (Recommended)
1. Open **Settings → Community plugins**.
2. Select **Browse** and search for `Canvas to PDF`.
3. Select **Install**, then enable the plugin.

### Option 2: Manual installation
1. Download `manifest.json`, `main.js`, and `styles.css` from the latest [GitHub Release](https://github.com/2D3DTreasures/obsidian-canvas-to-pdf/releases).
2. Create a folder named `canvas-to-pdf` inside your vault's `.obsidian/plugins/` folder.
3. Move the three downloaded files into `.obsidian/plugins/canvas-to-pdf/`.
4. Reload Obsidian and enable **Canvas to PDF** in settings.

---

## Usage guide

1. Open any `.canvas` file in Obsidian.
2. Trigger the export command using one of three methods:
   - Select the **Export canvas to PDF** icon in the canvas view toolbar.
   - Open the Command Palette (`Ctrl+P` on Windows or `Command+P` on macOS) and select `Canvas to PDF: Export canvas`.
   - Right-click the active canvas tab and select `Export canvas to PDF`.
3. Choose your settings in the export window (PDF file type, auto-open, high-res web link previews) and select **Export**.

---

## Customization & plugin settings

You can customize your export preferences in **Settings → Canvas to PDF**:

* **Default export path**: Set a default vault folder (e.g. `Exports/`) or absolute system folder.
* **Nested canvas export**: Turn sub-canvas rendering on/off and set the depth limit slider (1 to 5 levels).
* **Browser executable path**: Specify a custom path to Chrome or Edge if installed in a non-standard location.
* **Show file node labels**: Toggle title headings displayed above embedded files and images.

---

## Technical details (for developers & power users)

<details>
<summary><b>Click to expand architecture & technical specifications</b></summary>

<br>

* **Rendering engine**: Utilizes a local Chromium instance via Chrome DevTools Protocol (`Page.printToPDF`) to render true vector typography instead of pixelated canvas screenshots.
* **Spatial layout calculator**: Automatically computes canvas node bounds, relative offsets, and SVG path bezier curves to reconstruct complex spatial layouts onto a unified document.
* **Local processing**: Communication with the browser engine occurs strictly via local loopback (`127.0.0.1`).
* **Headless browser flags**: Spawns Chrome with `--no-first-run --no-default-browser-check --disable-extensions` to prevent background telemetry.

</details>

---

## Known behaviors & edge cases

* **Multi-page embedded PDFs**: Obsidian virtualizes PDF cards when zoomed out to save GPU memory. For multi-page PDF nodes, zoom in on the canvas once before exporting so Obsidian loads all pages into memory.
* **Ultra-wide canvas viewing**: When exporting extremely large layouts exceeding 200 inches, Adobe Acrobat Reader enforces single-page size limits. Open ultra-wide PDFs in Google Chrome or Microsoft Edge for smooth scaling.

---

## Privacy & security

This plugin does not collect, store, or transmit any telemetry or user data. All processing happens locally on your machine. When a canvas contains web link cards or web embeds, your local browser loads those specific web pages directly from their origin servers over HTTPS.

---

## License

Distributed under the [GNU General Public License v3.0 (GPLv3)](LICENSE).