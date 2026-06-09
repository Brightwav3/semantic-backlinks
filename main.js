"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SemanticBacklinksPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  provider: "ollama",
  serverUrl: "http://localhost:11434",
  apiKey: "",
  embeddingModel: "bge-m3",
  similarityThreshold: 0.35,
  maxSuggestions: 10,
  relatedNotesCount: 12,
  minWordLength: 2,
  minSemanticLength: 4,
  reindexDebounceMs: 12e3,
  enableInlineSuggest: true,
  enableRelatedPanel: true,
  showLexicalBadge: true,
  excludedFolders: [],
  enableSnippets: false,
  showSnippetInSuggest: true,
  showSnippetInPanel: true
};
var VIEW_TYPE_RELATED = "semantic-related-notes";
function isExcluded(filePath, excludedFolders) {
  return excludedFolders.some((folder) => {
    const f = folder.trim();
    return f && (filePath === f || filePath.startsWith(f + "/"));
  });
}
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
function encodeEmbedding(floats) {
  const bytes = new Uint8Array(floats.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function decodeEmbedding(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++)
    bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function quantizeTo1Bit(floats) {
  const bits = new Uint8Array(Math.ceil(floats.length / 8));
  for (let i = 0; i < floats.length; i++) {
    if (floats[i] > 0)
      bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}
function hammingSimilarity(a, b) {
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    let same = ~(a[i] ^ b[i]) & 255;
    same = same - (same >> 1 & 85);
    same = (same & 51) + (same >> 2 & 51);
    matches += same + (same >> 4) & 15;
  }
  return matches / (a.length * 8);
}
function encode1Bit(bits) {
  let s = "";
  for (let i = 0; i < bits.length; i++)
    s += String.fromCharCode(bits[i]);
  return btoa(s);
}
function decode1Bit(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++)
    bytes[i] = s.charCodeAt(i);
  return bytes;
}
function splitIntoSentences(text) {
  const stripped = text.startsWith("---") ? text.replace(/^---[\s\S]*?---\n?/, "") : text;
  return stripped.replace(/\n{2,}/g, " ").replace(/[#*`>_[\]]/g, "").replace(/([.!?])\s+/g, "$1\n").split("\n").map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 400);
}
var EmbedQueue = class {
  constructor(concurrency = 2) {
    this._concurrency = concurrency;
    this._running = 0;
    this._queue = [];
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
      fn().then(res, rej).finally(() => {
        this._running--;
        this._drain();
      });
    }
  }
};
var EmbeddingsManager = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.index = {};
    this.sentenceIndex = {};
    this.indexing = false;
    this._queue = new EmbedQueue(4);
  }
  get settings() {
    return this.plugin.settings;
  }
  // Embeddings live in a separate file so Remotely Save never syncs them.
  get _indexPath() {
    return `${this.plugin.app.vault.configDir}/plugins/semantic-backlinks/embeddings.json`;
  }
  get _sentenceIndexPath() {
    return `${this.plugin.app.vault.configDir}/plugins/semantic-backlinks/embeddings-sentences.json`;
  }
  async load() {
    var _a, _b, _c;
    try {
      const raw = await this.plugin.app.vault.adapter.read(this._indexPath);
      const parsed = JSON.parse(raw);
      for (const [path, entry] of Object.entries(parsed)) {
        const embs = (_a = entry.embeddings) != null ? _a : entry.embedding ? [entry.embedding] : [];
        this.index[path] = {
          mtime: entry.mtime,
          title: entry.title,
          embeddings: embs.map(
            (e) => typeof e === "string" ? decodeEmbedding(e) : new Float32Array(e)
          )
        };
      }
      return;
    } catch (e) {
    }
    try {
      const raw = (_b = await this.plugin.loadData()) != null ? _b : {};
      const oldEmbeddings = raw["embeddings"];
      if (oldEmbeddings && typeof oldEmbeddings === "object") {
        const oldIndex = oldEmbeddings;
        for (const [path, entry] of Object.entries(oldIndex)) {
          const embs = (_c = entry.embeddings) != null ? _c : entry.embedding ? [entry.embedding] : [];
          this.index[path] = {
            mtime: entry.mtime,
            title: entry.title,
            embeddings: embs.map((e) => new Float32Array(e))
          };
        }
        await this.save();
        delete raw["embeddings"];
        await this.plugin.saveData(raw);
        return;
      }
    } catch (e) {
    }
    this.index = {};
  }
  async save() {
    const serializable = {};
    for (const [path, entry] of Object.entries(this.index)) {
      serializable[path] = {
        mtime: entry.mtime,
        title: entry.title,
        embeddings: entry.embeddings.map(encodeEmbedding)
      };
    }
    await this.plugin.app.vault.adapter.write(
      this._indexPath,
      JSON.stringify(serializable)
    );
  }
  async loadSentenceIndex() {
    try {
      const raw = await this.plugin.app.vault.adapter.read(this._sentenceIndexPath);
      const parsed = JSON.parse(raw);
      for (const [path, entries] of Object.entries(parsed)) {
        this.sentenceIndex[path] = entries.map((e) => ({
          sentence: e.s,
          bits: decode1Bit(e.b)
        }));
      }
    } catch (e) {
    }
  }
  async saveSentenceIndex() {
    const serializable = {};
    for (const [path, entries] of Object.entries(this.sentenceIndex)) {
      serializable[path] = entries.map((e) => ({ s: e.sentence, b: encode1Bit(e.bits) }));
    }
    await this.plugin.app.vault.adapter.write(
      this._sentenceIndexPath,
      JSON.stringify(serializable)
    );
  }
  async _retry(fn, attempts = 3) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= attempts - 1 || /HTTP 4\d\d/.test(e.message))
          throw e;
        await new Promise((r) => window.setTimeout(r, 300 * 2 ** i));
      }
    }
  }
  async _fetchEmbedding(text) {
    const { provider, serverUrl, embeddingModel, apiKey } = this.settings;
    if (provider === "ollama") {
      const res = await (0, import_obsidian.requestUrl)({
        url: `${serverUrl}/api/embed`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ model: embeddingModel, input: text }),
        throw: false
      });
      if (res.status !== 200)
        throw new Error(`Ollama HTTP ${res.status}`);
      return res.json.embeddings[0];
    } else {
      const headers = {};
      if (apiKey)
        headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await (0, import_obsidian.requestUrl)({
        url: `${serverUrl}/v1/embeddings`,
        method: "POST",
        contentType: "application/json",
        headers,
        body: JSON.stringify({ model: embeddingModel, input: text }),
        throw: false
      });
      if (res.status !== 200)
        throw new Error(`${provider === "openai" ? "OpenAI" : "LM Studio"} HTTP ${res.status}`);
      return res.json.data[0].embedding;
    }
  }
  async getEmbedding(text) {
    return this._queue.run(() => this._retry(() => this._fetchEmbedding(text)));
  }
  // Batch variant — sends all texts in a single API request (1 call per note instead of N).
  async _fetchEmbeddingBatch(texts) {
    const { provider, serverUrl, embeddingModel, apiKey } = this.settings;
    if (provider === "ollama") {
      const res = await (0, import_obsidian.requestUrl)({
        url: `${serverUrl}/api/embed`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ model: embeddingModel, input: texts }),
        throw: false
      });
      if (res.status !== 200)
        throw new Error(`Ollama HTTP ${res.status}`);
      return res.json.embeddings;
    } else {
      const headers = {};
      if (apiKey)
        headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await (0, import_obsidian.requestUrl)({
        url: `${serverUrl}/v1/embeddings`,
        method: "POST",
        contentType: "application/json",
        headers,
        body: JSON.stringify({ model: embeddingModel, input: texts }),
        throw: false
      });
      if (res.status !== 200)
        throw new Error(`${provider === "openai" ? "OpenAI" : "LM Studio"} HTTP ${res.status}`);
      return res.json.data.map((d) => d.embedding);
    }
  }
  async getEmbeddingBatch(texts) {
    return this._retry(() => this._fetchEmbeddingBatch(texts));
  }
  _chunkText(title, content) {
    const CHUNK = 1500;
    const OVERLAP = 300;
    const MAX = 8;
    const full = `${title}
${content}`;
    if (full.length <= CHUNK)
      return [full];
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
      const content = await this.plugin.app.vault.cachedRead(file);
      const chunks = this._chunkText(file.basename, content);
      const sentences = this.settings.enableSnippets ? splitIntoSentences(content).slice(0, 20) : [];
      const [raw, sentRaw] = await Promise.all([
        Promise.all(chunks.map((c) => this.getEmbedding(c))),
        sentences.length > 0 ? this.getEmbeddingBatch(sentences) : Promise.resolve([])
      ]);
      this.index[file.path] = {
        mtime: file.stat.mtime,
        title: file.basename,
        embeddings: raw.map((e) => new Float32Array(e))
      };
      if (this.settings.enableSnippets) {
        if (sentRaw.length > 0) {
          this.sentenceIndex[file.path] = sentRaw.map((r, i) => ({
            sentence: sentences[i],
            bits: quantizeTo1Bit(new Float32Array(r))
          }));
        } else {
          delete this.sentenceIndex[file.path];
        }
      }
      return true;
    } catch (e) {
      console.warn(`[semantic-backlinks] index failed: ${file.path}`, e.message);
      return false;
    }
  }
  async indexVault(onProgress) {
    if (this.indexing)
      return 0;
    this.indexing = true;
    const files = this.plugin.app.vault.getMarkdownFiles();
    let changed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (isExcluded(file.path, this.settings.excludedFolders))
        continue;
      const cached = this.index[file.path];
      if ((cached == null ? void 0 : cached.mtime) === file.stat.mtime && Array.isArray(cached == null ? void 0 : cached.embeddings))
        continue;
      if (await this.indexFile(file))
        changed++;
      onProgress == null ? void 0 : onProgress(i + 1, files.length, file.basename);
    }
    const paths = new Set(files.map((f) => f.path));
    for (const p of Object.keys(this.index)) {
      if (!paths.has(p))
        delete this.index[p];
    }
    for (const p of Object.keys(this.sentenceIndex)) {
      if (!paths.has(p))
        delete this.sentenceIndex[p];
    }
    if (changed > 0) {
      await this.save();
      if (this.settings.enableSnippets)
        await this.saveSentenceIndex();
    }
    this.indexing = false;
    return changed;
  }
  async search(query, topK, excludePath = null) {
    var _a;
    const queryEmb = new Float32Array(await this.getEmbedding(query));
    const results = [];
    for (const [path, entry] of Object.entries(this.index)) {
      if (path === excludePath)
        continue;
      if (!((_a = entry.embeddings) == null ? void 0 : _a.length))
        continue;
      const score = Math.max(...entry.embeddings.map((e) => cosineSimilarity(queryEmb, e)));
      results.push({ path, title: entry.title, score });
    }
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, topK).filter((r) => r.score >= this.settings.similarityThreshold);
    if (this.settings.enableSnippets && Object.keys(this.sentenceIndex).length > 0) {
      const queryBits = quantizeTo1Bit(queryEmb);
      for (const r of sorted) {
        const s = this._findBestSentence(queryBits, r.path);
        if (s)
          r.snippet = s;
      }
    }
    return sorted;
  }
  _findBestSentence(queryBits, notePath) {
    const entries = this.sentenceIndex[notePath];
    if (!(entries == null ? void 0 : entries.length))
      return null;
    let bestScore = 0;
    let bestSentence = "";
    for (const entry of entries) {
      const score = hammingSimilarity(queryBits, entry.bits);
      if (score > bestScore) {
        bestScore = score;
        bestSentence = entry.sentence;
      }
    }
    return bestScore > 0.55 ? bestSentence : null;
  }
  get indexedCount() {
    return Object.keys(this.index).length;
  }
};
var RelatedNotesView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentFile = null;
    this._gen = 0;
  }
  getViewType() {
    return VIEW_TYPE_RELATED;
  }
  getDisplayText() {
    return "Related Notes";
  }
  getIcon() {
    return "brain-circuit";
  }
  async onOpen() {
    this.renderPlaceholder("Open a note to see semantically related notes.");
    const active = this.plugin.app.workspace.getActiveFile();
    if (active)
      void this.update(active);
  }
  renderPlaceholder(msg) {
    this.contentEl.empty();
    this.contentEl.addClass("semantic-view");
    this.contentEl.createEl("p", { text: msg, cls: "semantic-placeholder" });
  }
  async update(file) {
    var _a;
    if (!file || ((_a = this.currentFile) == null ? void 0 : _a.path) === file.path)
      return;
    this.currentFile = file;
    const gen = ++this._gen;
    const el = this.contentEl;
    el.empty();
    el.addClass("semantic-view");
    el.createEl("div", { cls: "semantic-status" }).createEl("span", { text: "\u27F3  Searching for related notes\u2026", cls: "semantic-status-text" });
    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      if (gen !== this._gen)
        return;
      const results = await this.plugin.embeddings.search(
        `${file.basename}
${content}`,
        this.plugin.settings.relatedNotesCount,
        file.path
      );
      if (gen !== this._gen)
        return;
      this.renderResults(results, file);
    } catch (e) {
      if (gen !== this._gen)
        return;
      el.empty();
      el.createEl("p", {
        text: `\u26A0 Cannot reach embedding server: ${e.message}`,
        cls: "semantic-placeholder"
      });
    }
  }
  renderResults(results, file) {
    const el = this.contentEl;
    el.empty();
    el.addClass("semantic-view");
    const header = el.createEl("div", { cls: "semantic-header" });
    header.createEl("span", { text: "Related Notes", cls: "semantic-header-title" });
    header.createEl("span", { text: file.basename, cls: "semantic-header-sub" });
    if (results.length === 0) {
      el.createEl("p", { text: "No related notes found.", cls: "semantic-placeholder" });
      return;
    }
    const list = el.createEl("div", { cls: "semantic-list" });
    for (const r of results) {
      const pct = Math.round(r.score * 100);
      const barColor = pct >= 70 ? "var(--color-green)" : pct >= 50 ? "var(--color-yellow)" : "var(--color-base-50)";
      const item = list.createEl("div", { cls: "semantic-item" });
      const bar = item.createEl("div", { cls: "semantic-bar" });
      bar.style.setProperty("--bar-width", `${pct}%`);
      bar.style.setProperty("--bar-color", barColor);
      const info = item.createEl("div", { cls: "semantic-info" });
      const link = info.createEl("a", { text: r.title, cls: "semantic-link internal-link" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const f = this.plugin.app.vault.getAbstractFileByPath(r.path);
        if (f instanceof import_obsidian.TFile)
          void this.plugin.app.workspace.getLeaf(e.ctrlKey || e.metaKey).openFile(f);
      });
      info.createEl("span", { text: `${pct}%`, cls: "semantic-score" });
      if (r.snippet && this.plugin.settings.showSnippetInPanel) {
        item.createEl("div", { text: `"${r.snippet}"`, cls: "semantic-snippet" });
      }
    }
  }
  forceUpdate(file) {
    this.currentFile = null;
    void this.update(file);
  }
};
var SemanticSuggest = class extends import_obsidian.EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this._semanticCache = /* @__PURE__ */ new Map();
    this._prefetchTimer = null;
    this.setInstructions([
      { command: "\u2191\u2193", purpose: "navigate" },
      { command: "\u21B5", purpose: "insert link" },
      { command: "esc", purpose: "dismiss" }
    ]);
  }
  get settings() {
    return this.plugin.settings;
  }
  onTrigger(cursor, editor) {
    if (!this.settings.enableInlineSuggest)
      return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    if (/\[\[[^\]]*$/.test(before))
      return null;
    const match = before.match(/[a-záčďéěíňóřšťúůýžA-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9]{2,}$/);
    if (!match || match[0].length < this.settings.minWordLength)
      return null;
    const word = match[0];
    if (word.length >= this.settings.minSemanticLength)
      this._prefetch(word);
    return {
      start: { line: cursor.line, ch: cursor.ch - word.length },
      end: cursor,
      query: word
    };
  }
  _searchLexical(query, excludePath) {
    const q = query.toLowerCase();
    const results = [];
    for (const f of this.plugin.app.vault.getMarkdownFiles()) {
      if (f.path === excludePath)
        continue;
      if (isExcluded(f.path, this.settings.excludedFolders))
        continue;
      const t = f.basename.toLowerCase();
      if (t === q)
        results.push({ path: f.path, title: f.basename, score: 1, type: "exact" });
      else if (t.startsWith(q))
        results.push({ path: f.path, title: f.basename, score: 0.95, type: "prefix" });
      else if (t.includes(q))
        results.push({ path: f.path, title: f.basename, score: 0.85, type: "contains" });
      else if (t.split(/[\s\-_]+/).some((w) => w.startsWith(q)))
        results.push({ path: f.path, title: f.basename, score: 0.75, type: "word" });
    }
    return results.sort((a, b) => b.score - a.score);
  }
  _prefetch(query) {
    if (this._semanticCache.has(query) || this.plugin.embeddings.indexedCount === 0)
      return;
    if (this._prefetchTimer !== null)
      window.clearTimeout(this._prefetchTimer);
    this._prefetchTimer = window.setTimeout(() => {
      void (async () => {
        var _a, _b;
        try {
          const path = (_b = (_a = this.plugin.app.workspace.getActiveFile()) == null ? void 0 : _a.path) != null ? _b : null;
          const results = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
          this._semanticCache.set(query, results);
          if (this._semanticCache.size > 50)
            this._semanticCache.delete(this._semanticCache.keys().next().value);
        } catch (e) {
        }
      })();
    }, 150);
  }
  async getSuggestions(context) {
    var _a, _b;
    const { query } = context;
    if (query.length < this.settings.minWordLength)
      return [];
    const path = (_b = (_a = this.plugin.app.workspace.getActiveFile()) == null ? void 0 : _a.path) != null ? _b : null;
    const lexical = this._searchLexical(query, path);
    let semantic = [];
    if (query.length >= this.settings.minSemanticLength && this.plugin.embeddings.indexedCount > 0) {
      if (this._semanticCache.has(query)) {
        semantic = this._semanticCache.get(query);
        this._semanticCache.delete(query);
        this._semanticCache.set(query, semantic);
      } else {
        try {
          semantic = await this.plugin.embeddings.search(query, this.settings.maxSuggestions, path);
          this._semanticCache.set(query, semantic);
          if (this._semanticCache.size > 50)
            this._semanticCache.delete(this._semanticCache.keys().next().value);
        } catch (e) {
        }
      }
    }
    const seen = new Set(lexical.map((r) => r.path));
    const merged = [...lexical, ...semantic.filter((r) => !seen.has(r.path))];
    return merged.slice(0, this.settings.maxSuggestions);
  }
  renderSuggestion(result, el) {
    var _a;
    el.addClass("semantic-suggest-item");
    const row = el.createEl("div", { cls: "semantic-suggest-row" });
    row.createEl("span", { text: result.title, cls: "semantic-suggest-title" });
    const isLexical = ["exact", "prefix", "contains", "word"].includes((_a = result.type) != null ? _a : "");
    if (isLexical && this.settings.showLexicalBadge) {
      row.createEl("span", { text: "\u2197", cls: "semantic-suggest-badge lexical" });
    } else if (!isLexical) {
      const pct = Math.round(result.score * 100);
      row.createEl("span", {
        text: `~${pct}%`,
        cls: `semantic-suggest-score ${pct >= 60 ? "high" : "low"}`
      });
    }
    if (result.snippet && this.settings.showSnippetInSuggest) {
      el.createEl("div", { text: result.snippet, cls: "semantic-suggest-snippet" });
    }
  }
  selectSuggestion(result) {
    var _a;
    const ctx = this.context;
    if (!ctx)
      return;
    const isLexical = ["exact", "prefix", "contains", "word"].includes((_a = result.type) != null ? _a : "");
    const alias = !isLexical && ctx.query.toLowerCase() !== result.title.toLowerCase() ? `|${ctx.query}` : "";
    ctx.editor.replaceRange(`[[${result.title}${alias}]] `, ctx.start, ctx.end);
  }
};
var SemanticSettingsTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl: el } = this;
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    el.empty();
    new import_obsidian.Setting(el).setName("Embedding provider").setHeading();
    new import_obsidian.Setting(el).setName("Provider").setDesc("Embedding backend. Ollama and LM Studio run locally; OpenAI (API) sends text to the remote API.").addDropdown(
      (d) => d.addOption("ollama", "Ollama").addOption("lmstudio", "LM Studio").addOption("openai", "OpenAI (API)").setValue(s.provider).onChange(async (v) => {
        s.provider = v;
        await save();
        providerEl.empty();
        renderProviderFields(providerEl);
      })
    );
    const providerEl = el.createDiv();
    const renderProviderFields = (container) => {
      const urlDesc = s.provider === "openai" ? "OpenAI API base URL. Change to use Azure OpenAI or another compatible endpoint." : "Base URL of your Ollama or LM Studio instance. For mobile, enter your Tailscale IP (e.g. http://100.x.x.x:11434).";
      new import_obsidian.Setting(container).setName("Server URL").setDesc(urlDesc).addText(
        (t) => t.setPlaceholder(s.provider === "openai" ? "https://api.openai.com" : "http://localhost:11434").setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim();
          await save();
        })
      );
      if (s.provider === "openai") {
        new import_obsidian.Setting(container).setName("API key").setDesc("Your OpenAI API key (sk-\u2026). Stored locally in data.json, never synced.").addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("sk-\u2026").setValue(s.apiKey).onChange(async (v) => {
            s.apiKey = v.trim();
            await save();
          });
        });
      }
      const modelDesc = s.provider === "openai" ? "OpenAI embedding model (e.g. text-embedding-3-small, text-embedding-3-large)." : 'Model used to generate embeddings. Run "ollama list" to see installed models.';
      new import_obsidian.Setting(container).setName("Embedding model").setDesc(modelDesc).addText(
        (t) => t.setPlaceholder(s.provider === "openai" ? "text-embedding-3-small" : "bge-m3").setValue(s.embeddingModel).onChange(async (v) => {
          s.embeddingModel = v.trim();
          await save();
        })
      ).addButton(
        (btn) => btn.setButtonText("Test connection").onClick(async () => {
          try {
            await this.plugin.embeddings.getEmbedding("test");
            new import_obsidian.Notice("\u2713 Connection works.");
          } catch (e) {
            new import_obsidian.Notice(`\u2717 ${e.message}`);
          }
        })
      );
    };
    renderProviderFields(providerEl);
    new import_obsidian.Setting(el).setName("Inline suggest").setHeading();
    new import_obsidian.Setting(el).setName("Enable inline suggest").setDesc("Show link suggestions while you type.").addToggle((t) => t.setValue(s.enableInlineSuggest).onChange(async (v) => {
      s.enableInlineSuggest = v;
      await save();
    }));
    new import_obsidian.Setting(el).setName("Show lexical badge (\u2197)").setDesc("Mark exact/prefix/fuzzy note name matches with an arrow icon.").addToggle((t) => t.setValue(s.showLexicalBadge).onChange(async (v) => {
      s.showLexicalBadge = v;
      await save();
    }));
    new import_obsidian.Setting(el).setName("Min word length to trigger").setDesc("Minimum characters before the popup appears. (Default: 2)").addSlider(
      (sl) => sl.setLimits(1, 6, 1).setValue(s.minWordLength).setDynamicTooltip().onChange(async (v) => {
        s.minWordLength = v;
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Min word length for semantic search").setDesc("Shorter words use only lexical matching. (Default: 4)").addSlider(
      (sl) => sl.setLimits(2, 8, 1).setValue(s.minSemanticLength).setDynamicTooltip().onChange(async (v) => {
        s.minSemanticLength = v;
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Max suggestions").setDesc("Maximum items shown in the popup. (Default: 10)").addSlider(
      (sl) => sl.setLimits(3, 20, 1).setValue(s.maxSuggestions).setDynamicTooltip().onChange(async (v) => {
        s.maxSuggestions = v;
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Similarity threshold").setDesc("Minimum cosine similarity (0\u20131) to show a semantic result. (Default: 0.35)").addSlider(
      (sl) => sl.setLimits(0.1, 0.9, 0.05).setValue(s.similarityThreshold).setDynamicTooltip().onChange(async (v) => {
        s.similarityThreshold = v;
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Related Notes panel").setHeading();
    new import_obsidian.Setting(el).setName("Enable Related Notes panel").setDesc("Show a sidebar panel with semantically related notes for the open file.").addToggle((t) => t.setValue(s.enableRelatedPanel).onChange(async (v) => {
      s.enableRelatedPanel = v;
      await save();
    }));
    new import_obsidian.Setting(el).setName("Related notes count").setDesc("How many related notes to show in the panel. (Default: 12)").addSlider(
      (sl) => sl.setLimits(3, 30, 1).setValue(s.relatedNotesCount).setDynamicTooltip().onChange(async (v) => {
        s.relatedNotesCount = v;
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Snippet preview").setHeading();
    new import_obsidian.Setting(el).setName("Enable snippet preview").setDesc("Show the best-matching sentence from each note next to the result. Uses a 1-bit sentence index (~same storage as the current note index). Requires a vault re-index after toggling.").addToggle((t) => t.setValue(s.enableSnippets).onChange(async (v) => {
      s.enableSnippets = v;
      await save();
      new import_obsidian.Notice("Re-index your vault (Settings \u2192 Index \u2192 Re-index vault) for snippet changes to take effect.");
    }));
    new import_obsidian.Setting(el).setName("Show snippet in inline suggest").setDesc("Display the matching sentence below each suggestion in the typing popup.").addToggle((t) => t.setValue(s.showSnippetInSuggest).onChange(async (v) => {
      s.showSnippetInSuggest = v;
      await save();
    }));
    new import_obsidian.Setting(el).setName("Show snippet in Related Notes panel").setDesc("Display the matching sentence below each note in the sidebar panel.").addToggle((t) => t.setValue(s.showSnippetInPanel).onChange(async (v) => {
      s.showSnippetInPanel = v;
      await save();
    }));
    new import_obsidian.Setting(el).setName("Excluded folders").setHeading();
    new import_obsidian.Setting(el).setName("Excluded folders").setDesc("Comma-separated folder paths to skip during indexing and suggestions (e.g. Templates, Archive, Daily Notes).").addTextArea(
      (ta) => ta.setPlaceholder("Templates, Archive, Daily Notes").setValue(s.excludedFolders.join(", ")).onChange(async (v) => {
        s.excludedFolders = v.split(",").map((f) => f.trim()).filter(Boolean);
        await save();
      })
    );
    new import_obsidian.Setting(el).setName("Index").setHeading();
    new import_obsidian.Setting(el).setName("Auto-reindex delay (seconds)").setDesc("How long after you stop editing before a note is re-indexed. (Default: 12s)").addSlider(
      (sl) => sl.setLimits(5, 60, 1).setValue(s.reindexDebounceMs / 1e3).setDynamicTooltip().onChange(async (v) => {
        s.reindexDebounceMs = v * 1e3;
        await save();
      })
    );
    const indexedSetting = new import_obsidian.Setting(el).setName(`Indexed notes: ${this.plugin.embeddings.indexedCount}`).addButton(
      (btn) => btn.setButtonText("Re-index vault").onClick(async () => {
        btn.setButtonText("Indexing\u2026");
        btn.setDisabled(true);
        const n = await this.plugin.embeddings.indexVault();
        new import_obsidian.Notice(`Indexed ${n} notes.`);
        btn.setButtonText("Re-index vault");
        btn.setDisabled(false);
        indexedSetting.setName(`Indexed notes: ${this.plugin.embeddings.indexedCount}`);
      })
    ).addButton(
      (btn) => btn.setButtonText("Clear index").onClick(async () => {
        this.plugin.embeddings.index = {};
        await this.plugin.embeddings.save();
        new import_obsidian.Notice("Index cleared.");
        indexedSetting.setName(`Indexed notes: 0`);
      })
    );
  }
};
var SemanticBacklinksPlugin = class extends import_obsidian.Plugin {
  // Access the view via the workspace rather than storing a reference,
  // to avoid the memory leak flagged by the Obsidian linter.
  get relatedView() {
    var _a;
    return (_a = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED)[0]) == null ? void 0 : _a.view;
  }
  async onload() {
    await this.loadSettings();
    this.embeddings = new EmbeddingsManager(this);
    this.modifyTimers = /* @__PURE__ */ new Map();
    await this.embeddings.load();
    if (this.settings.enableSnippets)
      await this.embeddings.loadSentenceIndex();
    this.registerView(
      VIEW_TYPE_RELATED,
      (leaf) => new RelatedNotesView(leaf, this)
    );
    this.registerEditorSuggest(new SemanticSuggest(this));
    this.addSettingTab(new SemanticSettingsTab(this.app, this));
    this.addRibbonIcon("brain-circuit", "Semantic Backlinks", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "show-related-notes",
      name: "Show related notes panel",
      callback: () => {
        void this.activateView();
      }
    });
    this.addCommand({
      id: "reindex-vault",
      name: "Re-index vault",
      callback: async () => {
        const notice = new import_obsidian.Notice("Indexing vault\u2026", 0);
        const n = await this.embeddings.indexVault((done, total, name) => {
          notice.setMessage(`Indexing\u2026 ${done}/${total}: ${name}`);
        });
        notice.hide();
        new import_obsidian.Notice(`Indexed ${n} notes.`);
      }
    });
    this.addCommand({
      id: "refresh-related",
      name: "Refresh related notes for current file",
      callback: () => {
        var _a;
        const file = this.app.workspace.getActiveFile();
        if (file)
          (_a = this.relatedView) == null ? void 0 : _a.forceUpdate(file);
      }
    });
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file && this.relatedView && this.settings.enableRelatedPanel)
        void this.relatedView.update(file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof import_obsidian.TFile) || file.extension !== "md")
        return;
      window.clearTimeout(this.modifyTimers.get(file.path));
      this.modifyTimers.set(file.path, window.setTimeout(() => {
        void (async () => {
          this.modifyTimers.delete(file.path);
          if (this.embeddings.indexing)
            return;
          await this.embeddings.indexFile(file);
          await this.embeddings.save();
          if (this.settings.enableSnippets)
            await this.embeddings.saveSentenceIndex();
          const active = this.app.workspace.getActiveFile();
          if (this.relatedView && (active == null ? void 0 : active.path) === file.path)
            this.relatedView.forceUpdate(file);
        })();
      }, this.settings.reindexDebounceMs));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof import_obsidian.TFile) {
        delete this.embeddings.index[file.path];
        void this.embeddings.save();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian.TFile && file.extension === "md" && this.embeddings.index[oldPath]) {
        this.embeddings.index[file.path] = { ...this.embeddings.index[oldPath], title: file.basename };
        delete this.embeddings.index[oldPath];
        void this.embeddings.save();
      }
    }));
    window.setTimeout(() => {
      void (async () => {
        const unindexed = this.app.vault.getMarkdownFiles().filter((f) => {
          if (isExcluded(f.path, this.settings.excludedFolders))
            return false;
          const e = this.embeddings.index[f.path];
          return !e || !Array.isArray(e.embeddings);
        });
        if (unindexed.length > 0) {
          const notice = new import_obsidian.Notice(`Semantic Backlinks: indexing ${unindexed.length} notes\u2026`, 0);
          await this.embeddings.indexVault((done, total, name) => {
            notice.setMessage(`Semantic Backlinks: ${done}/${total} \u2014 ${name}`);
          });
          notice.hide();
          new import_obsidian.Notice("Semantic Backlinks: index ready.");
        }
      })();
    }, 5e3);
  }
  async activateView() {
    var _a, _b;
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_RELATED)[0];
    if (!leaf) {
      leaf = (_a = workspace.getRightLeaf(false)) != null ? _a : workspace.getLeaf(true);
    }
    await leaf.setViewState({ type: VIEW_TYPE_RELATED, active: true });
    const active = workspace.getActiveFile();
    if (active)
      (_b = this.relatedView) == null ? void 0 : _b.forceUpdate(active);
  }
  async loadSettings() {
    var _a;
    const raw = (_a = await this.loadData()) != null ? _a : {};
    delete raw["embeddings"];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  }
  async saveSettings() {
    await this.saveData({ ...this.settings });
  }
  onunload() {
    for (const t of this.modifyTimers.values())
      window.clearTimeout(t);
  }
};
