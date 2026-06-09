'use strict';

import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    ItemView,
    Notice,
    Plugin,
    PluginSettingTab,
    requestUrl,
    Setting,
    TFile,
    WorkspaceLeaf,
} from 'obsidian';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginSettings {
    provider:            'ollama' | 'lmstudio' | 'openai';
    serverUrl:           string;
    apiKey:              string;
    embeddingModel:      string;
    similarityThreshold: number;
    maxSuggestions:      number;
    relatedNotesCount:   number;
    minWordLength:       number;
    minSemanticLength:   number;
    reindexDebounceMs:   number;
    enableInlineSuggest: boolean;
    enableRelatedPanel:  boolean;
    showLexicalBadge:    boolean;
    excludedFolders:     string[];
    // Snippet preview (1.2.0) — requires sentence-level 1-bit index.
    // Toggle enableSnippets then re-index vault; the two show* flags are live.
    enableSnippets:         boolean;
    showSnippetInSuggest:   boolean;
    showSnippetInPanel:     boolean;
}

interface IndexEntry {
    mtime:      number;
    title:      string;
    embeddings: Float32Array[];
}

interface SerializedEntry {
    mtime:      number;
    title:      string;
    embeddings: string[];
}

// Sentence-level 1-bit index (stored in a separate file).
interface SentenceEntry {
    sentence: string;
    bits:     Uint8Array;   // 1-bit quantized embedding, 32× smaller than Float32
}

interface SerializedSentenceEntry {
    s: string;   // sentence text
    b: string;   // base64-encoded Uint8Array of bits
}

interface SearchResult {
    path:     string;
    title:    string;
    score:    number;
    type?:    string;
    snippet?: string;   // best-matching sentence from that note, if available
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: PluginSettings = {
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
    enableSnippets:        false,
    showSnippetInSuggest:  true,
    showSnippetInPanel:    true,
};

const VIEW_TYPE_RELATED = 'semantic-related-notes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExcluded(filePath: string, excludedFolders: string[]): boolean {
    return excludedFolders.some(folder => {
        const f = folder.trim();
        return f && (filePath === f || filePath.startsWith(f + '/'));
    });
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
function encodeEmbedding(floats: Float32Array): string {
    const bytes = new Uint8Array(floats.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function decodeEmbedding(b64: string): Float32Array {
    const s     = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

// ── 1-bit quantization ────────────────────────────────────────────────────────
// Sign-bit quantization: store 1 if dimension > 0, else 0.
// 32× smaller than Float32 (~128 bytes for 1024-dim). Uses Hamming similarity.

function quantizeTo1Bit(floats: Float32Array): Uint8Array {
    const bits = new Uint8Array(Math.ceil(floats.length / 8));
    for (let i = 0; i < floats.length; i++) {
        if (floats[i] > 0) bits[i >> 3] |= (1 << (i & 7));
    }
    return bits;
}

// Hamming similarity in [0, 1]: fraction of bits that agree.
function hammingSimilarity(a: Uint8Array, b: Uint8Array): number {
    let matches = 0;
    for (let i = 0; i < a.length; i++) {
        // Bits that agree = NOT XOR, masked to 8 bits.
        let same = (~(a[i] ^ b[i])) & 0xFF;
        // Popcount via Brian Kernighan.
        same = same - ((same >> 1) & 0x55);
        same = (same & 0x33) + ((same >> 2) & 0x33);
        matches += ((same + (same >> 4)) & 0x0F);
    }
    return matches / (a.length * 8);
}

function encode1Bit(bits: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bits.length; i++) s += String.fromCharCode(bits[i]);
    return btoa(s);
}

function decode1Bit(b64: string): Uint8Array {
    const s     = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

// Split note content into meaningful sentences for snippet indexing.
function splitIntoSentences(text: string): string[] {
    // Strip YAML frontmatter (--- ... ---) before processing.
    const stripped = text.startsWith('---')
        ? text.replace(/^---[\s\S]*?---\n?/, '')
        : text;
    return stripped
        .replace(/\n{2,}/g, ' ')           // collapse blank lines
        .replace(/[#*`>_[\]]/g, '')        // strip markdown syntax
        .replace(/([.!?])\s+/g, '$1\n')   // mark sentence boundaries (no lookbehind — iOS compat)
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length >= 30 && s.length <= 400);
}

// ─── Embed Queue ──────────────────────────────────────────────────────────────

type QueueItem = { fn: () => Promise<number[]>; res: (v: number[]) => void; rej: (e: unknown) => void };

class EmbedQueue {
    private _concurrency: number;
    private _running:     number;
    private _queue:       QueueItem[];

    constructor(concurrency = 2) {
        this._concurrency = concurrency;
        this._running     = 0;
        this._queue       = [];
    }

    run(fn: () => Promise<number[]>): Promise<number[]> {
        return new Promise((res, rej) => {
            this._queue.push({ fn, res, rej });
            this._drain();
        });
    }

    private _drain(): void {
        while (this._running < this._concurrency && this._queue.length) {
            const { fn, res, rej } = this._queue.shift()!;
            this._running++;
            fn().then(res, rej).finally(() => { this._running--; this._drain(); });
        }
    }
}

// ─── Embeddings Manager ───────────────────────────────────────────────────────

class EmbeddingsManager {
    plugin:        SemanticBacklinksPlugin;
    index:         Record<string, IndexEntry>;
    sentenceIndex: Record<string, SentenceEntry[]>;
    indexing:      boolean;
    private _queue: EmbedQueue;

    constructor(plugin: SemanticBacklinksPlugin) {
        this.plugin        = plugin;
        this.index         = {};
        this.sentenceIndex = {};
        this.indexing      = false;
        this._queue        = new EmbedQueue(4);
    }

    get settings(): PluginSettings { return this.plugin.settings; }

    // Embeddings live in a separate file so Remotely Save never syncs them.
    get _indexPath(): string {
        return `${this.plugin.app.vault.configDir}/plugins/semantic-backlinks/embeddings.json`;
    }

    get _sentenceIndexPath(): string {
        return `${this.plugin.app.vault.configDir}/plugins/semantic-backlinks/embeddings-sentences.json`;
    }

    async load(): Promise<void> {
        try {
            const raw    = await this.plugin.app.vault.adapter.read(this._indexPath);
            const parsed = JSON.parse(raw) as Record<string, SerializedEntry & { embedding?: number[] | string }>;
            for (const [path, entry] of Object.entries(parsed)) {
                const embs = entry.embeddings ?? (entry.embedding ? [entry.embedding] : []);
                this.index[path] = {
                    mtime:      entry.mtime,
                    title:      entry.title,
                    embeddings: embs.map((e: string | number[]) =>
                        typeof e === 'string' ? decodeEmbedding(e) : new Float32Array(e)
                    ),
                };
            }
            return;
        } catch { /* file doesn't exist yet */ }

        // Migration: old format stored embeddings inside data.json.
        try {
            const raw = (await this.plugin.loadData()) as Record<string, unknown> | null ?? {};
            const oldEmbeddings = raw['embeddings'];
            if (oldEmbeddings && typeof oldEmbeddings === 'object') {
                const oldIndex = oldEmbeddings as Record<string, SerializedEntry & { embedding?: number[] }>;
                for (const [path, entry] of Object.entries(oldIndex)) {
                    const embs = entry.embeddings ?? (entry.embedding ? [entry.embedding] : []);
                    this.index[path] = {
                        mtime:      entry.mtime,
                        title:      entry.title,
                        embeddings: embs.map((e: string | number[]) => new Float32Array(e as number[])),
                    };
                }
                await this.save();
                delete raw['embeddings'];
                await this.plugin.saveData(raw);
                return;
            }
        } catch { /* no data.json or parse error */ }

        this.index = {};
    }

    async save(): Promise<void> {
        const serializable: Record<string, SerializedEntry> = {};
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

    async loadSentenceIndex(): Promise<void> {
        try {
            const raw    = await this.plugin.app.vault.adapter.read(this._sentenceIndexPath);
            const parsed = JSON.parse(raw) as Record<string, SerializedSentenceEntry[]>;
            for (const [path, entries] of Object.entries(parsed)) {
                this.sentenceIndex[path] = entries.map(e => ({
                    sentence: e.s,
                    bits:     decode1Bit(e.b),
                }));
            }
        } catch { /* file doesn't exist yet — ok */ }
    }

    async saveSentenceIndex(): Promise<void> {
        const serializable: Record<string, SerializedSentenceEntry[]> = {};
        for (const [path, entries] of Object.entries(this.sentenceIndex)) {
            serializable[path] = entries.map(e => ({ s: e.sentence, b: encode1Bit(e.bits) }));
        }
        await this.plugin.app.vault.adapter.write(
            this._sentenceIndexPath,
            JSON.stringify(serializable)
        );
    }

    private async _retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
        for (let i = 0; ; i++) {
            try {
                return await fn();
            } catch (e) {
                // Don't retry 4xx (auth errors, bad requests) or last attempt.
                if (i >= attempts - 1 || /HTTP 4\d\d/.test((e as Error).message)) throw e;
                await new Promise(r => window.setTimeout(r, 300 * 2 ** i));
            }
        }
    }

    private async _fetchEmbedding(text: string): Promise<number[]> {
        const { provider, serverUrl, embeddingModel, apiKey } = this.settings;

        if (provider === 'ollama') {
            const res = await requestUrl({
                url:         `${serverUrl}/api/embed`,
                method:      'POST',
                contentType: 'application/json',
                body:        JSON.stringify({ model: embeddingModel, input: text }),
                throw:       false,
            });
            if (res.status !== 200) throw new Error(`Ollama HTTP ${res.status}`);
            return (res.json as { embeddings: number[][] }).embeddings[0];
        } else {
            // lmstudio and openai share the OpenAI-compatible /v1/embeddings endpoint.
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await requestUrl({
                url:         `${serverUrl}/v1/embeddings`,
                method:      'POST',
                contentType: 'application/json',
                headers,
                body:        JSON.stringify({ model: embeddingModel, input: text }),
                throw:       false,
            });
            if (res.status !== 200) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'LM Studio'} HTTP ${res.status}`);
            return (res.json as { data: [{ embedding: number[] }] }).data[0].embedding;
        }
    }

    async getEmbedding(text: string): Promise<number[]> {
        return this._queue.run(() => this._retry(() => this._fetchEmbedding(text)));
    }

    // Batch variant — sends all texts in a single API request (1 call per note instead of N).
    private async _fetchEmbeddingBatch(texts: string[]): Promise<number[][]> {
        const { provider, serverUrl, embeddingModel, apiKey } = this.settings;

        if (provider === 'ollama') {
            const res = await requestUrl({
                url:         `${serverUrl}/api/embed`,
                method:      'POST',
                contentType: 'application/json',
                body:        JSON.stringify({ model: embeddingModel, input: texts }),
                throw:       false,
            });
            if (res.status !== 200) throw new Error(`Ollama HTTP ${res.status}`);
            return (res.json as { embeddings: number[][] }).embeddings;
        } else {
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await requestUrl({
                url:         `${serverUrl}/v1/embeddings`,
                method:      'POST',
                contentType: 'application/json',
                headers,
                body:        JSON.stringify({ model: embeddingModel, input: texts }),
                throw:       false,
            });
            if (res.status !== 200) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'LM Studio'} HTTP ${res.status}`);
            return (res.json as { data: { embedding: number[] }[] }).data.map(d => d.embedding);
        }
    }

    async getEmbeddingBatch(texts: string[]): Promise<number[][]> {
        return this._retry(() => this._fetchEmbeddingBatch(texts));
    }

    private _chunkText(title: string, content: string): string[] {
        const CHUNK   = 1500;
        const OVERLAP = 300;
        const MAX     = 8;
        const full    = `${title}\n${content}`;
        if (full.length <= CHUNK) return [full];
        const chunks: string[] = [];
        let start = 0;
        while (start < full.length && chunks.length < MAX) {
            chunks.push(full.slice(start, start + CHUNK));
            start += CHUNK - OVERLAP;
        }
        return chunks;
    }

    async indexFile(file: TFile): Promise<boolean> {
        try {
            const content   = await this.plugin.app.vault.cachedRead(file);
            const chunks    = this._chunkText(file.basename, content);
            const sentences = this.settings.enableSnippets
                ? splitIntoSentences(content).slice(0, 20)
                : [];

            // Run note-level and sentence-level embedding in parallel.
            const [raw, sentRaw] = await Promise.all([
                Promise.all(chunks.map(c => this.getEmbedding(c))),
                sentences.length > 0 ? this.getEmbeddingBatch(sentences) : Promise.resolve([] as number[][]),
            ]);

            this.index[file.path] = {
                mtime:      file.stat.mtime,
                title:      file.basename,
                embeddings: raw.map(e => new Float32Array(e)),
            };

            if (this.settings.enableSnippets) {
                if (sentRaw.length > 0) {
                    this.sentenceIndex[file.path] = sentRaw.map((r, i) => ({
                        sentence: sentences[i],
                        bits:     quantizeTo1Bit(new Float32Array(r)),
                    }));
                } else {
                    delete this.sentenceIndex[file.path];
                }
            }

            return true;
        } catch (e) {
            console.warn(`[semantic-backlinks] index failed: ${file.path}`, (e as Error).message);
            return false;
        }
    }

    async indexVault(onProgress?: (done: number, total: number, name: string) => void): Promise<number> {
        if (this.indexing) return 0;
        this.indexing = true;
        const files   = this.plugin.app.vault.getMarkdownFiles();
        let changed   = 0;

        for (let i = 0; i < files.length; i++) {
            const file   = files[i];
            if (isExcluded(file.path, this.settings.excludedFolders)) continue;
            const cached = this.index[file.path];
            if (cached?.mtime === file.stat.mtime && Array.isArray(cached?.embeddings)) continue;
            if (await this.indexFile(file)) changed++;
            onProgress?.(i + 1, files.length, file.basename);
        }

        const paths = new Set(files.map(f => f.path));
        for (const p of Object.keys(this.index)) {
            if (!paths.has(p)) delete this.index[p];
        }
        for (const p of Object.keys(this.sentenceIndex)) {
            if (!paths.has(p)) delete this.sentenceIndex[p];
        }

        if (changed > 0) {
            await this.save();
            if (this.settings.enableSnippets) await this.saveSentenceIndex();
        }
        this.indexing = false;
        return changed;
    }

    async search(query: string, topK: number, excludePath: string | null = null): Promise<SearchResult[]> {
        const queryEmb = new Float32Array(await this.getEmbedding(query));
        const results: SearchResult[] = [];

        for (const [path, entry] of Object.entries(this.index)) {
            if (path === excludePath) continue;
            if (!entry.embeddings?.length) continue;
            const score = Math.max(...entry.embeddings.map(e => cosineSimilarity(queryEmb, e)));
            results.push({ path, title: entry.title, score });
        }

        const sorted = results
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .filter(r => r.score >= this.settings.similarityThreshold);

        // Attach snippets via 1-bit Hamming (pure bit ops — negligible cost).
        if (this.settings.enableSnippets && Object.keys(this.sentenceIndex).length > 0) {
            const queryBits = quantizeTo1Bit(queryEmb);
            for (const r of sorted) {
                const s = this._findBestSentence(queryBits, r.path);
                if (s) r.snippet = s;
            }
        }

        return sorted;
    }

    private _findBestSentence(queryBits: Uint8Array, notePath: string): string | null {
        const entries = this.sentenceIndex[notePath];
        if (!entries?.length) return null;
        let bestScore = 0;
        let bestSentence = '';
        for (const entry of entries) {
            const score = hammingSimilarity(queryBits, entry.bits);
            if (score > bestScore) { bestScore = score; bestSentence = entry.sentence; }
        }
        // Only return if meaningfully above chance (random = 0.5 for sign-bit quant).
        return bestScore > 0.55 ? bestSentence : null;
    }

    get indexedCount(): number { return Object.keys(this.index).length; }
}

// ─── Related Notes View ───────────────────────────────────────────────────────

class RelatedNotesView extends ItemView {
    plugin:      SemanticBacklinksPlugin;
    currentFile: TFile | null;
    private _gen: number;

    constructor(leaf: WorkspaceLeaf, plugin: SemanticBacklinksPlugin) {
        super(leaf);
        this.plugin      = plugin;
        this.currentFile = null;
        this._gen        = 0;
    }

    getViewType():    string { return VIEW_TYPE_RELATED; }
    getDisplayText(): string { return 'Related Notes'; }
    getIcon():        string { return 'brain-circuit'; }

    async onOpen(): Promise<void> {
        this.renderPlaceholder('Open a note to see semantically related notes.');
        const active = this.plugin.app.workspace.getActiveFile();
        if (active) void this.update(active);
    }

    renderPlaceholder(msg: string): void {
        this.contentEl.empty();
        this.contentEl.addClass('semantic-view');
        this.contentEl.createEl('p', { text: msg, cls: 'semantic-placeholder' });
    }

    async update(file: TFile): Promise<void> {
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
                text: `⚠ Cannot reach embedding server: ${(e as Error).message}`,
                cls: 'semantic-placeholder',
            });
        }
    }

    renderResults(results: SearchResult[], file: TFile): void {
        const el = this.contentEl;
        el.empty();
        el.addClass('semantic-view');

        const header = el.createEl('div', { cls: 'semantic-header' });
        header.createEl('span', { text: 'Related Notes', cls: 'semantic-header-title' });
        header.createEl('span', { text: file.basename, cls: 'semantic-header-sub' });

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
            bar.style.setProperty('--bar-width', `${pct}%`);
            bar.style.setProperty('--bar-color', barColor);

            const info = item.createEl('div', { cls: 'semantic-info' });
            const link = info.createEl('a', { text: r.title, cls: 'semantic-link internal-link' });
            link.addEventListener('click', (e: MouseEvent) => {
                e.preventDefault();
                const f = this.plugin.app.vault.getAbstractFileByPath(r.path);
                if (f instanceof TFile)
                    void this.plugin.app.workspace.getLeaf(e.ctrlKey || e.metaKey).openFile(f);
            });
            info.createEl('span', { text: `${pct}%`, cls: 'semantic-score' });

            if (r.snippet && this.plugin.settings.showSnippetInPanel) {
                item.createEl('div', { text: `"${r.snippet}"`, cls: 'semantic-snippet' });
            }
        }
    }

    forceUpdate(file: TFile): void { this.currentFile = null; void this.update(file); }
}

// ─── Editor Suggest ───────────────────────────────────────────────────────────

class SemanticSuggest extends EditorSuggest<SearchResult> {
    plugin:                 SemanticBacklinksPlugin;
    private _semanticCache: Map<string, SearchResult[]>;
    private _prefetchTimer: number | null;

    constructor(plugin: SemanticBacklinksPlugin) {
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

    get settings(): PluginSettings { return this.plugin.settings; }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
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

    private _searchLexical(query: string, excludePath: string | null): SearchResult[] {
        const q       = query.toLowerCase();
        const results: SearchResult[] = [];

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

    private _prefetch(query: string): void {
        if (this._semanticCache.has(query) || this.plugin.embeddings.indexedCount === 0) return;
        if (this._prefetchTimer !== null) window.clearTimeout(this._prefetchTimer);
        this._prefetchTimer = window.setTimeout(() => {
            void (async () => {
                try {
                    const path    = this.plugin.app.workspace.getActiveFile()?.path ?? null;
                    const results = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
                    this._semanticCache.set(query, results);
                    if (this._semanticCache.size > 50)
                        this._semanticCache.delete(this._semanticCache.keys().next().value as string);
                } catch { /* ignore */ }
            })();
        }, 150);
    }

    async getSuggestions(context: EditorSuggestContext): Promise<SearchResult[]> {
        const { query } = context;
        if (query.length < this.settings.minWordLength) return [];

        const path    = this.plugin.app.workspace.getActiveFile()?.path ?? null;
        const lexical = this._searchLexical(query, path);

        let semantic: SearchResult[] = [];
        if (query.length >= this.settings.minSemanticLength && this.plugin.embeddings.indexedCount > 0) {
            if (this._semanticCache.has(query)) {
                semantic = this._semanticCache.get(query)!;
                // LRU: move to end so frequently-used entries aren't evicted first.
                this._semanticCache.delete(query);
                this._semanticCache.set(query, semantic);
            } else {
                try {
                    semantic = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
                    this._semanticCache.set(query, semantic);
                    if (this._semanticCache.size > 50)
                        this._semanticCache.delete(this._semanticCache.keys().next().value as string);
                } catch { /* ignore */ }
            }
        }

        const seen   = new Set(lexical.map(r => r.path));
        const merged = [...lexical, ...semantic.filter(r => !seen.has(r.path))];
        return merged.slice(0, this.settings.maxSuggestions);
    }

    renderSuggestion(result: SearchResult, el: HTMLElement): void {
        el.addClass('semantic-suggest-item');

        const row = el.createEl('div', { cls: 'semantic-suggest-row' });
        row.createEl('span', { text: result.title, cls: 'semantic-suggest-title' });

        const isLexical = ['exact', 'prefix', 'contains', 'word'].includes(result.type ?? '');
        if (isLexical && this.settings.showLexicalBadge) {
            row.createEl('span', { text: '↗', cls: 'semantic-suggest-badge lexical' });
        } else if (!isLexical) {
            const pct = Math.round(result.score * 100);
            row.createEl('span', {
                text: `~${pct}%`,
                cls:  `semantic-suggest-score ${pct >= 60 ? 'high' : 'low'}`,
            });
        }

        if (result.snippet && this.settings.showSnippetInSuggest) {
            el.createEl('div', { text: result.snippet, cls: 'semantic-suggest-snippet' });
        }
    }

    selectSuggestion(result: SearchResult): void {
        const ctx = this.context;
        if (!ctx) return;
        const isLexical = ['exact', 'prefix', 'contains', 'word'].includes(result.type ?? '');
        const alias = !isLexical && ctx.query.toLowerCase() !== result.title.toLowerCase() ? `|${ctx.query}` : '';
        ctx.editor.replaceRange(`[[${result.title}${alias}]] `, ctx.start, ctx.end);
    }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class SemanticSettingsTab extends PluginSettingTab {
    plugin: SemanticBacklinksPlugin;

    constructor(app: App, plugin: SemanticBacklinksPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl: el } = this;
        const s    = this.plugin.settings;
        const save = async () => this.plugin.saveSettings();
        el.empty();

        // ── Embedding provider ──────────────────────────────────────────────
        new Setting(el).setName('Embedding provider').setHeading();

        new Setting(el)
            .setName('Provider')
            .setDesc('Embedding backend. Ollama and LM Studio run locally; OpenAI (API) sends text to the remote API.')
            .addDropdown(d => d
                .addOption('ollama',   'Ollama')
                .addOption('lmstudio', 'LM Studio')
                .addOption('openai',   'OpenAI (API)')
                .setValue(s.provider)
                .onChange(async (v: string) => {
                    s.provider = v as PluginSettings['provider'];
                    await save();
                    providerEl.empty();
                    renderProviderFields(providerEl);
                })
            );

        const providerEl = el.createDiv();

        const renderProviderFields = (container: HTMLElement) => {
            const urlDesc = s.provider === 'openai'
                ? 'OpenAI API base URL. Change to use Azure OpenAI or another compatible endpoint.'
                : 'Base URL of your Ollama or LM Studio instance. For mobile, enter your Tailscale IP (e.g. http://100.x.x.x:11434).';
            new Setting(container)
                .setName('Server URL')
                .setDesc(urlDesc)
                .addText(t => t
                    .setPlaceholder(s.provider === 'openai' ? 'https://api.openai.com' : 'http://localhost:11434')
                    .setValue(s.serverUrl)
                    .onChange(async (v: string) => { s.serverUrl = v.trim(); await save(); })
                );

            if (s.provider === 'openai') {
                new Setting(container)
                    .setName('API key')
                    .setDesc('Your OpenAI API key (sk-…). Stored locally in data.json, never synced.')
                    .addText(t => {
                        t.inputEl.type = 'password';
                        t.setPlaceholder('sk-…')
                         .setValue(s.apiKey)
                         .onChange(async (v: string) => { s.apiKey = v.trim(); await save(); });
                    });
            }

            const modelDesc = s.provider === 'openai'
                ? 'OpenAI embedding model (e.g. text-embedding-3-small, text-embedding-3-large).'
                : 'Model used to generate embeddings. Run "ollama list" to see installed models.';
            new Setting(container)
                .setName('Embedding model')
                .setDesc(modelDesc)
                .addText(t => t
                    .setPlaceholder(s.provider === 'openai' ? 'text-embedding-3-small' : 'bge-m3')
                    .setValue(s.embeddingModel)
                    .onChange(async (v: string) => { s.embeddingModel = v.trim(); await save(); })
                )
                .addButton(btn => btn
                    .setButtonText('Test connection')
                    .onClick(async () => {
                        try {
                            await this.plugin.embeddings.getEmbedding('test');
                            new Notice('✓ Connection works.');
                        } catch (e) {
                            new Notice(`✗ ${(e as Error).message}`);
                        }
                    })
                );
        };

        renderProviderFields(providerEl);

        // ── Inline suggest ──────────────────────────────────────────────────
        new Setting(el).setName('Inline suggest').setHeading();

        new Setting(el)
            .setName('Enable inline suggest')
            .setDesc('Show link suggestions while you type.')
            .addToggle(t => t.setValue(s.enableInlineSuggest).onChange(async (v: boolean) => { s.enableInlineSuggest = v; await save(); }));

        new Setting(el)
            .setName('Show lexical badge (↗)')
            .setDesc('Mark exact/prefix/fuzzy note name matches with an arrow icon.')
            .addToggle(t => t.setValue(s.showLexicalBadge).onChange(async (v: boolean) => { s.showLexicalBadge = v; await save(); }));

        new Setting(el)
            .setName('Min word length to trigger')
            .setDesc('Minimum characters before the popup appears. (Default: 2)')
            .addSlider(sl => sl
                .setLimits(1, 6, 1)
                .setValue(s.minWordLength)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.minWordLength = v; await save(); })
            );

        new Setting(el)
            .setName('Min word length for semantic search')
            .setDesc('Shorter words use only lexical matching. (Default: 4)')
            .addSlider(sl => sl
                .setLimits(2, 8, 1)
                .setValue(s.minSemanticLength)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.minSemanticLength = v; await save(); })
            );

        new Setting(el)
            .setName('Max suggestions')
            .setDesc('Maximum items shown in the popup. (Default: 10)')
            .addSlider(sl => sl
                .setLimits(3, 20, 1)
                .setValue(s.maxSuggestions)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.maxSuggestions = v; await save(); })
            );

        new Setting(el)
            .setName('Similarity threshold')
            .setDesc('Minimum cosine similarity (0–1) to show a semantic result. (Default: 0.35)')
            .addSlider(sl => sl
                .setLimits(0.1, 0.9, 0.05)
                .setValue(s.similarityThreshold)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.similarityThreshold = v; await save(); })
            );

        // ── Related Notes panel ─────────────────────────────────────────────
        new Setting(el).setName('Related Notes panel').setHeading();

        new Setting(el)
            .setName('Enable Related Notes panel')
            .setDesc('Show a sidebar panel with semantically related notes for the open file.')
            .addToggle(t => t.setValue(s.enableRelatedPanel).onChange(async (v: boolean) => { s.enableRelatedPanel = v; await save(); }));

        new Setting(el)
            .setName('Related notes count')
            .setDesc('How many related notes to show in the panel. (Default: 12)')
            .addSlider(sl => sl
                .setLimits(3, 30, 1)
                .setValue(s.relatedNotesCount)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.relatedNotesCount = v; await save(); })
            );

        // ── Snippet preview ─────────────────────────────────────────────────
        new Setting(el).setName('Snippet preview').setHeading();

        new Setting(el)
            .setName('Enable snippet preview')
            .setDesc('Show the best-matching sentence from each note next to the result. Uses a 1-bit sentence index (~same storage as the current note index). Requires a vault re-index after toggling.')
            .addToggle(t => t.setValue(s.enableSnippets).onChange(async (v: boolean) => {
                s.enableSnippets = v;
                await save();
                new Notice('Re-index your vault (Settings → Index → Re-index vault) for snippet changes to take effect.');
            }));

        new Setting(el)
            .setName('Show snippet in inline suggest')
            .setDesc('Display the matching sentence below each suggestion in the typing popup.')
            .addToggle(t => t.setValue(s.showSnippetInSuggest).onChange(async (v: boolean) => { s.showSnippetInSuggest = v; await save(); }));

        new Setting(el)
            .setName('Show snippet in Related Notes panel')
            .setDesc('Display the matching sentence below each note in the sidebar panel.')
            .addToggle(t => t.setValue(s.showSnippetInPanel).onChange(async (v: boolean) => { s.showSnippetInPanel = v; await save(); }));

        // ── Excluded folders ────────────────────────────────────────────────
        new Setting(el).setName('Excluded folders').setHeading();

        new Setting(el)
            .setName('Excluded folders')
            .setDesc('Comma-separated folder paths to skip during indexing and suggestions (e.g. Templates, Archive, Daily Notes).')
            .addTextArea(ta => ta
                .setPlaceholder('Templates, Archive, Daily Notes')
                .setValue(s.excludedFolders.join(', '))
                .onChange(async (v: string) => {
                    s.excludedFolders = v.split(',').map(f => f.trim()).filter(Boolean);
                    await save();
                })
            );

        // ── Index ───────────────────────────────────────────────────────────
        new Setting(el).setName('Index').setHeading();

        new Setting(el)
            .setName('Auto-reindex delay (seconds)')
            .setDesc('How long after you stop editing before a note is re-indexed. (Default: 12s)')
            .addSlider(sl => sl
                .setLimits(5, 60, 1)
                .setValue(s.reindexDebounceMs / 1000)
                .setDynamicTooltip()
                .onChange(async (v: number) => { s.reindexDebounceMs = v * 1000; await save(); })
            );

        const indexedSetting = new Setting(el)
            .setName(`Indexed notes: ${this.plugin.embeddings.indexedCount}`)
            .addButton(btn => btn
                .setButtonText('Re-index vault')
                .onClick(async () => {
                    btn.setButtonText('Indexing…');
                    btn.setDisabled(true);
                    const n = await this.plugin.embeddings.indexVault();
                    new Notice(`Indexed ${n} notes.`);
                    btn.setButtonText('Re-index vault');
                    btn.setDisabled(false);
                    indexedSetting.setName(`Indexed notes: ${this.plugin.embeddings.indexedCount}`);
                })
            )
            .addButton(btn => btn
                .setButtonText('Clear index')
                .onClick(async () => {
                    this.plugin.embeddings.index = {};
                    await this.plugin.embeddings.save();
                    new Notice('Index cleared.');
                    indexedSetting.setName(`Indexed notes: 0`);
                })
            );
    }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class SemanticBacklinksPlugin extends Plugin {
    settings!:   PluginSettings;
    embeddings!: EmbeddingsManager;
    private modifyTimers!: Map<string, number>;

    // Access the view via the workspace rather than storing a reference,
    // to avoid the memory leak flagged by the Obsidian linter.
    get relatedView(): RelatedNotesView | undefined {
        return this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED)[0]?.view as RelatedNotesView | undefined;
    }

    async onload(): Promise<void> {
        await this.loadSettings();

        this.embeddings   = new EmbeddingsManager(this);
        this.modifyTimers = new Map();
        await this.embeddings.load();
        if (this.settings.enableSnippets) await this.embeddings.loadSentenceIndex();

        this.registerView(
            VIEW_TYPE_RELATED,
            (leaf) => new RelatedNotesView(leaf, this)
        );

        this.registerEditorSuggest(new SemanticSuggest(this));
        this.addSettingTab(new SemanticSettingsTab(this.app, this));
        this.addRibbonIcon('brain-circuit', 'Semantic Backlinks', () => { void this.activateView(); });

        this.addCommand({
            id:       'show-related-notes',
            name:     'Show related notes panel',
            callback: () => { void this.activateView(); },
        });

        this.addCommand({
            id:       'reindex-vault',
            name:     'Re-index vault',
            callback: async () => {
                const notice = new Notice('Indexing vault…', 0);
                const n = await this.embeddings.indexVault((done, total, name) => {
                    notice.setMessage(`Indexing… ${done}/${total}: ${name}`);
                });
                notice.hide();
                new Notice(`Indexed ${n} notes.`);
            },
        });

        this.addCommand({
            id:       'refresh-related',
            name:     'Refresh related notes for current file',
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file) this.relatedView?.forceUpdate(file);
            },
        });

        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file && this.relatedView && this.settings.enableRelatedPanel)
                void this.relatedView.update(file);
        }));

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            window.clearTimeout(this.modifyTimers.get(file.path));
            this.modifyTimers.set(file.path, window.setTimeout(() => {
                void (async () => {
                    this.modifyTimers.delete(file.path);
                    if (this.embeddings.indexing) return;
                    await this.embeddings.indexFile(file);
                    await this.embeddings.save();
                    if (this.settings.enableSnippets) await this.embeddings.saveSentenceIndex();
                    const active = this.app.workspace.getActiveFile();
                    if (this.relatedView && active?.path === file.path)
                        this.relatedView.forceUpdate(file);
                })();
            }, this.settings.reindexDebounceMs));
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile) {
                delete this.embeddings.index[file.path];
                void this.embeddings.save();
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md' && this.embeddings.index[oldPath]) {
                this.embeddings.index[file.path] = { ...this.embeddings.index[oldPath], title: file.basename };
                delete this.embeddings.index[oldPath];
                void this.embeddings.save();
            }
        }));

        window.setTimeout(() => {
            void (async () => {
                const unindexed = this.app.vault.getMarkdownFiles().filter(f => {
                    if (isExcluded(f.path, this.settings.excludedFolders)) return false;
                    const e = this.embeddings.index[f.path];
                    return !e || !Array.isArray(e.embeddings);
                });
                if (unindexed.length > 0) {
                    const notice = new Notice(`Semantic Backlinks: indexing ${unindexed.length} notes…`, 0);
                    await this.embeddings.indexVault((done, total, name) => {
                        notice.setMessage(`Semantic Backlinks: ${done}/${total} — ${name}`);
                    });
                    notice.hide();
                    new Notice('Semantic Backlinks: index ready.');
                }
            })();
        }, 5000);
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_RELATED)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
        }
        await leaf.setViewState({ type: VIEW_TYPE_RELATED, active: true });
        const active = workspace.getActiveFile();
        if (active) this.relatedView?.forceUpdate(active);
    }

    async loadSettings(): Promise<void> {
        const raw = (await this.loadData()) as Record<string, unknown> | null ?? {};
        delete raw['embeddings'];
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw) as PluginSettings;
    }

    async saveSettings(): Promise<void> {
        await this.saveData({ ...this.settings });
    }

    onunload(): void {
        for (const t of this.modifyTimers.values()) window.clearTimeout(t);
    }
}
