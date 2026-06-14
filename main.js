const { Plugin, SuggestModal, setIcon, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
    highlightColor: "#ffd700",
    propertyColor: "#a6e22e",
    enableFolderFilters: true,
    maxResults: 40,
    snippetContextSize: 45,
    // Custom Folder Filters
    filter1Shortcut: "/f1", filter1Path: "inbox",
    filter2Shortcut: "/f2", filter2Path: "daily",
    filter3Shortcut: "/f3", filter3Path: "literature",
    filter4Shortcut: "/f4", filter4Path: "projects",
    filter5Shortcut: "/f5", filter5Path: "archive",
};

class QuickSearchModal extends SuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Search your vault... (Use # for headings or custom shortcuts like /f1 for folders)");
        this.modalEl.addClass('quick-search-modal');
        this.loadedFiles = [];
        this.loadVaultContent();
    }

    async loadVaultContent() {
        const allFiles = this.app.vault.getFiles();
        
        const promises = allFiles.map(async (file) => {
            let lowerContent = "";
            let isMarkdown = file.extension.toLowerCase() === 'md';

            // Load real note content into memory
            if (isMarkdown) {
                lowerContent = (await this.app.vault.cachedRead(file)).toLowerCase();
            }

            const pathParts = file.path.split('/');
            const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";

            return {
                file: file,
                lowerContent: lowerContent,
                lowerPath: file.path.toLowerCase(),
                parentFolder: parentFolder,
                isMarkdown: isMarkdown
            };
        });

        this.loadedFiles = await Promise.all(promises);
    }

    getSuggestions(query) {
        let text = query.toLowerCase().trim();
        let targetFolder = null;
        const settings = this.plugin.settings;

        // 1. Process Custom Folder Filters
        if (settings.enableFolderFilters && text.startsWith('/')) {
            const filters = [
                { s: settings.filter1Shortcut, p: settings.filter1Path },
                { s: settings.filter2Shortcut, p: settings.filter2Path },
                { s: settings.filter3Shortcut, p: settings.filter3Path },
                { s: settings.filter4Shortcut, p: settings.filter4Path },
                { s: settings.filter5Shortcut, p: settings.filter5Path }
            ];

            for (let f of filters) {
                if (f.s && f.p && text.startsWith(f.s + ' ')) {
                    targetFolder = f.p.toLowerCase();
                    text = text.substring(f.s.length + 1).trim();
                    break;
                }
            }
        }

        // Empty search handling
        if (!text) {
            let filteredList = this.loadedFiles;
            if (targetFolder) {
                filteredList = filteredList.filter(item => item.lowerPath.includes(targetFolder));
            }
            return filteredList.slice(0, 10).map(item => ({
                isHeading: false, file: item.file, displayTitle: item.file.name, displayFolder: item.parentFolder, searchedTerm: "", lowerContent: item.lowerContent
            }));
        }

        // 2. HEADING MODE (# value)
        if (text.startsWith('#')) {
            const subQuery = text.substring(1).trim();
            if (!subQuery) return [];

            const headingResults = [];
            for (const item of this.loadedFiles) {
                if (targetFolder && !item.lowerPath.includes(targetFolder)) continue;
                if (!item.isMarkdown) continue;

                const cache = this.app.metadataCache.getFileCache(item.file);
                if (cache && cache.headings) {
                    for (const h of cache.headings) {
                        if (h.heading.toLowerCase().includes(subQuery)) {
                            headingResults.push({
                                isHeading: true,
                                file: item.file,
                                displayTitle: h.heading, 
                                displayFolder: item.file.name, 
                                level: h.level,
                                searchedTerm: subQuery
                            });
                        }
                    }
                }
            }
            return headingResults.slice(0, settings.maxResults);
        }

        // 3. NORMAL MODE (Title OR Content Search)
        return this.loadedFiles.filter(item => {
            if (targetFolder && !item.lowerPath.includes(targetFolder)) return false;
            return item.file.name.toLowerCase().includes(text) || (item.lowerContent && item.lowerContent.includes(text));
        }).map(item => ({
            isHeading: false,
            file: item.file,
            displayTitle: item.file.name,
            displayFolder: item.parentFolder,
            searchedTerm: text,
            lowerContent: item.lowerContent
        })).slice(0, settings.maxResults);
    }

    renderSuggestion(item, el) {
        el.empty();
        
        const resultContainer = el.createEl('div', { cls: 'qsearch-result' });
        
        // --- ROW 1: Icon, Title and Folder ---
        const topRow = resultContainer.createEl('div', { cls: 'qsearch-row-top' });
        const titleGroup = topRow.createEl('div', { cls: 'qsearch-left' });
        const iconEl = titleGroup.createEl('div', { cls: 'qsearch-icon' });
        
        if (item.isHeading) {
            iconEl.addClass('qsearch-icon-txt');
            iconEl.setText(`H${item.level}`);
        } else {
            iconEl.removeClass('qsearch-icon-txt');
            const ext = item.file.extension.toLowerCase();
            const iconName = ext === 'md' ? 'file-text' : (ext.match(/(jpg|jpeg|png|gif|svg|webp)/) ? 'image' : 'paperclip');
            setIcon(iconEl, iconName);
        }
        
        const nameEl = titleGroup.createEl('div', { cls: 'qsearch-title' });
        this.highlightKeyword(nameEl, item.displayTitle, item.searchedTerm);

        if (item.displayFolder) {
            topRow.createEl('div', { text: item.displayFolder, cls: 'qsearch-folder' });
        }

        const q = item.searchedTerm;
        if (!q || item.isHeading || !item.lowerContent) return;

        // --- ROW 2: Properties and Body Snippets ---
        const cache = this.app.metadataCache.getFileCache(item.file);
        
        // A. Frontmatter Property
        if (cache && cache.frontmatter) {
            for (const [key, val] of Object.entries(cache.frontmatter)) {
                if (String(val).toLowerCase().includes(q)) {
                    const propRow = resultContainer.createEl('div', { cls: 'qsearch-row-bottom' });
                    propRow.createSpan({ text: key + ": ", cls: 'qsearch-prop-key' });
                    const valSpan = propRow.createSpan();
                    this.highlightKeyword(valSpan, String(val), q);
                    break; 
                }
            }
        }

        // B. Body Snippet (Ignoring YAML properties)
        if (item.lowerContent.includes(q)) {
            let startIdx = 0;
            if (item.lowerContent.startsWith('---')) {
                const endFm = item.lowerContent.indexOf('---', 3);
                if (endFm !== -1) startIdx = endFm + 3;
            }

            const matchIdx = item.lowerContent.indexOf(q, startIdx);
            
            if (matchIdx !== -1) {
                const context = this.plugin.settings.snippetContextSize;
                const start = Math.max(startIdx, matchIdx - context);
                const end = Math.min(item.lowerContent.length, matchIdx + q.length + context);
                
                let snippet = item.lowerContent.substring(start, end).replace(/\n/g, " ").trim();
                if (start > startIdx) snippet = "..." + snippet;
                if (end < item.lowerContent.length) snippet = snippet + "...";

                const bodyRow = resultContainer.createEl('div', { cls: 'qsearch-row-bottom' });
                const textSpan = bodyRow.createSpan();
                this.highlightKeyword(textSpan, snippet, q);
            }
        }
    }

    highlightKeyword(parentElement, fullText, term) {
        if (!term || !fullText) {
            parentElement.createSpan().setText(fullText || "");
            return;
        }

        const lowerText = fullText.toLowerCase();
        let index = lowerText.indexOf(term);
        let currentPos = 0;

        while (index !== -1) {
            if (index > currentPos) {
                parentElement.createSpan().setText(fullText.substring(currentPos, index));
            }

            const markEl = parentElement.createEl('mark', { cls: 'qsearch-highlight' });
            markEl.setText(fullText.substring(index, index + term.length));

            currentPos = index + term.length;
            index = lowerText.indexOf(term, currentPos);
        }

        if (currentPos < fullText.length) {
            parentElement.createSpan().setText(fullText.substring(currentPos));
        }
    }

    onChooseSuggestion(item, evt) {
        this.app.workspace.getLeaf(false).openFile(item.file);
    }
}

class QuickSearchSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Quick Search Settings' });

        new Setting(containerEl)
            .setName('Highlight Color')
            .setDesc('Background color for the matched search terms.')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.highlightColor)
                .onChange(async (value) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateStylesheet();
                }));

        new Setting(containerEl)
            .setName('Property & Heading Color')
            .setDesc('Color for property keys and heading badges (H1, H2) in the results.')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.propertyColor)
                .onChange(async (value) => {
                    this.plugin.settings.propertyColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateStylesheet();
                }));

        new Setting(containerEl)
            .setName('Max Results')
            .setDesc('Maximum number of items displayed in the search list.')
            .addSlider(slider => slider
                .setLimits(10, 100, 5)
                .setValue(this.plugin.settings.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxResults = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Custom Folder Filters' });
        containerEl.createEl('p', { 
            text: 'Define up to 5 custom shortcuts to quickly search inside specific folders. Example: shortcut "/in" for folder "Inbox".',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Enable Folder Filters')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFolderFilters)
                .onChange(async (value) => {
                    this.plugin.settings.enableFolderFilters = value;
                    await this.plugin.saveSettings();
                }));

        const createFilterSetting = (num) => {
            new Setting(containerEl)
                .setName(`Filter ${num}`)
                .addText(text => text
                    .setPlaceholder('Shortcut (e.g. /f1)')
                    .setValue(this.plugin.settings[`filter${num}Shortcut`])
                    .onChange(async (value) => {
                        this.plugin.settings[`filter${num}Shortcut`] = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('Folder name')
                    .setValue(this.plugin.settings[`filter${num}Path`])
                    .onChange(async (value) => {
                        this.plugin.settings[`filter${num}Path`] = value;
                        await this.plugin.saveSettings();
                    }));
        };

        for (let i = 1; i <= 5; i++) {
            createFilterSetting(i);
        }
    }
}

module.exports = class QuickSearchPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new QuickSearchSettingTab(this.app, this));
        this.updateStylesheet();

        this.addCommand({
            id: 'open-quick-search',
            name: 'Open Quick Search',
            callback: () => { new QuickSearchModal(this.app, this).open(); }
        });
    }

    updateStylesheet() {
        if (this.styleElement) this.styleElement.remove();

        const cssRules = `
            .suggestion-item { padding: 8px 12px !important; display: flex !important; }
            .qsearch-result { width: 100% !important; display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .qsearch-row-top { display: flex !important; align-items: center !important; justify-content: space-between !important; width: 100% !important; gap: 12px !important; }
            .qsearch-left { display: flex !important; align-items: center !important; gap: 8px !important; overflow: hidden !important; }
            
            .qsearch-icon { color: var(--text-muted) !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 16px !important; height: 16px !important; flex-shrink: 0 !important; }
            .qsearch-icon svg { width: 100% !important; height: 100% !important; }
            
            .qsearch-icon-txt { font-family: var(--font-monospace) !important; font-size: 10px !important; font-weight: bold !important; color: ${this.settings.propertyColor} !important; background: var(--background-secondary-alt) !important; padding: 1px 4px !important; border-radius: 3px !important; border: 1px solid var(--background-modifier-border) !important; width: auto !important; height: auto !important; }
            
            .qsearch-title { font-weight: 500 !important; font-size: 14px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; color: var(--text-normal) !important; }
            .qsearch-folder { font-size: 11px !important; color: var(--text-muted) !important; background: var(--background-secondary-alt) !important; border: 1px solid var(--background-modifier-border) !important; padding: 2px 6px !important; border-radius: 4px !important; white-space: nowrap !important; flex-shrink: 0 !important; }
            
            .qsearch-row-bottom { font-size: 12.5px !important; color: var(--text-muted) !important; margin-left: 24px !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; display: block !important; width: calc(100% - 24px) !important; opacity: 0.75 !important; margin-top: 1px !important; }
            
            .qsearch-prop-key { color: ${this.settings.propertyColor} !important; font-weight: 600 !important; margin-right: 4px !important; }
            .qsearch-highlight { background-color: ${this.settings.highlightColor} !important; color: #000000 !important; border-radius: 2px !important; padding: 0 2px !important; font-weight: 600 !important; }
        `;

        this.styleElement = document.createElement('style');
        this.styleElement.id = 'css-dynamic-quick-search';
        this.styleElement.textContent = cssRules;
        document.head.appendChild(this.styleElement);
    }

    onunload() {
        if (this.styleElement) this.styleElement.remove();
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
};
