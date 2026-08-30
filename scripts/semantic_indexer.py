#!/usr/bin/env python3
"""semantic_indexer.py — local semantic embedding index for the aggregaytor repo.

Walks the repository, chunks source/doc files, embeds each chunk with a local
Ollama model, and stores the vectors in a ChromaDB persistent collection at
.semantic-index/. Re-runs are incremental: chunk ids carry a content hash, so
only changed chunks are re-embedded.

Usage:
  python3 scripts/semantic_indexer.py               # (re)index the repo
  python3 scripts/semantic_indexer.py --query "how are grindr auth headers captured" [-k 8]
  python3 scripts/semantic_indexer.py --stats       # file/chunk counts

Environment:
  OLLAMA_EMBED_MODEL   embedding model name (default: nomic-embed-text)
  OLLAMA_URL           Ollama base URL (default: http://localhost:11434)

Dependencies: pip install chromadb requests   (plus a running `ollama serve`
with the embed model pulled: `ollama pull nomic-embed-text`). Exits 2 with a
clear message when either is unavailable.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
INDEX_DIR = os.path.join(REPO_ROOT, ".semantic-index")
COLLECTION = "aggregaytor"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
EMBED_ENDPOINT = f"{OLLAMA_URL}/api/embeddings"

# Directories never walked, regardless of .gitignore.
EXCLUDE_DIRS = {
    ".git", "node_modules", "dist", ".claude", ".playwright-mcp",
    ".semantic-index", ".venv", "venv", "__pycache__", "coverage",
}

# File extensions considered indexable.
CODE_EXTS = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh", ".css", ".html"}
DOC_EXTS = {".md"}
CONFIG_EXTS = {".json", ".yaml", ".yml"}
INDEXABLE_EXTS = CODE_EXTS | DOC_EXTS | CONFIG_EXTS

SKIP_FILES = {"pnpm-lock.yaml", "package-lock.json"}

CODE_CHUNK_LINES = 60
CODE_CHUNK_OVERLAP = 10
MAX_CHUNK_CHARS = 8000  # hard cap so a minified line can't blow up the embedder


def fail(msg: str) -> "NoReturn":  # noqa: F821 - py<3.11 friendly
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def load_deps():
    """Import optional deps with actionable messages."""
    try:
        import requests  # noqa: F401
    except ImportError:
        fail("the 'requests' package is not installed.\n  fix: pip install chromadb requests")
    try:
        import chromadb  # noqa: F401
    except ImportError:
        fail("the 'chromadb' package is not installed.\n  fix: pip install chromadb requests")
    import chromadb
    import requests
    return chromadb, requests


def load_gitignore_patterns() -> list[str]:
    """Best-effort .gitignore support: directory and glob patterns from the root file."""
    patterns: list[str] = []
    path = os.path.join(REPO_ROOT, ".gitignore")
    if not os.path.exists(path):
        return patterns
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("!"):
                continue
            patterns.append(line.rstrip("/"))
    return patterns


def is_ignored(rel_path: str, patterns: list[str]) -> bool:
    parts = rel_path.split(os.sep)
    for pat in patterns:
        # Directory-name or glob match against any path component or the whole path.
        if any(fnmatch.fnmatch(part, pat) for part in parts):
            return True
        if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(rel_path, f"**/{pat}"):
            return True
    return False


def walk_repo() -> list[str]:
    """Return sorted repo-relative paths of indexable files."""
    patterns = load_gitignore_patterns()
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in EXCLUDE_DIRS and not is_ignored(
                os.path.relpath(os.path.join(dirpath, d), REPO_ROOT), patterns)
        )
        for name in sorted(filenames):
            if name in SKIP_FILES:
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in INDEXABLE_EXTS:
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), REPO_ROOT)
            if is_ignored(rel, patterns):
                continue
            found.append(rel)
    return found


def chunk_code(text: str) -> list[str]:
    """~60-line chunks with 10-line overlap."""
    lines = text.splitlines()
    if not lines:
        return []
    chunks: list[str] = []
    step = CODE_CHUNK_LINES - CODE_CHUNK_OVERLAP
    for start in range(0, len(lines), step):
        chunk = "\n".join(lines[start:start + CODE_CHUNK_LINES]).strip()
        if chunk:
            chunks.append(chunk[:MAX_CHUNK_CHARS])
        if start + CODE_CHUNK_LINES >= len(lines):
            break
    return chunks


HEADING_RE = re.compile(r"^#{1,6}\s", re.M)


def chunk_markdown(text: str) -> list[str]:
    """Split on headings; oversized sections fall back to line chunking."""
    positions = [m.start() for m in HEADING_RE.finditer(text)] or [0]
    if positions[0] != 0:
        positions.insert(0, 0)
    positions.append(len(text))
    chunks: list[str] = []
    for a, b in zip(positions, positions[1:]):
        section = text[a:b].strip()
        if not section:
            continue
        if len(section) > MAX_CHUNK_CHARS:
            chunks.extend(chunk_code(section))
        else:
            chunks.append(section)
    return chunks


def chunk_file(rel_path: str, text: str) -> list[str]:
    ext = os.path.splitext(rel_path)[1].lower()
    if ext in DOC_EXTS:
        return chunk_markdown(text)
    return chunk_code(text)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def get_collection(chromadb):
    try:
        client = chromadb.PersistentClient(path=INDEX_DIR)
        return client.get_or_create_collection(
            name=COLLECTION, metadata={"hnsw:space": "cosine"})
    except Exception as exc:  # pragma: no cover - env specific
        fail(f"could not open ChromaDB index at {INDEX_DIR}: {exc}\n"
             "  fix: pip install chromadb requests")


# nomic-embed-text has a 2048-token context; ~4 chars/token leaves headroom
# at 6000 chars. Oversized chunks are truncated (dense/minified lines can
# blow past the line-count-based chunker's assumptions), and a chunk Ollama
# still rejects is retried once at half size before being skipped with a
# warning — one bad chunk must never abort the whole index run.
MAX_EMBED_CHARS = 6000


def embed(requests, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via Ollama (one request per text; API is per-prompt)."""
    vectors: list[list[float]] = []
    for text in texts:
        text = text[:MAX_EMBED_CHARS]
        resp = None
        for attempt_text in (text, text[: MAX_EMBED_CHARS // 2]):
            try:
                resp = requests.post(
                    EMBED_ENDPOINT,
                    json={"model": EMBED_MODEL, "prompt": attempt_text},
                    timeout=120,
                )
            except requests.exceptions.ConnectionError:
                fail(f"cannot reach Ollama at {EMBED_ENDPOINT}.\n"
                     "  fix: start it with `ollama serve` and pull the model: "
                     f"`ollama pull {EMBED_MODEL}`")
            if resp.status_code == 404:
                fail(f"Ollama has no model named '{EMBED_MODEL}'.\n"
                     f"  fix: ollama pull {EMBED_MODEL}")
            if resp.status_code == 200:
                break
            if "context length" not in resp.text:
                break
        if resp.status_code == 500 and "context length" in resp.text:
            print(f"  warn: chunk too large even after truncation — skipped", file=sys.stderr)
            vectors.append([0.0])  # placeholder; caller drops zero-dim-1 vectors
            continue
        if resp.status_code != 200:
            fail(f"Ollama embedding request failed ({resp.status_code}): {resp.text[:200]}")
        data = resp.json()
        vec = data.get("embedding")
        if not vec:
            fail(f"Ollama returned no embedding for model '{EMBED_MODEL}'.\n"
                 f"  fix: ollama pull {EMBED_MODEL}")
        vectors.append(vec)
    return vectors


def cmd_index() -> None:
    chromadb, requests = load_deps()
    collection = get_collection(chromadb)

    files = walk_repo()
    print(f"Scanning {len(files)} indexable files under {REPO_ROOT}")

    # Existing ids let us (a) skip unchanged chunks, (b) delete stale ones.
    existing = collection.get(include=[])  # ids only
    existing_ids: set[str] = set(existing.get("ids", []))
    wanted_ids: set[str] = set()

    new_ids: list[str] = []
    new_docs: list[str] = []
    new_metas: list[dict] = []
    files_touched = 0

    for rel in files:
        full = os.path.join(REPO_ROOT, rel)
        try:
            with open(full, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as exc:
            print(f"  skip {rel}: {exc}", file=sys.stderr)
            continue
        chunks = chunk_file(rel, text)
        file_changed = False
        for i, chunk in enumerate(chunks):
            cid = f"{rel}#chunk{i}:{content_hash(chunk)}"
            wanted_ids.add(cid)
            if cid in existing_ids:
                continue  # unchanged chunk, already embedded
            new_ids.append(cid)
            new_docs.append(chunk)
            new_metas.append({"path": rel, "chunk": i})
            file_changed = True
        if file_changed:
            files_touched += 1

    stale = sorted(existing_ids - wanted_ids)
    if stale:
        collection.delete(ids=stale)
        print(f"Deleted {len(stale)} stale chunks")

    if not new_ids:
        print("Index up to date — nothing to embed.")
    else:
        print(f"Embedding {len(new_ids)} new/changed chunks from {files_touched} files "
              f"via {EMBED_MODEL} …")
        BATCH = 32
        done = 0
        for start in range(0, len(new_ids), BATCH):
            ids = new_ids[start:start + BATCH]
            docs = new_docs[start:start + BATCH]
            metas = new_metas[start:start + BATCH]
            vectors = embed(requests, docs)
            # Drop skipped-chunk placeholders (dim-1 zero vectors) — upserting
            # them would fail Chroma's dimension check.
            keep = [j for j, v in enumerate(vectors) if len(v) > 1]
            if keep:
                collection.upsert(
                    ids=[ids[j] for j in keep],
                    documents=[docs[j] for j in keep],
                    metadatas=[metas[j] for j in keep],
                    embeddings=[vectors[j] for j in keep],
                )
            done += len(ids)
            print(f"  …{done}/{len(new_ids)}")

    total = collection.count()
    print(f"Done. Collection '{COLLECTION}' now holds {total} chunks "
          f"across {len(files)} files at {INDEX_DIR}")


def cmd_query(query: str, k: int) -> None:
    chromadb, requests = load_deps()
    collection = get_collection(chromadb)
    if collection.count() == 0:
        fail("index is empty — run `python3 scripts/semantic_indexer.py` first")
    vec = embed(requests, [query])[0]
    res = collection.query(query_embeddings=[vec], n_results=k,
                           include=["documents", "metadatas", "distances"])
    docs = res["documents"][0]
    metas = res["metadatas"][0]
    dists = res["distances"][0]
    for rank, (doc, meta, dist) in enumerate(zip(docs, metas, dists), 1):
        score = 1.0 - dist
        preview = " ".join(doc.split())[:200]
        print(f"{rank:2d}. [{score:+.3f}] {meta['path']}#chunk{meta['chunk']}")
        print(f"     {preview}")


def cmd_stats() -> None:
    chromadb, _requests = load_deps()
    collection = get_collection(chromadb)
    total = collection.count()
    paths: set[str] = set()
    if total:
        got = collection.get(include=["metadatas"])
        for meta in got.get("metadatas") or []:
            if meta and "path" in meta:
                paths.add(meta["path"])
    print(f"index dir : {INDEX_DIR}")
    print(f"collection: {COLLECTION}")
    print(f"model     : {EMBED_MODEL}")
    print(f"files     : {len(paths)}")
    print(f"chunks    : {total}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--query", metavar="TEXT", help="semantic search instead of indexing")
    parser.add_argument("-k", type=int, default=8, help="results to return with --query")
    parser.add_argument("--stats", action="store_true", help="print file/chunk counts")
    args = parser.parse_args()

    if args.stats:
        cmd_stats()
    elif args.query:
        cmd_query(args.query, max(1, args.k))
    else:
        cmd_index()


if __name__ == "__main__":
    main()
