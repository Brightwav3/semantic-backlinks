'use strict';

var obsidian = require('obsidian');

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    ollamaUrl:             'http://localhost:11434',
    embeddingModel:        'bge-m3',
    similarityThreshold:   0.35,
    maxSuggestions:        10,
    relatedNotesCount:     12,
    minWordLength:         2,
    minSemanticLength:     4,
    reindexDebounceMs:     12000,
    enableInlineSuggest:   true,
    enableRelatedPanel:    true,
    showLexicalBadge:      true,
};

const VIEW_TYPE_RELATED = 'semantic-related-notes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkText(text, size = 3500, overlap = 400) {
    if (text.length <= size) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + size));
        if (start + size >= text.length) break;
        start += size - overlap;
    }
    return chunks;
}

function poolEmbeddings(embeddings) {
    if (embeddings.length === 1) return embeddings[0];
    const dim = embeddings[0].length;
    const out = new Array(dim).fill(0);
    for (const emb of embeddings)
        for (let i = 0; i < dim; i++) out[i] += emb[i];
    for (let i = 0; i < dim; i++) out[i] /= embeddings.length;
    return out;
}

function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
}

// ─── Embeddings Manager ───────────────────────────────────────────────────────

class EmbeddingsManager {
    constructor(plugin) {
        this.plugin   = plugin;
        this.index    = {};
        this.indexing = false;
        this._active  = 0;
        this._maxConcurrent = 3;
        this._queue   = [];
    }

    get settings() { return this.plugin.settings; }

    async load() {
        const data = await this.plugin.loadData();
        this.index = data?.embeddings ?? {};
    }

    async save() {
        const data = (await this.plugin.loadData()) ?? {};
        await this.plugin.saveData({ ...data, embeddings: this.index });
    }

    // Semaphore: limits concurrent Ollama requests so sync floods don't choke the API.
    _acquire() {
        if (this._active < this._maxConcurrent) {
            this._active++;
            return Promise.resolve();
        }
        return new Promise(resolve => this._queue.push(resolve));
    }

    _release() {
        this._active--;
        if (this._queue.length > 0) {
            this._active++;
            this._queue.shift()();
        }
    }

    async getEmbedding(text) {
        const { ollamaUrl, embeddingModel } = this.settings;
        const chunks = chunkText(text);
        await this._acquire();
        try {
            const res = await fetch(`${ollamaUrl}/api/embed`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ model: embeddingModel, input: chunks }),
            });
            if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
            const json = await res.json();
            return poolEmbeddings(json.embeddings);
        } finally {
            this._release();
        }
    }

    async indexFile(file) {
        try {
            const content   = await this.plugin.app.vault.cachedRead(file);
            const embedding = await this.getEmbedding(`${file.basename}\n${content}`);
            this.index[file.path] = { mtime: file.stat.mtime, title: file.basename, embedding };
            return true;
        } catch (e) {
            console.warn(`[semantic-backlinks] index failed: ${file.path}`, e.message);
            return false;
        }
    }

    async indexVault(onProgress) {
        if (this.indexing) return 0;
        this.indexing = true;
        const files   = this.plugin.app.vault.getMarkdownFiles();
        let changed   = 0;

        for (let i = 0; i < files.length; i++) {
            const file   = files[i];
            const cached = this.index[file.path];
            if (cached?.mtime === file.stat.mtime) continue;
            if (await this.indexFile(file)) changed++;
            onProgress?.(i + 1, files.length, file.basename);
        }

        const paths = new Set(files.map(f => f.path));
        for (const p of Object.keys(this.index)) {
            if (!paths.has(p)) delete this.index[p];
        }

        if (changed > 0) await this.save();
        this.indexing = false;
        return changed;
    }

    async search(query, topK, excludePath = null) {
        const queryEmb = await this.getEmbedding(query);
        const results  = [];

        for (const [path, entry] of Object.entries(this.index)) {
            if (path === excludePath) continue;
            results.push({ path, title: entry.title, score: cosineSimilarity(queryEmb, entry.embedding) });
        }

        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .filter(r => r.score >= this.settings.similarityThreshold);
    }

    get indexedCount() { return Object.keys(this.index).length; }
}

// ─── Related Notes View ───────────────────────────────────────────────────────

class RelatedNotesView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin      = plugin;
        this.currentFile = null;
        this.loading     = false;
    }

    getViewType()    { return VIEW_TYPE_RELATED; }
    getDisplayText() { return 'Related Notes'; }
    getIcon()        { return 'brain-circuit'; }

    async onOpen() {
        this.renderPlaceholder('Open a note to see semantically related notes.');
        const active = this.plugin.app.workspace.getActiveFile();
        if (active) this.update(active);
    }

    renderPlaceholder(msg) {
        this.contentEl.empty();
        this.contentEl.addClass('semantic-view');
        this.contentEl.createEl('p', { text: msg, cls: 'semantic-placeholder' });
    }

    async update(file) {
        if (!file || this.loading || this.currentFile?.path === file.path) return;
        this.currentFile = file;
        this.loading     = true;

        const el = this.contentEl;
        el.empty();
        el.addClass('semantic-view');
        el.createEl('div', { cls: 'semantic-status' })
          .createEl('span', { text: '⟳  Searching for related notes…', cls: 'semantic-status-text' });

        try {
            const content = await this.plugin.app.vault.cachedRead(file);
            const results = await this.plugin.embeddings.search(
                `${file.basename}\n${content}`,
                this.plugin.settings.relatedNotesCount,
                file.path
            );
            this.renderResults(results, file);
        } catch (e) {
            el.empty();
            el.createEl('p', {
                text: `⚠ Cannot reach Ollama: ${e.message}`,
                cls: 'semantic-placeholder',
            });
        } finally {
            this.loading = false;
        }
    }

    renderResults(results, file) {
        const el = this.contentEl;
        el.empty();
        el.addClass('semantic-view');

        const header = el.createEl('div', { cls: 'semantic-header' });
        header.createEl('span', { text: 'Related Notes',  cls: 'semantic-header-title' });
        header.createEl('span', { text: file.basename,    cls: 'semantic-header-sub' });

        if (results.length === 0) {
            el.createEl('p', { text: 'No related notes found.', cls: 'semantic-placeholder' });
            return;
        }

        const list = el.createEl('div', { cls: 'semantic-list' });
        for (const r of results) {
            const pct      = Math.round(r.score * 100);
            const barColor = pct >= 70 ? 'var(--color-green)' : pct >= 50 ? 'var(--color-yellow)' : 'var(--color-base-50)';
            const item     = list.createEl('div', { cls: 'semantic-item' });

            const bar = item.createEl('div', { cls: 'semantic-bar' });
            bar.style.setProperty('--bar-width',  `${pct}%`);
            bar.style.setProperty('--bar-color',  barColor);

            const info = item.createEl('div', { cls: 'semantic-info' });
            const link = info.createEl('a', { text: r.title, cls: 'semantic-link internal-link' });
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const f = this.plugin.app.vault.getAbstractFileByPath(r.path);
                if (f instanceof obsidian.TFile)
                    this.plugin.app.workspace.getLeaf(e.ctrlKey || e.metaKey).openFile(f);
            });
            info.createEl('span', { text: `${pct}%`, cls: 'semantic-score' });
        }
    }

    forceUpdate(file) { this.currentFile = null; this.update(file); }
}

// ─── Editor Suggest ───────────────────────────────────────────────────────────

class SemanticSuggest extends obsidian.EditorSuggest {
    constructor(plugin) {
        super(plugin.app);
        this.plugin         = plugin;
        this._semanticCache = new Map();
        this._prefetchTimer = null;
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            { command: '↵',  purpose: 'insert link' },
            { command: 'esc', purpose: 'dismiss' },
        ]);
    }

    get settings() { return this.plugin.settings; }

    onTrigger(cursor, editor) {
        if (!this.settings.enableInlineSuggest) return null;

        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        if (/\[\[[^\]]*$/.test(before)) return null;

        const match = before.match(/[a-záčďéěíňóřšťúůýžA-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9]{2,}$/);
        if (!match || match[0].length < this.settings.minWordLength) return null;

        const word = match[0];
        if (word.length >= this.settings.minSemanticLength) this._prefetch(word);

        return {
            start: { line: cursor.line, ch: cursor.ch - word.length },
            end:   cursor,
            query: word,
        };
    }

    _searchLexical(query, excludePath) {
        const q       = query.toLowerCase();
        const results = [];

        for (const f of this.plugin.app.vault.getMarkdownFiles()) {
            if (f.path === excludePath) continue;
            const t = f.basename.toLowerCase();

            if      (t === q)             results.push({ path: f.path, title: f.basename, score: 1.00, type: 'exact' });
            else if (t.startsWith(q))     results.push({ path: f.path, title: f.basename, score: 0.95, type: 'prefix' });
            else if (t.includes(q))       results.push({ path: f.path, title: f.basename, score: 0.85, type: 'contains' });
            else if (t.split(/[\s\-_]+/).some(w => w.startsWith(q)))
                                          results.push({ path: f.path, title: f.basename, score: 0.75, type: 'word' });
        }

        return results.sort((a, b) => b.score - a.score);
    }

    _prefetch(query) {
        if (this._semanticCache.has(query) || this.plugin.embeddings.indexedCount === 0) return;
        clearTimeout(this._prefetchTimer);
        this._prefetchTimer = setTimeout(async () => {
            try {
                const path    = this.plugin.app.workspace.getActiveFile()?.path;
                const results = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
                this._semanticCache.set(query, results);
                if (this._semanticCache.size > 50) this._semanticCache.delete(this._semanticCache.keys().next().value);
            } catch {}
        }, 150);
    }

    async getSuggestions(context) {
        const { query } = context;
        if (query.length < this.settings.minWordLength) return [];

        const path    = this.plugin.app.workspace.getActiveFile()?.path;
        const lexical = this._searchLexical(query, path);

        let semantic = [];
        if (query.length >= this.settings.minSemanticLength && this.plugin.embeddings.indexedCount > 0) {
            if (this._semanticCache.has(query)) {
                semantic = this._semanticCache.get(query);
            } else {
                try {
                    semantic = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
                    this._semanticCache.set(query, semantic);
                } catch {}
            }
        }

        const seen   = new Set(lexical.map(r => r.path));
        const merged = [...lexical, ...semantic.filter(r => !seen.has(r.path))];
        return merged.slice(0, this.settings.maxSuggestions);
    }

    renderSuggestion(result, el) {
        el.addClass('semantic-suggest-item');
        el.createEl('span', { text: result.title, cls: 'semantic-suggest-title' });

        const isLexical = ['exact', 'prefix', 'contains', 'word'].includes(result.type);
        if (isLexical && this.settings.showLexicalBadge) {
            el.createEl('span', { text: '↗', cls: 'semantic-suggest-badge lexical' });
        } else if (!isLexical) {
            const pct = Math.round(result.score * 100);
            el.createEl('span', {
                text: `~${pct}%`,
                cls:  `semantic-suggest-score ${pct >= 60 ? 'high' : 'low'}`,
            });
        }
    }

    selectSuggestion(result) {
        const ctx = this.context;
        if (!ctx) return;
        ctx.editor.replaceRange(`[[${result.title}]]`, ctx.start, ctx.end);
    }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class SemanticSettingsTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl: el } = this;
        const s  = this.plugin.settings;
        const save = async () => this.plugin.saveSettings();
        el.empty();

        // ── Ollama ──────────────────────────────────────────────────────────
        el.createEl('h3', { text: 'Ollama' });

        new obsidian.Setting(el)
            .setName('Ollama URL')
            .setDesc('Base URL of your Ollama instance. Can be local (http://localhost:11434) or a remote endpoint — e.g. a Tailscale address — which also enables iPad/iPhone use.')
            .addText(t => t
                .setPlaceholder('http://localhost:11434')
                .setValue(s.ollamaUrl)
                .onChange(async v => { s.ollamaUrl = v.trim(); await save(); })
            );

        new obsidian.Setting(el)
            .setName('Embedding model')
            .setDesc('Ollama model used to generate embeddings. Run "ollama list" to see available models.')
            .addText(t => t
                .setPlaceholder('bge-m3')
                .setValue(s.embeddingModel)
                .onChange(async v => { s.embeddingModel = v.trim(); await save(); })
            )
            .addButton(btn => btn
                .setButtonText('Test connection')
                .onClick(async () => {
                    try {
                        await this.plugin.embeddings.getEmbedding('test');
                        new obsidian.Notice('✓ Ollama is reachable and model works.');
                    } catch (e) {
                        new obsidian.Notice(`✗ ${e.message}`);
                    }
                })
            );

        // ── Inline suggest ──────────────────────────────────────────────────
        el.createEl('h3', { text: 'Inline suggest' });

        new obsidian.Setting(el)
            .setName('Enable inline suggest')
            .setDesc('Show link suggestions while you type.')
            .addToggle(t => t.setValue(s.enableInlineSuggest).onChange(async v => { s.enableInlineSuggest = v; await save(); }));

        new obsidian.Setting(el)
            .setName('Show lexical badge (↗)')
            .setDesc('Mark exact/prefix/fuzzy note name matches with an arrow icon.')
            .addToggle(t => t.setValue(s.showLexicalBadge).onChange(async v => { s.showLexicalBadge = v; await save(); }));

        new obsidian.Setting(el)
            .setName('Min word length to trigger')
            .setDesc('Minimum number of characters before the popup appears. (Default: 2)')
            .addSlider(sl => sl
                .setLimits(1, 6, 1)
                .setValue(s.minWordLength)
                .setDynamicTooltip()
                .onChange(async v => { s.minWordLength = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Min word length for semantic search')
            .setDesc('Shorter words use only lexical matching. Longer words also query the embedding model. (Default: 4)')
            .addSlider(sl => sl
                .setLimits(2, 8, 1)
                .setValue(s.minSemanticLength)
                .setDynamicTooltip()
                .onChange(async v => { s.minSemanticLength = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Max suggestions')
            .setDesc('Maximum number of items shown in the popup. (Default: 10)')
            .addSlider(sl => sl
                .setLimits(3, 20, 1)
                .setValue(s.maxSuggestions)
                .setDynamicTooltip()
                .onChange(async v => { s.maxSuggestions = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Similarity threshold')
            .setDesc('Minimum cosine similarity (0–1) for a semantic result to appear. Lower = more results, higher = stricter. (Default: 0.35)')
            .addSlider(sl => sl
                .setLimits(0.1, 0.9, 0.05)
                .setValue(s.similarityThreshold)
                .setDynamicTooltip()
                .onChange(async v => { s.similarityThreshold = v; await save(); })
            );

        // ── Related Notes panel ─────────────────────────────────────────────
        el.createEl('h3', { text: 'Related Notes panel' });

        new obsidian.Setting(el)
            .setName('Enable Related Notes panel')
            .setDesc('Show a sidebar panel with semantically related notes for the open file.')
            .addToggle(t => t.setValue(s.enableRelatedPanel).onChange(async v => { s.enableRelatedPanel = v; await save(); }));

        new obsidian.Setting(el)
            .setName('Related notes count')
            .setDesc('How many related notes to show in the panel. (Default: 12)')
            .addSlider(sl => sl
                .setLimits(3, 30, 1)
                .setValue(s.relatedNotesCount)
                .setDynamicTooltip()
                .onChange(async v => { s.relatedNotesCount = v; await save(); })
            );

        // ── Index ───────────────────────────────────────────────────────────
        el.createEl('h3', { text: 'Index' });

        new obsidian.Setting(el)
            .setName('Auto-reindex delay (seconds)')
            .setDesc('How long after you stop editing a note before it is re-indexed. (Default: 12s)')
            .addSlider(sl => sl
                .setLimits(5, 60, 1)
                .setValue(s.reindexDebounceMs / 1000)
                .setDynamicTooltip()
                .onChange(async v => { s.reindexDebounceMs = v * 1000; await save(); })
            );

        new obsidian.Setting(el)
            .setName(`Indexed notes: ${this.plugin.embeddings.indexedCount}`)
            .addButton(btn => btn
                .setButtonText('Re-index vault')
                .onClick(async () => {
                    btn.setButtonText('Indexing…');
                    btn.setDisabled(true);
                    const n = await this.plugin.embeddings.indexVault();
                    new obsidian.Notice(`Indexed ${n} notes.`);
                    btn.setButtonText('Re-index vault');
                    btn.setDisabled(false);
                    this.display();
                })
            )
            .addButton(btn => btn
                .setButtonText('Clear index')
                .setWarning()
                .onClick(async () => {
                    this.plugin.embeddings.index = {};
                    await this.plugin.embeddings.save();
                    new obsidian.Notice('Index cleared.');
                    this.display();
                })
            );
    }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

class SemanticBacklinksPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();

        this.embeddings   = new EmbeddingsManager(this);
        this.modifyTimers = new Map();
        await this.embeddings.load();

        this.registerView(
            VIEW_TYPE_RELATED,
            (leaf) => (this.relatedView = new RelatedNotesView(leaf, this))
        );

        this.registerEditorSuggest(new SemanticSuggest(this));
        this.addSettingTab(new SemanticSettingsTab(this.app, this));
        this.addRibbonIcon('brain-circuit', 'Semantic Backlinks', () => this.activateView());

        this.addCommand({
            id:       'show-related-notes',
            name:     'Show related notes panel',
            callback: () => this.activateView(),
        });

        this.addCommand({
            id:       'reindex-vault',
            name:     'Re-index vault',
            callback: async () => {
                const notice = new obsidian.Notice('Indexing vault…', 0);
                const n = await this.embeddings.indexVault((done, total, name) => {
                    notice.setMessage(`Indexing… ${done}/${total}: ${name}`);
                });
                notice.hide();
                new obsidian.Notice(`Indexed ${n} notes.`);
            },
        });

        this.addCommand({
            id:       'refresh-related',
            name:     'Refresh related notes for current file',
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file && this.relatedView) this.relatedView.forceUpdate(file);
            },
        });

        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file && this.relatedView && this.settings.enableRelatedPanel)
                this.relatedView.update(file);
        }));

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (!(file instanceof obsidian.TFile) || file.extension !== 'md') return;
            clearTimeout(this.modifyTimers.get(file.path));
            this.modifyTimers.set(file.path, setTimeout(async () => {
                this.modifyTimers.delete(file.path);
                await this.embeddings.indexFile(file);
                await this.embeddings.save();
                const active = this.app.workspace.getActiveFile();
                if (this.relatedView && active?.path === file.path)
                    this.relatedView.forceUpdate(file);
            }, this.settings.reindexDebounceMs));
        }));

        this.registerEvent(this.app.vault.on('create', async (file) => {
            if (file instanceof obsidian.TFile && file.extension === 'md') {
                await this.embeddings.indexFile(file);
                await this.embeddings.save();
            }
        }));

        this.registerEvent(this.app.vault.on('delete', async (file) => {
            if (file instanceof obsidian.TFile) {
                delete this.embeddings.index[file.path];
                await this.embeddings.save();
            }
        }));

        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof obsidian.TFile && file.extension === 'md' && this.embeddings.index[oldPath]) {
                this.embeddings.index[file.path] = { ...this.embeddings.index[oldPath], title: file.basename };
                delete this.embeddings.index[oldPath];
                await this.embeddings.save();
            }
        }));

        setTimeout(async () => {
            const unindexed = this.app.vault.getMarkdownFiles().filter(f => !this.embeddings.index[f.path]);
            if (unindexed.length > 0) {
                new obsidian.Notice(`Semantic Backlinks: indexing ${unindexed.length} new notes…`);
                await this.embeddings.indexVault();
                new obsidian.Notice('Semantic Backlinks: index ready.');
            }
        }, 5000);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_RELATED)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_RELATED, active: true });
        }
        workspace.revealLeaf(leaf);
        const active = workspace.getActiveFile();
        if (active && this.relatedView) this.relatedView.forceUpdate(active);
    }

    async loadSettings() {
        const data = (await this.loadData()) ?? {};
        const { embeddings, ...rest } = data;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
    }

    async saveSettings() {
        const data = (await this.loadData()) ?? {};
        await this.saveData({ ...data, ...this.settings });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_RELATED);
        for (const t of this.modifyTimers.values()) clearTimeout(t);
    }
}

module.exports = SemanticBacklinksPlugin;
