'use strict';

var obsidian = require('obsidian');

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    provider:            'ollama',
    serverUrl:           'http://localhost:11434',
    apiKey:              '',
    embeddingModel:      'bge-m3',
    similarityThreshold:   0.35,
    maxSuggestions:        10,
    relatedNotesCount:     12,
    minWordLength:         2,
    minSemanticLength:     4,
    reindexDebounceMs:     12000,
    enableInlineSuggest:   true,
    enableRelatedPanel:    true,
    showLexicalBadge:      true,
    excludedFolders:       [],
};

const VIEW_TYPE_RELATED = 'semantic-related-notes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExcluded(filePath, excludedFolders) {
    return excludedFolders.some(folder => {
        const f = folder.trim();
        return f && (filePath === f || filePath.startsWith(f + '/'));
    });
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

// Float32Array ↔ base64 — ~7× smaller than JSON text, faster to parse.
function encodeEmbedding(floats) {
    const fa    = floats instanceof Float32Array ? floats : new Float32Array(floats);
    const bytes = new Uint8Array(fa.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function decodeEmbedding(b64) {
    const s     = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

// ─── Embed Queue ──────────────────────────────────────────────────────────────
// Limits concurrent embedding requests so Ollama is never overwhelmed.

class EmbedQueue {
    constructor(concurrency = 2) {
        this._concurrency = concurrency;
        this._running     = 0;
        this._queue       = [];
    }
    run(fn) {
        return new Promise((res, rej) => {
            this._queue.push({ fn, res, rej });
            this._drain();
        });
    }
    _drain() {
        while (this._running < this._concurrency && this._queue.length) {
            const { fn, res, rej } = this._queue.shift();
            this._running++;
            fn().then(res, rej).finally(() => { this._running--; this._drain(); });
        }
    }
}

// ─── Embeddings Manager ───────────────────────────────────────────────────────

class EmbeddingsManager {
    constructor(plugin) {
        this.plugin   = plugin;
        this.index    = {};
        this.indexing = false;
        this._queue   = new EmbedQueue(2);
    }

    get settings() { return this.plugin.settings; }

    // Embeddings live in a separate file so Remotely Save never syncs them.
    // (Remotely Save only syncs data.json / main.js / manifest.json / styles.css
    //  from plugin folders — everything else is skipped.)
    get _indexPath() {
        return `${this.plugin.app.vault.configDir}/plugins/semantic-backlinks/embeddings.json`;
    }

    async load() {
        // 1. Try the dedicated index file first.
        try {
            const raw    = await this.plugin.app.vault.adapter.read(this._indexPath);
            const parsed = JSON.parse(raw);
            for (const [path, entry] of Object.entries(parsed)) {
                // Accept base64 strings (new binary format) or plain float arrays (old JSON format).
                const embs = entry.embeddings ?? (entry.embedding ? [entry.embedding] : []);
                this.index[path] = {
                    mtime:      entry.mtime,
                    title:      entry.title,
                    embeddings: embs.map(e => typeof e === 'string' ? decodeEmbedding(e) : new Float32Array(e)),
                };
            }
            return;
        } catch { /* file doesn't exist yet */ }

        // 2. Migration: old format stored embeddings inside data.json.
        try {
            const data = await this.plugin.loadData();
            if (data?.embeddings) {
                for (const [path, entry] of Object.entries(data.embeddings)) {
                    const embs = entry.embeddings ?? (entry.embedding ? [entry.embedding] : []);
                    this.index[path] = {
                        mtime:      entry.mtime,
                        title:      entry.title,
                        embeddings: embs.map(e => new Float32Array(e)),
                    };
                }
                await this.save();
                const { embeddings, ...rest } = data;
                await this.plugin.saveData(rest);
                return;
            }
        } catch { /* no data.json or parse error */ }

        this.index = {};
    }

    async save() {
        const serializable = {};
        for (const [path, entry] of Object.entries(this.index)) {
            serializable[path] = {
                mtime:      entry.mtime,
                title:      entry.title,
                embeddings: entry.embeddings.map(encodeEmbedding),
            };
        }
        await this.plugin.app.vault.adapter.write(
            this._indexPath,
            JSON.stringify(serializable)
        );
    }

    async _retry(fn, attempts = 3) {
        for (let i = 0; ; i++) {
            try {
                return await fn();
            } catch (e) {
                // Don't retry 4xx (auth errors, bad requests) or last attempt.
                if (i >= attempts - 1 || /HTTP 4\d\d/.test(e.message)) throw e;
                await new Promise(r => setTimeout(r, 300 * 2 ** i));
            }
        }
    }

    // Raw fetch — always goes through the queue via getEmbedding().
    async _fetchEmbedding(text) {
        const { provider, serverUrl, embeddingModel, apiKey } = this.settings;

        if (provider === 'ollama') {
            const res = await fetch(`${serverUrl}/api/embed`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ model: embeddingModel, input: text }),
            });
            if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
            const json = await res.json();
            return json.embeddings[0];
        } else {
            // lmstudio and openai share the OpenAI-compatible /v1/embeddings endpoint.
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await fetch(`${serverUrl}/v1/embeddings`, {
                method:  'POST',
                headers,
                body:    JSON.stringify({ model: embeddingModel, input: text }),
            });
            if (!res.ok) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'LM Studio'} HTTP ${res.status}`);
            const json = await res.json();
            return json.data[0].embedding;
        }
    }

    // Public — serialised through the queue, retried on transient errors.
    async getEmbedding(text) {
        return this._queue.run(() => this._retry(() => this._fetchEmbedding(text)));
    }

    // Split note text into overlapping chunks so long notes aren't truncated.
    _chunkText(title, content) {
        const CHUNK   = 1500;   // chars per chunk
        const OVERLAP = 300;    // chars reused between adjacent chunks
        const MAX     = 8;      // safety cap — avoid runaway API calls
        const full    = `${title}\n${content}`;
        if (full.length <= CHUNK) return [full];
        const chunks = [];
        let start = 0;
        while (start < full.length && chunks.length < MAX) {
            chunks.push(full.slice(start, start + CHUNK));
            start += CHUNK - OVERLAP;
        }
        return chunks;
    }

    async indexFile(file) {
        try {
            const content    = await this.plugin.app.vault.cachedRead(file);
            const chunks     = this._chunkText(file.basename, content);
            const raw        = await Promise.all(chunks.map(c => this.getEmbedding(c)));
            const embeddings = raw.map(e => new Float32Array(e));
            this.index[file.path] = { mtime: file.stat.mtime, title: file.basename, embeddings };
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
            if (isExcluded(file.path, this.settings.excludedFolders)) continue;
            const cached = this.index[file.path];
            // Skip only when mtime matches AND entry is already in the new chunked format.
            if (cached?.mtime === file.stat.mtime && Array.isArray(cached?.embeddings)) continue;
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
        const queryEmb = new Float32Array(await this.getEmbedding(query));
        const results  = [];

        for (const [path, entry] of Object.entries(this.index)) {
            if (path === excludePath) continue;
            if (!entry.embeddings?.length) continue;
            const score = Math.max(...entry.embeddings.map(e => cosineSimilarity(queryEmb, e)));
            results.push({ path, title: entry.title, score });
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
        this._gen        = 0;
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
        if (!file || this.currentFile?.path === file.path) return;
        this.currentFile = file;
        const gen = ++this._gen;

        const el = this.contentEl;
        el.empty();
        el.addClass('semantic-view');
        el.createEl('div', { cls: 'semantic-status' })
          .createEl('span', { text: '⟳  Searching for related notes…', cls: 'semantic-status-text' });

        try {
            const content = await this.plugin.app.vault.cachedRead(file);
            if (gen !== this._gen) return;
            const results = await this.plugin.embeddings.search(
                `${file.basename}\n${content}`,
                this.plugin.settings.relatedNotesCount,
                file.path
            );
            if (gen !== this._gen) return;
            this.renderResults(results, file);
        } catch (e) {
            if (gen !== this._gen) return;
            el.empty();
            el.createEl('p', {
                text: `⚠ Cannot reach embedding server: ${e.message}`,
                cls: 'semantic-placeholder',
            });
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
            if (isExcluded(f.path, this.settings.excludedFolders)) continue;
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
                // LRU: move to end so frequently-used entries aren't evicted first.
                this._semanticCache.delete(query);
                this._semanticCache.set(query, semantic);
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
        const isLexical = ['exact', 'prefix', 'contains', 'word'].includes(result.type);
        const alias = !isLexical && ctx.query.toLowerCase() !== result.title.toLowerCase() ? `|${ctx.query}` : '';
        ctx.editor.replaceRange(`[[${result.title}${alias}]] `, ctx.start, ctx.end);
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
        const s    = this.plugin.settings;
        const save = async () => this.plugin.saveSettings();
        el.empty();

        // ── Embedding provider ──────────────────────────────────────────────
        el.createEl('h3', { text: 'Embedding provider' });

        new obsidian.Setting(el)
            .setName('Provider')
            .setDesc('Embedding backend. Ollama and LM Studio run locally; OpenAI (API) sends text to the remote API.')
            .addDropdown(d => d
                .addOption('ollama',   'Ollama')
                .addOption('lmstudio', 'LM Studio')
                .addOption('openai',   'OpenAI (API)')
                .setValue(s.provider)
                .onChange(async v => { s.provider = v; await save(); this.display(); })
            );

        const urlDesc = s.provider === 'openai'
            ? 'OpenAI API base URL. Change to use Azure OpenAI or another compatible endpoint.'
            : 'Base URL of your Ollama or LM Studio instance. For mobile, enter your Tailscale IP (e.g. http://100.x.x.x:11434).';
        new obsidian.Setting(el)
            .setName('Server URL')
            .setDesc(urlDesc)
            .addText(t => t
                .setPlaceholder(s.provider === 'openai' ? 'https://api.openai.com' : 'http://localhost:11434')
                .setValue(s.serverUrl)
                .onChange(async v => { s.serverUrl = v.trim(); await save(); })
            );

        if (s.provider === 'openai') {
            new obsidian.Setting(el)
                .setName('API key')
                .setDesc('Your OpenAI API key (sk-…). Stored locally in data.json, never synced.')
                .addText(t => {
                    t.inputEl.type = 'password';
                    t.setPlaceholder('sk-…')
                     .setValue(s.apiKey)
                     .onChange(async v => { s.apiKey = v.trim(); await save(); });
                });
        }

        const modelDesc = s.provider === 'openai'
            ? 'OpenAI embedding model (e.g. text-embedding-3-small, text-embedding-3-large).'
            : 'Model used to generate embeddings. Run "ollama list" to see installed models.';
        new obsidian.Setting(el)
            .setName('Embedding model')
            .setDesc(modelDesc)
            .addText(t => t
                .setPlaceholder(s.provider === 'openai' ? 'text-embedding-3-small' : 'bge-m3')
                .setValue(s.embeddingModel)
                .onChange(async v => { s.embeddingModel = v.trim(); await save(); })
            )
            .addButton(btn => btn
                .setButtonText('Test connection')
                .onClick(async () => {
                    try {
                        await this.plugin.embeddings.getEmbedding('test');
                        new obsidian.Notice('✓ Connection works.');
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
            .setDesc('Minimum characters before the popup appears. (Default: 2)')
            .addSlider(sl => sl
                .setLimits(1, 6, 1)
                .setValue(s.minWordLength)
                .setDynamicTooltip()
                .onChange(async v => { s.minWordLength = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Min word length for semantic search')
            .setDesc('Shorter words use only lexical matching. (Default: 4)')
            .addSlider(sl => sl
                .setLimits(2, 8, 1)
                .setValue(s.minSemanticLength)
                .setDynamicTooltip()
                .onChange(async v => { s.minSemanticLength = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Max suggestions')
            .setDesc('Maximum items shown in the popup. (Default: 10)')
            .addSlider(sl => sl
                .setLimits(3, 20, 1)
                .setValue(s.maxSuggestions)
                .setDynamicTooltip()
                .onChange(async v => { s.maxSuggestions = v; await save(); })
            );

        new obsidian.Setting(el)
            .setName('Similarity threshold')
            .setDesc('Minimum cosine similarity (0–1) to show a semantic result. (Default: 0.35)')
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

        // ── Excluded folders ────────────────────────────────────────────────
        el.createEl('h3', { text: 'Excluded folders' });

        new obsidian.Setting(el)
            .setName('Excluded folders')
            .setDesc('Comma-separated folder paths to skip during indexing and suggestions (e.g. Templates, Archive, Daily Notes).')
            .addTextArea(ta => ta
                .setPlaceholder('Templates, Archive, Daily Notes')
                .setValue(s.excludedFolders.join(', '))
                .onChange(async v => {
                    s.excludedFolders = v.split(',').map(f => f.trim()).filter(Boolean);
                    await save();
                })
            );

        // ── Index ───────────────────────────────────────────────────────────
        el.createEl('h3', { text: 'Index' });

        new obsidian.Setting(el)
            .setName('Auto-reindex delay (seconds)')
            .setDesc('How long after you stop editing before a note is re-indexed. (Default: 12s)')
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
                if (this.embeddings.indexing) return; // skip during full vault reindex
                await this.embeddings.indexFile(file);
                await this.embeddings.save();
                const active = this.app.workspace.getActiveFile();
                if (this.relatedView && active?.path === file.path)
                    this.relatedView.forceUpdate(file);
            }, this.settings.reindexDebounceMs));
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
            const unindexed = this.app.vault.getMarkdownFiles().filter(f => {
                if (isExcluded(f.path, this.settings.excludedFolders)) return false;
                const e = this.embeddings.index[f.path];
                return !e || !Array.isArray(e.embeddings);
            });
            if (unindexed.length > 0) {
                const notice = new obsidian.Notice(`Semantic Backlinks: indexing ${unindexed.length} notes…`, 0);
                await this.embeddings.indexVault((done, total, name) => {
                    notice.setMessage(`Semantic Backlinks: ${done}/${total} — ${name}`);
                });
                notice.hide();
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
        await this.saveData({ ...this.settings });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_RELATED);
        for (const t of this.modifyTimers.values()) clearTimeout(t);
    }
}

module.exports = SemanticBacklinksPlugin;
