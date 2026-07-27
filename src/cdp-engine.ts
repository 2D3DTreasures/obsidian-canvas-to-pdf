import { Notice } from 'obsidian';

// Dynamic imports to avoid breaking Obsidian's plugin loader
let cp: typeof import('child_process');
let fs: typeof import('fs');
let path: typeof import('path');
let net: typeof import('net');
let http: typeof import('http');
let os: typeof import('os');

try {
    cp = require('child_process');
    fs = require('fs');
    path = require('path');
    net = require('net');
    http = require('http');
    os = require('os');
} catch (e) {
    console.warn('Node.js modules not fully available.');
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

/**
 * Custom TCP WebSocket implementation.
 * Chromium's CDP server enforces security checks that reject WebSocket connections
 * containing an external 'Origin' header. Standard window.WebSocket in Electron attaches
 * an 'app://' Origin header, causing rejection. Using raw Node.js TCP sockets (net.createConnection)
 * allows constructing the HTTP Upgrade request without the 'Origin' header.
 */
function createWSConnection(wsUrl: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = new URL(wsUrl);
        const socket = net.createConnection({ host: url.hostname, port: parseInt(url.port) }, () => {
            const key = Buffer.from(Math.random().toString(36)).toString('base64');
            const request = [
                `GET ${url.pathname} HTTP/1.1`,
                `Host: ${url.host}`,
                `Upgrade: websocket`,
                `Connection: Upgrade`,
                `Sec-WebSocket-Key: ${key}`,
                `Sec-WebSocket-Version: 13`,
                ``,
                ``
            ].join('\r\n');
            socket.write(request);
        });

        let headersDone = false;
        let buffer = Buffer.alloc(0);
        let msgId = 1;
        const pending = new Map();
        let messageBuffer = Buffer.alloc(0);

        function processFrames() {
            while (buffer.length >= 2) {
                const firstByte = buffer[0];
                const secondByte = buffer[1];
                const opcode = firstByte & 0x0f;
                let payloadLength = secondByte & 0x7f;
                let offset = 2;

                if (payloadLength === 126) {
                    if (buffer.length < 4) return;
                    payloadLength = buffer.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLength === 127) {
                    if (buffer.length < 10) return;
                    payloadLength = Number(buffer.readBigUInt64BE(2));
                    offset = 10;
                }

                if (buffer.length < offset + payloadLength) return;

                const payload = buffer.subarray(offset, offset + payloadLength);
                buffer = buffer.subarray(offset + payloadLength);

                if (opcode === 1 || opcode === 2 || opcode === 0) {
                    messageBuffer = Buffer.concat([messageBuffer, payload]);
                    const fin = (firstByte & 0x80) === 0x80;
                    if (fin) {
                        try {
                            const msg = JSON.parse(messageBuffer.toString());
                            if (msg.id && pending.has(msg.id)) {
                                const { resolve, reject } = pending.get(msg.id);
                                pending.delete(msg.id);
                                if (msg.error) reject(new Error(msg.error.message));
                                else resolve(msg.result);
                            }
                        } catch (e) { }
                        messageBuffer = Buffer.alloc(0);
                    }
                }
            }
        }

        function sendWSFrame(data: any) {
            const payload = Buffer.from(JSON.stringify(data));
            const frame = [];
            frame.push(0x81);

            if (payload.length < 126) {
                frame.push(0x80 | payload.length);
            } else if (payload.length < 65536) {
                frame.push(0x80 | 126);
                frame.push((payload.length >> 8) & 0xff);
                frame.push(payload.length & 0xff);
            } else {
                frame.push(0x80 | 127);
                const lenBuf = Buffer.alloc(8);
                lenBuf.writeBigUInt64BE(BigInt(payload.length));
                frame.push(...lenBuf);
            }

            const mask = Buffer.from([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
            frame.push(...mask);

            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
                masked[i] = payload[i] ^ mask[i % 4];
            }

            socket.write(Buffer.concat([Buffer.from(frame), masked]));
        }

        socket.on('data', (chunk) => {
            const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            if (!headersDone) {
                const text = chunkBuf.toString();
                const idx = text.indexOf('\r\n\r\n');
                if (idx !== -1) {
                    headersDone = true;
                    const headerByteLength = Buffer.byteLength(text.slice(0, idx + 4));
                    const remaining = chunkBuf.subarray(headerByteLength);
                    buffer = Buffer.concat([buffer, remaining]);

                    const conn = {
                        send(method: string, params: any = {}) {
                            return new Promise((res, rej) => {
                                const id = msgId++;
                                pending.set(id, { resolve: res, reject: rej });
                                sendWSFrame({ id, method, params });
                            });
                        },
                        close() { socket.end(); }
                    };
                    resolve(conn);
                }
                return;
            }
            buffer = Buffer.concat([buffer, chunkBuf]);
            processFrames();
        });

        socket.on('error', (err) => {
            for (const { reject } of pending.values()) {
                reject(err);
            }
            pending.clear();
            reject(err);
        });

        socket.on('close', () => {
            for (const { reject } of pending.values()) {
                reject(new Error("WebSocket closed unexpectedly (Browser may have crashed or ran out of memory)"));
            }
            pending.clear();
        });
    });
}

function getDefaultBrowserPath(): string {
    const platform = os.platform();
    if (platform === 'win32') {
        const paths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    } else if (platform === 'darwin') {
        const paths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    } else if (platform === 'linux') {
        const paths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge-stable'
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    }
    return '';
}

export async function exportHtmlToPdfCDP(htmlString: string, browserPathSetting: string, progress?: (msg: string) => void): Promise<Uint8Array | null> {
    if (!cp || !fs) {
        new Notice("Node.js environment not available.");
        return null;
    }

    const browserPath = browserPathSetting || getDefaultBrowserPath();
    if (!browserPath || !fs.existsSync(browserPath)) {
        new Notice("Chrome or Edge could not be found. Please configure the path in settings.");
        return null;
    }

    const tempDir = os.tmpdir();
    const tempHtmlFile = path.join(tempDir, `obsidian-canvas-export-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlFile, htmlString, 'utf8');

    const port = Math.floor(Math.random() * (9999 - 9222) + 9222);
    const htmlFileUrl = process.platform === 'win32' ? `file:///${tempHtmlFile.replace(/\\/g, '/')}` : `file://${tempHtmlFile}`;

    const browserArgs = [
        `--headless=new`,
        `--disable-gpu`,
        `--remote-debugging-port=${port}`,
        `--window-size=2000,2000`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        htmlFileUrl
    ];

    if (progress) progress("Starting headless browser engine...");
    const browserProcess = cp.spawn(browserPath, browserArgs, { stdio: 'pipe' });

    // Wait for browser to start up and expose CDP
    let targets = null;
    for (let i = 0; i < 20; i++) {
        if (progress) progress(`Connecting to browser engine... (Attempt ${i + 1}/20)`);
        await sleep(500);
        try {
            targets = await fetchJSON(`http://127.0.0.1:${port}/json`);
            if (targets && targets.length > 0) break;
        } catch (e) {
            // Keep trying
        }
    }

    if (!targets) {
        browserProcess.kill();
        fs.unlinkSync(tempHtmlFile);
        new Notice("Failed to connect to the browser engine.");
        return null;
    }

    try {
        const pageTarget = targets.find((t: any) => t.type === 'page');
        if (!pageTarget) throw new Error('No page target found.');

        const conn = await createWSConnection(pageTarget.webSocketDebuggerUrl);

        // Wait for page to fully load and parse the DOM
        let loaded = false;
        for (let i = 0; i < 90; i++) { // Max 90 seconds for heavy canvases
            if (progress) progress(`Rendering canvas... (Waiting for images, ${i + 1}/90s)`);
            const r = await conn.send('Runtime.evaluate', {
                returnByValue: true,
                expression: `document.readyState === 'complete' && document.querySelectorAll('.canvas-node').length > 0 && Array.from(document.images).every(img => img.complete)`
            });
            if (r.result && r.result.value) {
                loaded = true;
                break;
            }
            await sleep(1000);
        }

        if (progress) progress("Canvas rendered. Finalizing layout stabilization...");
        // Extra second for layout stabilization
        await sleep(1000);

        // Force overflow visible
        await conn.send('Runtime.evaluate', {
            expression: `
                const s = document.createElement('style');
                s.textContent = 'body, html, .canvas-container { overflow: visible !important; } .canvas-node { display: block !important; }';
                document.head.appendChild(s);
            `
        });
        await sleep(1000);

        // Read bounding box from meta tags
        const bboxEval = await conn.send('Runtime.evaluate', {
            returnByValue: true,
            expression: `
                (() => {
                    const w = document.querySelector('meta[name="canvas-width"]');
                    const h = document.querySelector('meta[name="canvas-height"]');
                    if (!w || !h) return null;
                    return { width: parseFloat(w.content), height: parseFloat(h.content) };
                })();
            `
        });

        let bbox = bboxEval.result?.value;
        if (!bbox || bbox.width === 0 || bbox.height === 0) {
            bbox = { width: 1920, height: 1080 };
        }

        // We don't need to translate because the HTML starts at 0,0!
        // But we DO need to make sure the body width/height are set properly.
        await conn.send('Runtime.evaluate', {
            expression: `
                document.body.style.width = '${bbox.width}px';
                document.body.style.height = '${bbox.height}px';
                const wrapper = document.querySelector('.canvas-container');
                if (wrapper) {
                    wrapper.style.transform = 'none';
                }
            `
        });
        await sleep(1000);

        // PDF max dimension in inches is 200.
        let pw = bbox.width / 96;
        let ph = bbox.height / 96;
        let printScale = 1;

        // Scale down if it exceeds limits
        const MAX_INCHES = 199.9;
        if (pw > MAX_INCHES || ph > MAX_INCHES) {
            // Chromium's CDP scale limit is minimum 0.1
            printScale = Math.max(0.1, MAX_INCHES / Math.max(pw, ph));
            pw *= printScale;
            ph *= printScale;
        }

        if (progress) progress("Generating final PDF bytes... (This may take a moment)");
        const r = await conn.send('Page.printToPDF', {
            landscape: false, displayHeaderFooter: false, printBackground: true,
            paperWidth: pw, paperHeight: ph,
            marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
            scale: printScale,
            pageRanges: '1',
            transferMode: 'ReturnAsStream'
        });

        if (!r.stream) {
            throw new Error("No stream returned from Page.printToPDF");
        }

        if (progress) progress("Streaming PDF bytes from browser...");

        const chunks: Buffer[] = [];
        let eof = false;
        while (!eof) {
            const readRes = await conn.send('IO.read', { handle: r.stream });
            if (readRes.data) {
                chunks.push(Buffer.from(readRes.data, readRes.base64Encoded ? 'base64' : 'utf8'));
            }
            eof = readRes.eof;
        }

        await conn.send('IO.close', { handle: r.stream });

        conn.close();
        browserProcess.kill();
        fs.unlinkSync(tempHtmlFile);

        const pdfBuffer = Buffer.concat(chunks);
        return new Uint8Array(pdfBuffer);

    } catch (err) {
        console.error('CDP Export Error:', err);
        browserProcess.kill();
        if (fs.existsSync(tempHtmlFile)) fs.unlinkSync(tempHtmlFile);
        new Notice("Error occurred during PDF generation via browser.");
        return null;
    }
}
