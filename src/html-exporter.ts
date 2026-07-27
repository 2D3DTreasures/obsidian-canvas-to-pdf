const bufferToBase64 = (buf: ArrayBuffer) => Buffer.from(buf).toString('base64');
import { App, TFile, Notice, MarkdownRenderer, Component, requestUrl } from 'obsidian';
import { CanvasData, CanvasNode, GroupNode, TextNode, FileNode, LinkNode, CanvasEdge, BoundingBox } from './types';

async function renderPdfFileToDataUrl(app: App, tfile: TFile, subpath?: string): Promise<string | null> {
    try {
        const arrayBuffer = await app.vault.readBinary(tfile);
        const pdfjsLib = (window as any).pdfjsLib || (window as any).pdfjs;
        if (pdfjsLib && pdfjsLib.getDocument) {
            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            const pdfDoc = await loadingTask.promise;
            if (pdfDoc && pdfDoc.numPages > 0) {
                let targetPageNum = 1;
                if (subpath) {
                    const match = subpath.match(/#page=(\d+)/i);
                    if (match && match[1]) {
                        targetPageNum = Math.min(pdfDoc.numPages, Math.max(1, parseInt(match[1], 10)));
                    }
                }
                const page = await pdfDoc.getPage(targetPageNum);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    await page.render({ canvasContext: ctx, viewport }).promise;
                    return canvas.toDataURL('image/jpeg', 0.9);
                }
            }
        }
    } catch (e) {
        console.error('Headless PDF rendering fallback error:', e);
    }
    return null;
}

async function captureGhostWebview(url: string, width: number, height: number, partition: string | null): Promise<string | null> {
    // If the card is narrow, force it to render at a desktop-class width (1440px minimum)
    let renderWidth = width;
    let renderHeight = height;
    if (renderWidth < 1440) {
        const scale = 1440 / renderWidth;
        renderWidth = 1440;
        renderHeight = Math.round(height * scale);
    }

    return new Promise((resolve) => {
        const webview = document.createElement('webview');
        webview.setAttribute('src', url);
        webview.setAttribute('webpreferences', 'zoomFactor=1.0');
        if (partition) webview.setAttribute('partition', partition);

        // We use a fixed chunk height to ensure Chromium paints the webview content
        const CHUNK_HEIGHT = 1000;
        webview.setAttribute('style', `width: ${renderWidth}px !important; height: ${CHUNK_HEIGHT}px !important; min-width: ${renderWidth}px !important; min-height: ${CHUNK_HEIGHT}px !important; max-width: none !important; max-height: none !important; position: absolute !important; left: 0 !important; top: 0 !important; z-index: -9999 !important; opacity: 0.01 !important; pointer-events: none !important; transform: none !important;`);

        let resolved = false;
        const cleanup = () => {
            if (webview.parentNode) webview.parentNode.removeChild(webview);
        };

        // Increase timeout since stitching takes a bit longer
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(null);
            }
        }, 30000); // 30 second timeout per webview

        webview.addEventListener('dom-ready', async () => {
            if (resolved) return;

            // Wait an extra 2000ms for initial painting and JS to execute
            setTimeout(async () => {
                if (resolved) return;
                try {
                    if (typeof (webview as any).capturePage !== 'function') {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        resolve(null);
                        return;
                    }

                    // Inject CSS/JS to hide scrollbars and fix sticky headers so they don't repeat in the stitch
                    await (webview as any).executeJavaScript(`
                        (function() {
                            const style = document.createElement('style');
                            style.innerHTML = '::-webkit-scrollbar { display: none !important; }';
                            document.head.appendChild(style);
                            
                            const elems = document.querySelectorAll('*');
                            for (let i=0; i<elems.length; i++) {
                                const comp = window.getComputedStyle(elems[i]);
                                if (comp.position === 'fixed' || comp.position === 'sticky') {
                                    elems[i].style.setProperty('position', 'absolute', 'important');
                                }
                            }
                        })();
                    `);

                    // Create offscreen canvas to stitch chunks
                    const canvas = document.createElement('canvas');
                    canvas.width = renderWidth;
                    canvas.height = renderHeight;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error("No 2d context");

                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, renderWidth, renderHeight);

                    let currentY = 0;
                    let previousY = -1;

                    while (currentY < renderHeight) {
                        if (resolved) return;

                        // Scroll to current chunk
                        await (webview as any).executeJavaScript(`window.scrollTo(0, ${currentY});`);

                        // Give it 300ms to repaint and load lazy images
                        await new Promise(r => setTimeout(r, 300));

                        const actualY = await (webview as any).executeJavaScript('window.scrollY');

                        // If we can't scroll any further down (we reached the bottom of the page)
                        if (actualY === previousY && currentY > 0) {
                            break;
                        }
                        previousY = actualY;

                        // Capture the CHUNK_HEIGHT chunk
                        const imgNative = await (webview as any).capturePage({ x: 0, y: 0, width: renderWidth, height: CHUNK_HEIGHT });
                        const dataUrl = imgNative.toDataURL();

                        // Draw chunk onto canvas
                        await new Promise((r) => {
                            const img = new Image();
                            img.onload = () => {
                                ctx.drawImage(img, 0, actualY, renderWidth, CHUNK_HEIGHT);
                                r(null);
                            };
                            img.onerror = () => r(null);
                            img.src = dataUrl;
                        });

                        currentY += CHUNK_HEIGHT;
                    }

                    const finalDataUrl = canvas.toDataURL('image/jpeg', 0.85);

                    resolved = true;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(finalDataUrl);
                } catch (e) {
                    resolved = true;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(null);
                }
            }, 2000);
        });

        document.body.appendChild(webview);
    });
}
function getObsidianStyles(): string {
    let styles = '';
    for (let i = 0; i < document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        try {
            for (let j = 0; j < sheet.cssRules.length; j++) {
                styles += sheet.cssRules[j].cssText + '\n';
            }
        } catch (e) {
            // Some stylesheets might be cross-origin or restricted
        }
    }
    // Remove @media print rules that override our custom canvas dimensions during PDF generation
    styles = styles.replace(/@media print\s*{[^}]+}/g, '');
    return styles;
}

async function getFileExportUrl(app: App, linkedFile: TFile, settings: any): Promise<string> {
    if (settings && settings.exportTarget === 'pdf') {
        const basePath = (app.vault.adapter as any).getBasePath();
        if (basePath) {
            const absolutePath = require('path').join(basePath, linkedFile.path);
            return 'file:///' + absolutePath.split('\\').join('/').split('/').map(encodeURIComponent).join('/');
        }
    }
    const bytes = await app.vault.readBinary(linkedFile);
    const base64 = bufferToBase64(bytes);
    const ext = linkedFile.extension.toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
    return `data:${mime};base64,${base64}`;
}

async function processMarkdownImages(app: App, wrapper: HTMLElement, sourcePath: string, settings?: any) {
    const imgs = Array.from(wrapper.querySelectorAll('img'));
    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        const src = img.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.startsWith('http')) {
            const filename = decodeURIComponent(src.split('/').pop()?.split('?')[0] || '');
            const linkedFile = app.metadataCache.getFirstLinkpathDest(filename, sourcePath);
            if (linkedFile instanceof TFile) {
                img.src = await getFileExportUrl(app, linkedFile, settings);
            }
        }
    }

    const embeds = Array.from(wrapper.querySelectorAll('.internal-embed'));
    for (let i = 0; i < embeds.length; i++) {
        const embed = embeds[i];
        const src = embed.getAttribute('src');
        if (src) {
            const linkedFile = app.metadataCache.getFirstLinkpathDest(src, sourcePath);
            if (linkedFile instanceof TFile) {
                const ext = linkedFile.extension.toLowerCase();
                if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
                    const img = document.createElement('img');
                    img.src = await getFileExportUrl(app, linkedFile, settings);
                    img.style.maxWidth = '100%';
                    img.style.objectFit = 'contain';
                    embed.replaceWith(img);
                } else if (ext === 'base') {
                    // Bases require Obsidian's live view system; render a visible placeholder
                    const placeholder = document.createElement('div');
                    placeholder.style.cssText = 'padding: 12px; border: 1px dashed var(--text-faint); border-radius: 8px; color: var(--text-muted); font-style: italic; text-align: center; margin: 8px 0;';
                    placeholder.textContent = `📊 Base: ${linkedFile.basename} (cannot be exported statically)`;
                    embed.replaceWith(placeholder);
                }
            }
        }
    }
}

async function processMarkdownIframes(app: App, wrapper: HTMLElement) {
    const iframes = Array.from(wrapper.querySelectorAll('iframe'));
    for (let i = 0; i < iframes.length; i++) {
        const iframe = iframes[i];
        const src = iframe.getAttribute('src');
        if (src) {
            const ytMatch = src.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([^"&?\/\s]{11})/i);
            if (ytMatch && ytMatch[1]) {
                const videoId = ytMatch[1];
                let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
                try {
                    let res;
                    try {
                        res = await requestUrl({ url: thumbnailUrl });
                    } catch (e) {
                        thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                        res = await requestUrl({ url: thumbnailUrl });
                    }
                    const base64 = bufferToBase64(res.arrayBuffer);
                    const dataUrl = `data:image/jpeg;base64,${base64}`;

                    const parent = iframe.parentNode;
                    if (parent) {
                        const replaceDiv = document.createElement('div');
                        replaceDiv.style.position = 'relative';
                        replaceDiv.style.width = iframe.getAttribute('width') ? (iframe.getAttribute('width')?.includes('%') ? iframe.getAttribute('width')! : iframe.getAttribute('width') + 'px') : '100%';
                        replaceDiv.style.height = iframe.getAttribute('height') ? (iframe.getAttribute('height')?.includes('%') ? iframe.getAttribute('height')! : iframe.getAttribute('height') + 'px') : '100%';
                        replaceDiv.style.backgroundColor = '#000';
                        replaceDiv.style.display = 'flex';
                        replaceDiv.style.alignItems = 'center';
                        replaceDiv.style.justifyContent = 'center';
                        replaceDiv.style.overflow = 'hidden';
                        replaceDiv.style.borderRadius = '8px';

                        replaceDiv.innerHTML = `
                            <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" style="display: block; width: 100%; height: 100%; text-decoration: none;">
                                <img src="${dataUrl}" style="width: 100%; height: 100%; object-fit: contain; border: none; display: block; opacity: 0.85;" />
                                <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">
                                    <svg width="68" height="48" viewBox="0 0 68 48" version="1.1" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M66.52,7.74c-0.78-2.93-2.49-5.41-5.42-6.19C55.79,.13,34,0,34,0S12.21,.13,6.9,1.55 C3.97,2.33,2.27,4.81,1.48,7.74C0.06,13.05,0,24,0,24s0.06,10.95,1.48,16.26c0.78,2.93,2.49,5.41,5.42,6.19 C12.21,47.87,34,48,34,48s21.79-0.13,27.1-1.55c2.93-0.78,4.64-3.26,5.42-6.19C67.94,34.95,68,24,68,24S67.94,13.05,66.52,7.74z" fill="#ff0000"></path>
                                        <path d="M 45,24 27,14 27,34" fill="#ffffff"></path>
                                    </svg>
                                </div>
                            </a>
                        `;
                        parent.replaceChild(replaceDiv, iframe);
                    }
                } catch (e) {
                    console.error('Failed to fetch YouTube iframe thumbnail', e);
                }
            }
        }
    }
}

export async function exportCanvasToHtml(app: App, file: TFile, settings?: any, exportContext?: { asSnippet: boolean; depth: number; renderedCanvases: Set<string>; canvasView?: any }): Promise<any> {
    try {
        if (!exportContext) {
            exportContext = { asSnippet: false, depth: 0, renderedCanvases: new Set<string>() };
        }
        exportContext.renderedCanvases.add(file.path);

        const content = await app.vault.read(file);
        const canvasData: CanvasData = JSON.parse(content);

        if (!canvasData.nodes || canvasData.nodes.length === 0) {
            new Notice("Canvas is empty.");
            return null;
        }

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        const nodeMap = new Map<string, CanvasNode>();

        for (const node of canvasData.nodes) {
            nodeMap.set(node.id, node);
            if (node.x < minX) minX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.x + node.width > maxX) maxX = node.x + node.width;
            if (node.y + node.height > maxY) maxY = node.y + node.height;
        }

        // Add padding around the bounding box
        const padding = 100;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;

        const width = maxX - minX;
        const height = maxY - minY;

        const bodyClasses = document.body.className;
        const bodyStyles = document.body.style.cssText;

        let html = '';
        if (!exportContext?.asSnippet) {
            html += `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="canvas-width" content="${width}">
<meta name="canvas-height" content="${height}">
<title>${file.basename}</title>`;
        }

        html += `
<style>
    .canvas-container { position: relative; width: ${width}px; height: ${height}px; transform-origin: top left; display: block !important; }
    .canvas-node-container { width: 100%; height: 100%; display: flex; flex-direction: column; }
    .canvas-node { display: block !important; visibility: visible !important; opacity: 1 !important; }
    .canvas-edges { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: -1; }
</style>`;

        if (!exportContext?.asSnippet) {
            html += `
<style>
    /* Base Obsidian Variables to ensure themes work */
    :root {
        --background-primary: #ffffff;
        --background-secondary: #f5f5f5;
        --text-normal: #2e3338;
        --text-muted: #5c6e74;
    }
    @media (prefers-color-scheme: dark) {
        :root {
            --background-primary: #1e1e1e;
            --background-secondary: #252525;
            --text-normal: #dcddde;
            --text-muted: #8b949e;
        }
    }
    body, html { margin: 0; padding: 0; background-color: var(--background-secondary); font-family: var(--font-text), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: var(--font-text-size); overflow: auto !important; display: block !important; visibility: visible !important; opacity: 1 !important; --zoom-multiplier: 1; }
    
    body, .print { --font-print: var(--font-text-override), var(--font-text-theme), var(--font-default) !important; }
    ::-webkit-scrollbar { display: block !important; width: 12px !important; height: 12px !important; }
    ::-webkit-scrollbar-thumb { background: var(--text-faint) !important; border-radius: 6px !important; }
    .canvas-node-content.media-embed img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .canvas-node-content.markdown-embed > .markdown-embed-content,
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view,
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view > .markdown-preview-sizer { max-width: 100% !important; box-sizing: border-box !important; }
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view::before,
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view::after { display: none !important; }
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view > .markdown-preview-sizer { padding-top: max(0px, min(calc(var(--canvas-node-height) * 0.1 - 3px), var(--size-4-4))) !important; padding-bottom: max(0px, min(calc(var(--canvas-node-height) * 0.1 - 3px), var(--size-4-4))) !important; }
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view > .markdown-preview-sizer > :first-child { margin-top: 0 !important; }
    .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view > .markdown-preview-sizer > :last-child { margin-bottom: 0 !important; }
    .markdown-preview-view p, .markdown-preview-view div, .markdown-preview-view span, .markdown-preview-view a { word-break: break-word !important; overflow-wrap: anywhere !important; }
</style>
<style>
${getObsidianStyles()}
</style>
</head>
<body class="${bodyClasses}" style="${bodyStyles}">`;
        }

        html += `\n<div class="canvas-container print">
`;

        const dummyComponent = new Component();
        dummyComponent.load();

        let edgeLabelsHtml = '';

        // Resolve arrow colors by reading Obsidian's CSS custom properties:
        const rgbToHex = (rgb: string): string => {
            const parts = rgb.split(',').map(s => parseInt(s.trim(), 10));
            if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
                return '#' + parts.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
            }
            return '#888888';
        };

        const resolveCanvasColor = (colorNum: string): string => {
            const probe = document.createElement('div');
            probe.className = `canvas-node is-themed mod-canvas-color-${colorNum}`;
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).getPropertyValue('--canvas-color').trim();
            document.body.removeChild(probe);
            return rgbToHex(resolved);
        };

        const dynamicColors: { [key: string]: string } = {};
        for (let i = 1; i <= 6; i++) {
            dynamicColors[String(i)] = resolveCanvasColor(String(i));
        }
        // Default uncolored arrow: --canvas-color on body (192,192,192 light / 126,126,126 dark)
        const defaultArrowColor = rgbToHex(getComputedStyle(document.body).getPropertyValue('--canvas-color').trim());

        // 1. Render Edges (SVG)
        html += `<svg class="canvas-edges" width="100%" height="100%">\n`;
        if (canvasData.edges) {
            for (const edge of canvasData.edges) {
                const fromNode = nodeMap.get(edge.fromNode);
                const toNode = nodeMap.get(edge.toNode);
                if (!fromNode || !toNode) continue;

                const getSidePos = (node: CanvasNode, side: string = 'right') => {
                    const nx = node.x - minX;
                    const ny = node.y - minY;
                    switch (side) {
                        case 'top': return { x: nx + node.width / 2, y: ny };
                        case 'bottom': return { x: nx + node.width / 2, y: ny + node.height };
                        case 'left': return { x: nx, y: ny + node.height / 2 };
                        case 'right': default: return { x: nx + node.width, y: ny + node.height / 2 };
                    }
                };

                const start = getSidePos(fromNode, edge.fromSide);
                const end = getSidePos(toNode, edge.toSide);

                // Obsidian-like dynamic bezier curvature (clamped to prevent ballooning on long arrows)
                const distX = Math.abs(start.x - end.x);
                const distY = Math.abs(start.y - end.y);
                const offset1 = Math.max(30, Math.min(150, (edge.fromSide === 'left' || edge.fromSide === 'right' ? distX : distY) * 0.5));
                const offset2 = Math.max(30, Math.min(150, (edge.toSide === 'left' || edge.toSide === 'right' ? distX : distY) * 0.5));

                const cpx1 = edge.fromSide === 'left' ? start.x - offset1 : edge.fromSide === 'right' ? start.x + offset1 : start.x;
                const cpy1 = edge.fromSide === 'top' ? start.y - offset1 : edge.fromSide === 'bottom' ? start.y + offset1 : start.y;

                const cpx2 = edge.toSide === 'left' ? end.x - offset2 : edge.toSide === 'right' ? end.x + offset2 : end.x;
                const cpy2 = edge.toSide === 'top' ? end.y - offset2 : edge.toSide === 'bottom' ? end.y + offset2 : end.y;

                let color = defaultArrowColor;

                if (edge.color) {
                    if (edge.color.length === 1) {
                        color = dynamicColors[edge.color] || '#f08c00';
                    } else if (edge.color.startsWith('#')) {
                        color = edge.color;
                    } else {
                        color = edge.color; // Fallback for named colors if any
                    }
                }
                let markers = '';
                let pathProps = '';

                const toEnd = edge.toEnd === undefined ? 'arrow' : edge.toEnd;
                const fromEnd = edge.fromEnd === undefined ? 'none' : edge.fromEnd;

                if (toEnd === 'arrow') {
                    markers += `<marker id="arrow-end-${edge.id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" /></marker>`;
                    pathProps += ` marker-end="url(#arrow-end-${edge.id})"`;
                }
                if (fromEnd === 'arrow') {
                    markers += `<marker id="arrow-start-${edge.id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" /></marker>`;
                    pathProps += ` marker-start="url(#arrow-start-${edge.id})"`;
                }

                if (markers) html += `<defs>${markers}</defs>\n`;
                html += `<path d="M ${start.x} ${start.y} C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${end.x} ${end.y}" fill="none" stroke="${color}" stroke-width="4"${pathProps} />\n`;

                if (edge.label) {
                    const midX = 0.125 * start.x + 0.375 * cpx1 + 0.375 * cpx2 + 0.125 * end.x;
                    const midY = 0.125 * start.y + 0.375 * cpy1 + 0.375 * cpy2 + 0.125 * end.y;

                    edgeLabelsHtml += `<div class="canvas-edge-label" style="position: absolute; left: ${midX}px; top: ${midY}px; transform: translate(-50%, -50%); background-color: var(--background-primary); padding: 4px 8px; border-radius: 4px; font-family: var(--font-interface), sans-serif; font-size: var(--font-ui-small); color: var(--text-normal); border: 1px solid var(--background-modifier-border); z-index: 10;">${edge.label}</div>\n`;
                }
            }
        }

        // Close SVG Edges
        html += `</svg>\n`;
        html += edgeLabelsHtml;

        // 2. Render Nodes
        for (const node of canvasData.nodes) {
            const x = node.x - minX;
            const y = node.y - minY;
            const w = node.width;
            const h = node.height;

            const isGroup = node.type === 'group';
            let extraClass = isGroup ? 'canvas-node-group' : '';

            // Handle color
            let colorStyle = '';
            if (node.color) {
                extraClass += ' is-themed';
                if (node.color.length === 1) {
                    // "1", "2", "3", "4", "5", "6"
                    extraClass += ` mod-canvas-color-${node.color}`;
                } else if (node.color.startsWith('#')) {
                    // Custom hex color: convert to rgb for CSS variable if needed, or just set it
                    const hex = node.color.replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16);
                    const g = parseInt(hex.substring(2, 4), 16);
                    const b = parseInt(hex.substring(4, 6), 16);
                    colorStyle = `--canvas-color: ${r}, ${g}, ${b};`;
                }
            }

            let backgroundStyleHtml = '';
            if (isGroup) {
                const groupNode = node as any;
                if (groupNode.background) {
                    const tfile = app.vault.getAbstractFileByPath(groupNode.background);
                    if (tfile && (tfile as any).extension) {
                        const ext = (tfile as any).extension.toLowerCase();
                        if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
                            try {
                                const bgUrl = await getFileExportUrl(app, tfile as TFile, settings);
                                let bgSize = 'cover';
                                let bgRepeat = 'no-repeat';
                                let bgPos = 'center';
                                if (groupNode.backgroundStyle === 'ratio') {
                                    bgSize = 'contain';
                                } else if (groupNode.backgroundStyle === 'repeat') {
                                    bgSize = 'auto';
                                    bgRepeat = 'repeat';
                                    bgPos = 'top left';
                                }
                                backgroundStyleHtml = `background-image: url('${bgUrl}'); background-size: ${bgSize}; background-repeat: ${bgRepeat}; background-position: ${bgPos};`;
                            } catch (e) {
                                console.error("Failed to load background image:", e);
                            }
                        }
                    }
                }
            }

            // Provide inline styles
            html += `<div class="canvas-node ${extraClass}" style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px; ${colorStyle} --canvas-node-height: ${h}px;">`;
            html += `<div class="canvas-node-container" style="${backgroundStyleHtml}">`;

            if (node.type === 'text') {
                html += await renderPhantomMarkdown((node as TextNode).text, file.path, w, h, extraClass, app, settings, dummyComponent);
            }
            else if (node.type === 'file') {
                const fileNode = node as FileNode;
                const ext = fileNode.file.split('.').pop()?.toLowerCase();
                const tfile = app.vault.getAbstractFileByPath(fileNode.file);

                if (tfile instanceof TFile) {
                    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext || '')) {
                        const imgUrl = await getFileExportUrl(app, tfile, settings);
                        html += `<div class="canvas-node-content media-embed"><img src="${imgUrl}"></div>`;
                    } else if (ext === 'base') {
                        // Obsidian Bases require the live app view system to render;
                        // they cannot be statically exported to HTML.
                        html += `<div class="canvas-node-content markdown-rendered" style="padding: var(--size-4-4); display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-style: italic;"><div>📊 Base: ${tfile.basename} (cannot be exported statically)</div></div>`;
                    } else if (ext === 'md') {
                        const mdContent = await app.vault.read(tfile);
                        html += await renderPhantomMarkdown(mdContent, tfile.path, w, h, extraClass, app, settings, dummyComponent);
                    } else if (ext === 'canvas') {
                        const mode = settings?.nestedCanvasMode || 'outline';
                        const currentDepth = exportContext?.depth || 0;
                        const maxDepth = settings?.nestedCanvasMaxDepth || 3;
                        const rendered = exportContext?.renderedCanvases || new Set<string>();

                        const renderOutline = () => {
                            html += `<div class="canvas-node-content markdown-rendered" style="padding: var(--size-4-4); display: flex; align-items: center; justify-content: center; color: var(--text-muted); background: var(--background-secondary);">
                                <div><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-layout-dashboard" style="margin-right: 8px; vertical-align: middle;"><rect width="7" height="9" x="3" y="3" rx="1"></rect><rect width="7" height="5" x="14" y="3" rx="1"></rect><rect width="7" height="9" x="14" y="12" rx="1"></rect><rect width="7" height="5" x="3" y="16" rx="1"></rect></svg>
                                <span>${tfile.basename}</span></div>
                            </div>`;
                        };

                        if (mode === 'render') {
                            if (rendered.has(tfile.path)) {
                                html += `<div class="canvas-node-content markdown-rendered" style="padding: var(--size-4-4); display: flex; align-items: center; justify-content: center; color: var(--text-error); background: var(--background-secondary);"><div>⚠️ Infinite Recursion Detected: ${tfile.basename}</div></div>`;
                            } else if (currentDepth >= maxDepth) {
                                renderOutline(); // Fallback to outline at max depth
                            } else {
                                const subContext = {
                                    asSnippet: true,
                                    depth: currentDepth + 1,
                                    renderedCanvases: new Set(rendered)
                                };
                                subContext.renderedCanvases.add(tfile.path);

                                const snippetResult = await exportCanvasToHtml(app, tfile, settings, subContext);
                                if (snippetResult && typeof snippetResult !== 'string') {
                                    const { html: snippetHtml, width: subWidth, height: subHeight } = snippetResult;
                                    const scaleX = w / subWidth;
                                    const scaleY = h / subHeight;
                                    const scale = Math.min(scaleX, scaleY);
                                    const scaledWidth = subWidth * scale;
                                    const scaledHeight = subHeight * scale;
                                    const translateX = (w - scaledWidth) / 2;
                                    const translateY = (h - scaledHeight) / 2;

                                    html += `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; display: flex; align-items: center; justify-content: center; background-color: var(--background-primary); clip-path: inset(0);">
                                        <div style="width: ${subWidth}px; height: ${subHeight}px; transform: scale(${scale}); transform-origin: top left; position: absolute; left: ${translateX}px; top: ${translateY}px;">
                                            ${snippetHtml}
                                        </div>
                                    </div>`;
                                } else {
                                    renderOutline();
                                }
                            }
                        } else {
                            renderOutline();
                        }
                    } else if (ext === 'pdf') {
                        let captured = false;
                        if (exportContext?.canvasView) {
                            try {
                                const liveNode = exportContext.canvasView.canvas.nodes.get(node.id);
                                if (liveNode && liveNode.contentEl) {
                                    const pdfContainer = liveNode.contentEl.querySelector('.pdf-container');
                                    if (pdfContainer) {
                                        const originalCanvases = Array.from(pdfContainer.querySelectorAll('canvas'));
                                        if (originalCanvases.length > 0) {
                                            const clone = pdfContainer.cloneNode(true) as HTMLElement;
                                            const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));

                                            for (let i = 0; i < originalCanvases.length; i++) {
                                                const orig = originalCanvases[i] as HTMLCanvasElement;
                                                const cloneCanvas = clonedCanvases[i] as HTMLCanvasElement;

                                                const dataUrl = orig.toDataURL('image/jpeg', 0.9);
                                                const img = document.createElement('img');
                                                img.src = dataUrl;
                                                img.style.cssText = cloneCanvas.style.cssText;
                                                img.style.width = '100%';
                                                img.style.height = '100%';
                                                img.style.display = 'block';
                                                img.className = cloneCanvas.className;
                                                // We intentionally don't set img.width/img.height attributes 
                                                // to avoid retina-scale pixel expansion, relying on CSS instead.

                                                cloneCanvas.replaceWith(img);
                                            }

                                            // Strip out the toolbar from the clone so it doesn't overlap the view
                                            const clonedToolbar = clone.querySelector('.pdf-toolbar');
                                            if (clonedToolbar) clonedToolbar.remove();

                                            // Apply original scroll offsets
                                            let totalScrollTop = 0;
                                            let totalScrollLeft = 0;
                                            const originalPdfViewer = pdfContainer.querySelector('.pdfViewer') as HTMLElement;
                                            if (originalPdfViewer) {
                                                let current = originalPdfViewer;
                                                while (current && current !== liveNode.contentEl) {
                                                    totalScrollTop += current.scrollTop || 0;
                                                    totalScrollLeft += current.scrollLeft || 0;
                                                    current = current.parentElement as HTMLElement;
                                                }
                                            }

                                            const clonedPdfViewer = clone.querySelector('.pdfViewer') as HTMLElement;
                                            if (clonedPdfViewer) {
                                                clonedPdfViewer.style.transform = `translate(${-totalScrollLeft}px, ${-totalScrollTop}px)`;
                                            }

                                            clone.style.width = '100%';
                                            clone.style.height = '100%';
                                            clone.style.position = 'absolute';
                                            clone.style.top = '0';
                                            clone.style.left = '0';

                                            html += `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: var(--background-primary);">`;
                                            html += clone.outerHTML;
                                            html += `</div>`;
                                            captured = true;
                                        }
                                    }
                                }
                            } catch (e) {
                                console.error('Failed to capture live PDF DOM:', e);
                            }
                        }
                        if (!captured) {
                            try {
                                const pdfDataUrl = await renderPdfFileToDataUrl(app, tfile, fileNode.subpath);
                                if (pdfDataUrl) {
                                    html += `<div class="canvas-node-content media-embed" style="position: relative; width: 100%; height: 100%; overflow: hidden !important; background: var(--background-primary);"><img src="${pdfDataUrl}" style="width: 100%; height: 100%; object-fit: contain; display: block;"></div>`;
                                    captured = true;
                                }
                            } catch (e) {
                                console.error('Fallback PDF rendering failed:', e);
                            }
                        }
                        if (!captured) {
                            html += `<div class="canvas-node-content" style="display: flex; align-items: center; justify-content: center; background: var(--background-secondary); color: var(--text-muted);"><div style="text-align: center;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon" style="margin-bottom: 8px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><br><span>${fileNode.file}</span></div></div>`;
                        }
                    } else {
                        html += `<div class="canvas-node-content"><div><a href="${fileNode.file}">📄 ${fileNode.file}</a></div></div>`;
                    }
                } else {
                    html += `<div class="canvas-node-content"><div>[File not found: ${fileNode.file}]</div></div>`;
                }
            }
            else if (node.type === 'link') {
                const linkNode = node as LinkNode;
                const exportTarget = (settings as any).exportTarget || 'html';
                const useHighRes = (settings as any).highResWebviews;
                let injectedContent = `<div class="canvas-node-content"><div><a href="${linkNode.url}" target="_blank">${linkNode.url}</a></div></div>`;

                if (exportTarget === 'pdf' || exportTarget === 'html') {
                    let dataUrl: string | null = null;
                    let isYouTube = false;

                    const ytMatch = linkNode.url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
                    if (ytMatch && ytMatch[1]) {
                        isYouTube = true;
                        const videoId = ytMatch[1];
                        let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
                        try {
                            let res;
                            try {
                                res = await requestUrl({ url: thumbnailUrl });
                            } catch (e) {
                                // Fallback to hqdefault if maxres doesn't exist (older videos)
                                thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                                res = await requestUrl({ url: thumbnailUrl });
                            }
                            const base64 = bufferToBase64(res.arrayBuffer);
                            dataUrl = `data:image/jpeg;base64,${base64}`;

                            injectedContent = `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: #000; display: flex; align-items: center; justify-content: center;">
                                <a href="${linkNode.url}" target="_blank" style="display: block; width: 100%; height: 100%; text-decoration: none;">
                                    <img src="${dataUrl}" style="width: 100%; height: 100%; object-fit: contain; border: none; display: block; opacity: 0.85;" />
                                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">
                                        <svg width="68" height="48" viewBox="0 0 68 48" version="1.1" xmlns="http://www.w3.org/2000/svg">
                                            <path d="M66.52,7.74c-0.78-2.93-2.49-5.41-5.42-6.19C55.79,.13,34,0,34,0S12.21,.13,6.9,1.55 C3.97,2.33,2.27,4.81,1.48,7.74C0.06,13.05,0,24,0,24s0.06,10.95,1.48,16.26c0.78,2.93,2.49,5.41,5.42,6.19 C12.21,47.87,34,48,34,48s21.79-0.13,27.1-1.55c2.93-0.78,4.64-3.26,5.42-6.19C67.94,34.95,68,24,68,24S67.94,13.05,66.52,7.74z" fill="#ff0000"></path>
                                            <path d="M 45,24 27,14 27,34" fill="#ffffff"></path>
                                        </svg>
                                    </div>
                                </a>
                            </div>`;
                        } catch (e) {
                            console.error('Failed to fetch YouTube thumbnail', e);
                            injectedContent = `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: var(--background-primary);"><iframe src="https://www.youtube.com/embed/${videoId}" style="width: 100%; height: 100%; border: none;" allow="fullscreen; autoplay; encrypted-media"></iframe></div>`;
                        }
                    }

                    if (!isYouTube) {
                        let partition: string | null = null;
                        let liveWebview: any = null;

                        if (exportContext.canvasView) {
                            const liveNode = exportContext.canvasView.canvas.nodes.get(node.id);
                            if (liveNode && liveNode.contentEl) {
                                liveWebview = liveNode.contentEl.querySelector('webview');
                                if (liveWebview) {
                                    partition = liveWebview.getAttribute('partition');
                                }
                            }
                        }

                        try {
                            if (useHighRes) {
                                new Notice(`Capturing high-res ghost webview: ${linkNode.url}...`);
                                dataUrl = await captureGhostWebview(linkNode.url, node.width, node.height, partition);
                            }

                            if (!dataUrl && liveWebview && typeof liveWebview.capturePage === 'function') {
                                const img = await liveWebview.capturePage();
                                dataUrl = img.toDataURL();
                            }

                            if (dataUrl && dataUrl.startsWith('data:image')) {
                                injectedContent = `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: var(--background-primary);"><a href="${linkNode.url}" target="_blank" style="display: block; width: 100%; height: 100%;"><img src="${dataUrl}" style="width: 100%; height: auto; object-fit: contain; object-position: top; border: none; display: block;" /></a></div>`;
                            } else if (exportTarget === 'html') {
                                // Fallback to iframe if capture completely failed
                                injectedContent = `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: var(--background-primary);"><iframe src="${linkNode.url}" style="width: 100%; height: 100%; border: none;" allow="fullscreen; autoplay; encrypted-media"></iframe></div>`;
                            }
                        } catch (e) {
                            console.error("Failed to capture webview", e);
                            if (exportTarget === 'html') {
                                injectedContent = `<div class="canvas-node-content" style="position: relative; overflow: hidden !important; background: var(--background-primary);"><iframe src="${linkNode.url}" style="width: 100%; height: 100%; border: none;" allow="fullscreen; autoplay; encrypted-media"></iframe></div>`;
                            }
                        }
                    }
                }

                html += injectedContent;
            }
            else if (node.type === 'group') {
                html += `<div class="canvas-node-content"></div>`;
            }

            html += `</div>\n`; // Close canvas-node-container

            if (node.type === 'group' && (node as any).label) {
                let foregroundClass = '';

                // Use Obsidian's exact luminance formula to determine text color
                const computeIsLight = (hexCode: string) => {
                    const cleanHex = hexCode.replace('#', '');
                    if (cleanHex.length !== 6) return false;
                    const r = parseInt(cleanHex.substring(0, 2), 16);
                    const g = parseInt(cleanHex.substring(2, 4), 16);
                    const b = parseInt(cleanHex.substring(4, 6), 16);
                    // This is the exact formula Obsidian uses internally (cO function)
                    return (299 * r + 587 * g + 114 * b) / 1000 >= 150;
                };

                if (node.color) {
                    let bgHex = '';
                    if (node.color.length === 1 && dynamicColors[node.color]) {
                        bgHex = dynamicColors[node.color];
                    } else if (node.color.startsWith('#')) {
                        bgHex = node.color;
                    }

                    if (bgHex) {
                        foregroundClass = computeIsLight(bgHex) ? 'mod-foreground-dark' : 'mod-foreground-light';
                    }
                }
                html += `<div class="canvas-group-label ${foregroundClass}">${(node as any).label}</div>\n`;
            }

            if (settings?.showNodeLabels && node.type === 'file') {
                const fileNode = node as FileNode;
                const tfile = app.vault.getAbstractFileByPath(fileNode.file);
                const labelText = tfile ? tfile.name : fileNode.file;
                const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-file"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>`;
                html += `<div class="canvas-node-label">${svgIcon}${labelText}</div>\n`;
            }

            html += `</div>\n`; // Close canvas-node
        }


        html += `</div>\n`; // Close canvas-container

        if (!exportContext?.asSnippet) {
            html += `<script>
        window.onload = () => {
            const firstNode = document.querySelector('.canvas-node');
            if (firstNode) {
                firstNode.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            }
        };
        </script>\n`;
            html += `</body>\n</html>`;
        }

        dummyComponent.unload();

        if (exportContext?.asSnippet) {
            return { html, width, height };
        }
        return html;

    } catch (e) {
        console.error("Failed to export Canvas to HTML", e);
        new Notice("Failed to export Canvas to HTML.");
        return null;
    }
}

async function renderPhantomMarkdown(
    mdText: string,
    sourcePath: string,
    width: number,
    height: number,
    extraClass: string,
    app: App,
    settings: any,
    dummyComponent: Component
): Promise<string> {
    const outer = document.createElement('div');
    outer.className = `canvas-node ${extraClass}`;
    outer.style.position = 'absolute';
    outer.style.left = '-99999px';
    outer.style.width = width + 'px';
    outer.style.height = height + 'px';
    outer.style.setProperty('--canvas-node-height', height + 'px');
    outer.style.visibility = 'hidden';

    const innerContainer = document.createElement('div');
    innerContainer.className = 'canvas-node-container';
    outer.appendChild(innerContainer);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'canvas-node-content markdown-embed is-loaded';
    innerContainer.appendChild(contentDiv);

    const embedContentDiv = document.createElement('div');
    embedContentDiv.className = 'markdown-embed-content node-insert-event';
    contentDiv.appendChild(embedContentDiv);

    const previewViewDiv = document.createElement('div');
    previewViewDiv.className = 'obsidian-document markdown-preview-view markdown-rendered node-insert-event show-indentation-guide allow-fold-headings allow-fold-lists show-properties';
    previewViewDiv.setAttribute('dir', 'auto');
    embedContentDiv.appendChild(previewViewDiv);

    const sizerDiv = document.createElement('div');
    sizerDiv.className = 'markdown-preview-sizer markdown-preview-section';
    previewViewDiv.appendChild(sizerDiv);

    document.body.appendChild(outer);

    await MarkdownRenderer.renderMarkdown(mdText, sizerDiv, sourcePath, dummyComponent);
    await processMarkdownImages(app, contentDiv, sourcePath, settings);
    await processMarkdownIframes(app, contentDiv);

    const htmlString = contentDiv.outerHTML;
    document.body.removeChild(outer);
    return htmlString;
}
