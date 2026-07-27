import { App, Modal, Setting } from 'obsidian';
import { VectorPdfSettings } from './types';

export class ExportModal extends Modal {
    defaultFileName: string;
    defaultPath: string;

    resultFileName: string;
    resultPath: string;
    resultOpen: boolean;
    resultTheme: 'light' | 'dark';
    resultFormat: 'pdf' | 'html' | 'both';
    resultHighResWebviews: boolean;

    onSubmit: (fileName: string, path: string, open: boolean, theme: 'light' | 'dark', format: 'pdf' | 'html' | 'both', highResWebviews: boolean) => void;

    constructor(app: App, defaultFileName: string, defaultPath: string, settings: VectorPdfSettings, onSubmit: (fileName: string, path: string, open: boolean, theme: 'light' | 'dark', format: 'pdf' | 'html' | 'both', highResWebviews: boolean) => void) {
        super(app);
        this.defaultFileName = defaultFileName;
        this.defaultPath = defaultPath;

        this.resultFileName = defaultFileName;
        this.resultPath = defaultPath;
        this.resultOpen = settings.openAfterExport;
        this.resultTheme = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
        this.resultFormat = settings.exportFormat || 'pdf';
        this.resultHighResWebviews = settings.highResWebviews;

        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('canvas-to-pdf-modal');

        const headerContainer = contentEl.createDiv({ cls: 'canvas-to-pdf-modal-header' });
        headerContainer.style.display = 'flex';
        headerContainer.style.justifyContent = 'space-between';
        headerContainer.style.alignItems = 'baseline';

        headerContainer.createEl('h2', { text: 'Export canvas', cls: 'canvas-to-pdf-modal-title' });
        headerContainer.createEl('span', { text: 'v1.0.0', cls: 'text-muted' });

        // Remove the top margin from the h2 so it aligns well
        const h2El = headerContainer.querySelector('h2');
        if (h2El) h2El.style.marginTop = '0';

        new Setting(contentEl)
            .setName('File name')
            .addText(text => text
                .setValue(this.defaultFileName)
                .onChange(value => {
                    this.resultFileName = value;
                }));

        let pathTextInput: any = null;

        const folderSetting = new Setting(contentEl)
            .setName('Export folder')
            .setDesc('Vault relative path (Exports/) or absolute OS path (C:\\...)')
            .addText(text => {
                pathTextInput = text;
                text.setValue(this.defaultPath).onChange(value => {
                    this.resultPath = value;
                });
                return text;
            });

        folderSetting.addButton(btn => btn
            .setButtonText('Browse')
            .onClick(() => {
                const { exec } = require('child_process');
                const os = require('os');

                if (os.platform() === 'win32') {
                    // Native Windows Folder Browser Dialog via PowerShell
                    const psScript = `Add-Type -AssemblyName System.windows.forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Export Folder'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`;
                    exec(`powershell -NoProfile -Command "${psScript}"`, (error: any, stdout: string) => {
                        if (stdout && stdout.trim()) {
                            const selectedPath = stdout.trim();
                            if (pathTextInput) pathTextInput.setValue(selectedPath);
                            this.resultPath = selectedPath;
                        }
                    });
                } else if (os.platform() === 'darwin') {
                    // Native Mac OS X Folder Browser Dialog via AppleScript
                    exec(`osascript -e 'tell application "System Events" to set folderPath to POSIX path of (choose folder with prompt "Select Export Folder")' -e 'return folderPath'`, (error: any, stdout: string) => {
                        if (stdout && stdout.trim()) {
                            const selectedPath = stdout.trim();
                            if (pathTextInput) pathTextInput.setValue(selectedPath);
                            this.resultPath = selectedPath;
                        }
                    });
                } else {
                    // Native Linux Folder Browser Dialog via Zenity
                    exec(`zenity --file-selection --directory --title="Select Export Folder"`, (error: any, stdout: string) => {
                        if (stdout && stdout.trim()) {
                            const selectedPath = stdout.trim();
                            if (pathTextInput) pathTextInput.setValue(selectedPath);
                            this.resultPath = selectedPath;
                        }
                    });
                }
            }));

        new Setting(contentEl)
            .setName('Format')
            .setDesc('Choose to export as PDF, HTML, or both')
            .addDropdown(dropdown => dropdown
                .addOptions({ 'pdf': 'PDF', 'html': 'HTML', 'both': 'Both' })
                .setValue(this.resultFormat)
                .onChange(value => {
                    this.resultFormat = value as 'pdf' | 'html' | 'both';
                }));

        // Theme is always inherited from the current Obsidian theme

        new Setting(contentEl)
            .setName('Open PDF after export')
            .addToggle(toggle => toggle
                .setValue(this.resultOpen)
                .onChange(value => {
                    this.resultOpen = value;
                }));

        new Setting(contentEl)
            .setName('High resolution web link previews')
            .setDesc('Render embedded web links at high resolution (may add slight delay per link)')
            .addToggle(toggle => toggle
                .setValue(this.resultHighResWebviews)
                .onChange(value => {
                    this.resultHighResWebviews = value;
                }));

        const tipEl = contentEl.createEl('div', { cls: 'setting-item-description' });
        tipEl.style.marginTop = '12px';
        tipEl.style.marginBottom = '8px';
        tipEl.style.fontSize = 'var(--font-ui-smaller)';
        tipEl.style.color = 'var(--text-muted)';
        tipEl.style.textAlign = 'center';
        tipEl.innerText = '💡 Tip: Additional options (nested canvas depth, default path) can be changed in Plugin Settings.';

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Export')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onSubmit(this.resultFileName, this.resultPath, this.resultOpen, this.resultTheme, this.resultFormat, this.resultHighResWebviews);
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
