# Semantic Backlinks

An Obsidian plugin that suggests note links while you type — combining fast lexical matching with semantic search powered by a local [Ollama](https://ollama.ai) embedding model.

## Features

- **Inline suggest popup** — appears as you type, just like Various Complements
  - Lexical matches (exact, prefix, partial, word boundary) appear instantly
  - Semantic matches from the embedding model appear below
- **Related Notes panel** — sidebar panel showing the most semantically similar notes to the one you have open
- **Fully local** — all embeddings are computed and stored on your machine, nothing leaves your computer
- **Auto-indexing** — vault is indexed on startup; notes are re-indexed automatically after you stop editing

## Requirements

- [Ollama](https://ollama.ai) running locally
- An embedding model pulled in Ollama — recommended: `bge-m3` (multilingual, works well with Czech)

```bash
ollama pull bge-m3
```

## Installation

1. Copy the plugin folder into your vault's `.obsidian/plugins/` directory
2. Enable **Semantic Backlinks** in Settings → Community plugins
3. Make sure Ollama is running (`ollama serve`)
4. The vault will be indexed automatically in the background (first run takes a few minutes)

## Usage

### Inline popup

Type any word — if a semantically or lexically related note exists, a popup appears:

- `↗` badge = note name match (lexical)
- `~65%` = semantic similarity score

Press `Enter` to insert `[[Note Title]]` and replace the typed word.

### Related Notes panel

Click the brain icon in the ribbon or run **Show related notes panel** from the command palette.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Ollama URL | `http://localhost:11434` | Base URL of your Ollama instance |
| Embedding model | `bge-m3` | Model used to generate embeddings |
| Min word length to trigger | 2 | Minimum characters before popup appears |
| Min word length for semantic search | 4 | Words shorter than this use lexical matching only |
| Similarity threshold | 0.35 | Minimum cosine similarity for semantic results |
| Max suggestions | 10 | Maximum popup items |
| Related notes count | 12 | Notes shown in the panel |
| Auto-reindex delay | 12s | Idle time after editing before re-indexing |

## License

MIT
