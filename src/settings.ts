import { App, PluginSettingTab, Setting } from 'obsidian';
import CanvasToPdfPlugin from './main';
import { VectorPdfSettings, DEFAULT_SETTINGS } from './types';

export class VectorPdfSettingTab extends PluginSettingTab {
    plugin: CanvasToPdfPlugin;

    constructor(app: App, plugin: CanvasToPdfPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Default export path')
            .setDesc('Where to save PDFs by default (e.g. Exports/). Leave blank for vault root.')
            .addText(text => text
                .setPlaceholder('Exports/')
                .setValue(this.plugin.settings.defaultExportPath)
                .onChange(async (value) => {
                    this.plugin.settings.defaultExportPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Browser executable path')
            .setDesc('Path to Google Chrome or Microsoft Edge. Leave blank to auto-detect.')
            .addText(text => text
                .setPlaceholder('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
                .setValue(this.plugin.settings.browserPath || '')
                .onChange(async (value) => {
                    this.plugin.settings.browserPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Open PDF after export')
            .setDesc('Automatically open the generated PDF in your default system viewer')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openAfterExport)
                .onChange(async (value) => {
                    this.plugin.settings.openAfterExport = value;
                    await this.plugin.saveSettings();
                }));
                
        new Setting(containerEl)
            .setName('Show file node labels')
            .setDesc('Display titles on top of images and embedded files in the export')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNodeLabels)
                .onChange(async (value) => {
                    this.plugin.settings.showNodeLabels = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('High resolution web link previews')
            .setDesc('Render embedded web link cards at crisp desktop resolution (may increase export time by ~1.5 seconds per web link)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.highResWebviews)
                .onChange(async (value) => {
                    this.plugin.settings.highResWebviews = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Nested canvas export')
            .setDesc('Render sub-canvases embedded inside your main canvas')
            .addDropdown(dropdown => dropdown
                .addOption('render', 'Render nested canvases (Recommended)')
                .addOption('outline', 'Show card placeholder only')
                .setValue(this.plugin.settings.nestedCanvasMode)
                .onChange(async (value: 'outline' | 'render') => {
                    this.plugin.settings.nestedCanvasMode = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh settings to show/hide depth slider
                }));

        if (this.plugin.settings.nestedCanvasMode === 'render') {
            new Setting(containerEl)
                .setName('Nested canvas depth limit')
                .setDesc('Maximum levels deep to render nested canvases (Default: 3)')
                .addSlider(slider => slider
                    .setLimits(1, 5, 1)
                    .setValue(this.plugin.settings.nestedCanvasMaxDepth)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.nestedCanvasMaxDepth = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
