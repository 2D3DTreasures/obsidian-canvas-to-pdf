import { App, Plugin, TFile, Notice } from 'obsidian';
import { VectorPdfSettings, DEFAULT_SETTINGS } from './types';
import { VectorPdfSettingTab } from './settings';
import { ExportModal } from './export-modal';
import { exportCanvasToHtml } from './html-exporter';
import { exportHtmlToPdfCDP } from './cdp-engine';

export default class CanvasToPdfPlugin extends Plugin {
    settings: VectorPdfSettings;

    async onload() {
        new Notice("Canvas to PDF v1.0.0 loaded!");
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new VectorPdfSettingTab(this.app, this));

        // Add file menu items for Canvas
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile) {
                    if (file.extension === 'canvas') {
                        menu.addItem((item) => {
                            item
                                .setTitle('Export canvas to PDF')
                                .setIcon('document') // Obsidian built-in icon
                                .onClick(() => {
                                    this.handleCanvasExport(file);
                                });
                        });
                    }
                }
            })
        );

        // Command palette
        this.addCommand({
            id: 'export-current-canvas-to-pdf',
            name: 'Export current canvas to PDF',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'canvas') {
                    if (!checking) {
                        this.handleCanvasExport(file);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'export-current-canvas-to-pdf-quick',
            name: 'Quick Export current canvas to PDF (Last Parameters)',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'canvas') {
                    if (!checking) {
                        this.handleQuickCanvasExport(file);
                    }
                    return true;
                }
                return false;
            }
        });



    }

    onunload() {
        // Cleanup if needed
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }



    private getUniqueBaseFileName(pathStr: string, baseName: string, format: string): string {
        pathStr = pathStr || "";
        const isAbsolute = pathStr.includes(':\\') || pathStr.startsWith('/');
        const checkFormats = format === 'both' ? ['.html', '.pdf'] : [format === 'html' ? '.html' : '.pdf'];

        const existsFn = (candidateBase: string): boolean => {
            for (const ext of checkFormats) {
                const targetName = candidateBase + ext;
                if (isAbsolute) {
                    const fs = require('fs');
                    const nodePath = require('path');
                    const fullPath = nodePath.join(pathStr, targetName);
                    if (fs.existsSync(fullPath)) return true;
                } else {
                    let fullPath = pathStr;
                    if (fullPath && !fullPath.endsWith('/')) {
                        fullPath += '/';
                    }
                    const finalPath = fullPath + targetName;
                    if (this.app.vault.getAbstractFileByPath(finalPath)) return true;
                }
            }
            return false;
        };

        if (!existsFn(baseName)) {
            return baseName;
        }

        let counter = 1;
        while (existsFn(`${baseName} (${counter})`)) {
            counter++;
        }
        return `${baseName} (${counter})`;
    }

    private async performExport(file: TFile, fileName: string, path: string, open: boolean, theme: string, format: string, highResWebviews: boolean) {
        const activeSettings = { ...this.settings, theme, exportFormat: format, highResWebviews };
        const targetBaseName = this.getUniqueBaseFileName(path, fileName, format);

        let canvasView: unknown = null;
        this.app.workspace.getLeavesOfType('canvas').forEach(leaf => {
            if (leaf.view && (leaf.view as any).file?.path === file.path) {
                canvasView = leaf.view;
            }
        });


        let exportNotice: any = null;
        const updateProgress = (msg: string) => {
            if (!exportNotice) {
                exportNotice = new Notice(msg, 0); // 0 means it stays until hidden
            } else {
                if (exportNotice.setMessage) {
                    exportNotice.setMessage(msg);
                } else if (exportNotice.noticeEl) {
                    exportNotice.noticeEl.innerText = msg;
                }
            }
        };

        try {
            if (format === 'html' || format === 'both') {
                updateProgress("Parsing Canvas to HTML...");
                const htmlSettings = { ...activeSettings, exportTarget: 'html' as 'pdf' | 'html' };
                const htmlStrHtml = await exportCanvasToHtml(this.app, file, htmlSettings, { asSnippet: false, depth: 0, renderedCanvases: new Set(), canvasView });
                if (htmlStrHtml) {
                    updateProgress("Saving HTML to vault...");
                    const enc = new TextEncoder();
                    await this.saveDataToVault(enc.encode(htmlStrHtml), targetBaseName + '.html', path, format === 'html' && open);
                }
            }

            if (format === 'pdf' || format === 'both') {
                let pdfBytes: Uint8Array | null = null;
                const pdfSettings = { ...activeSettings, exportTarget: 'pdf' as 'pdf' | 'html' };
                updateProgress("Parsing Canvas to HTML (for PDF)...");
                const htmlStrPdf = await exportCanvasToHtml(this.app, file, pdfSettings, { asSnippet: false, depth: 0, renderedCanvases: new Set(), canvasView });
                if (htmlStrPdf) {
                    pdfBytes = await exportHtmlToPdfCDP(htmlStrPdf, this.settings.browserPath || '', updateProgress);
                }

                if (pdfBytes) {
                    updateProgress("Saving PDF to vault...");
                    await this.saveDataToVault(pdfBytes, targetBaseName + '.pdf', path, open);
                }
            }
        } catch (error: unknown) {
            console.error("Canvas Export Error:", error);
            new Notice(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
        } finally {
            if (exportNotice) {
                exportNotice.hide();
            }
        }
    }

    private handleCanvasExport(file: TFile) {


        const defaultFileName = file.basename;
        new ExportModal(this.app, defaultFileName, this.settings.defaultExportPath, this.settings, async (fileName, path, open, theme, format, highResWebviews) => {
            this.settings.defaultExportPath = path;
            this.settings.exportFormat = format as any;
            this.settings.openAfterExport = open;
            this.settings.highResWebviews = highResWebviews;
            await this.saveSettings();

            await this.performExport(file, fileName, path, open, theme, format, highResWebviews);
        }).open();
    }

    private handleQuickCanvasExport(file: TFile) {


        const defaultFileName = file.basename;
        const theme = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
        const format = this.settings.exportFormat || 'pdf';
        const highResWebviews = this.settings.highResWebviews;
        this.performExport(file, defaultFileName, this.settings.defaultExportPath, this.settings.openAfterExport, theme, format, highResWebviews);
    }
    private async saveDataToVault(data: Uint8Array, fileName: string, pathStr: string, open: boolean): Promise<string | null> {
        try {
            pathStr = pathStr || "";
            // Detect if the user typed an absolute path (e.g. C:\Users\Desktop or /Users/Desktop)
            const isAbsolute = pathStr.includes(':\\') || pathStr.startsWith('/');

            if (isAbsolute) {
                const fs = require('fs');
                const nodePath = require('path');

                if (!fs.existsSync(pathStr)) {
                    fs.mkdirSync(pathStr, { recursive: true });
                }

                const finalPath = nodePath.join(pathStr, fileName);
                fs.writeFileSync(finalPath, data);
                new Notice(`Exported externally to ${finalPath}`);

                if (open) {
                    const { shell } = require('electron');
                    shell.openPath(finalPath);
                }
                return finalPath;
            }

            // --- Normal Vault-Relative Path Logic ---
            let fullPath = pathStr;
            if (fullPath && !fullPath.endsWith('/')) {
                fullPath += '/';
            }

            // Create folder if it doesn't exist
            if (fullPath) {
                const folderExists = this.app.vault.getAbstractFileByPath(fullPath.slice(0, -1));
                if (!folderExists) {
                    await this.app.vault.createFolder(fullPath.slice(0, -1));
                }
            }

            const finalPath = fullPath + fileName;

            // Extract exact ArrayBuffer slice to ensure correct byte offset and type compatibility with Obsidian Vault API
            const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

            // Check if file exists; Obsidian createBinary fails if file exists, 
            // so we use modifyBinary for existing files.
            let fileRef = this.app.vault.getAbstractFileByPath(finalPath);
            if (fileRef instanceof TFile) {
                await this.app.vault.modifyBinary(fileRef, arrayBuffer);
            } else {
                fileRef = await this.app.vault.createBinary(finalPath, arrayBuffer);
            }

            new Notice(`Exported successfully to ${finalPath}`);

            if (open && fileRef instanceof TFile) {
                // Open using the workspace leaf so it handles default PDF viewers cleanly
                const leaf = this.app.workspace.getLeaf(true);
                await leaf.openFile(fileRef);
            }
            return finalPath;
        } catch (e: any) {
            console.error("Failed to save export file", e);
            new Notice(`Failed to save export: ${e instanceof Error ? e.message : String(e)}`, 8000);
            return null;
        }
    }
}
