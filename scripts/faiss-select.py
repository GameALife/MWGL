#!/usr/bin/env python3
import argparse
import json
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Select top-k eval samples using FAISS similarity.")
    parser.add_argument("--dataset", required=True, help="Path to eval dataset JSONL file")
    parser.add_argument("--prompt", required=True, help="Query prompt text")
    parser.add_argument("--topk", type=int, default=24, help="Top-k rows to select")
    parser.add_argument(
        "--model",
        default="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        help="Embedding model name",
    )
    return parser.parse_args()


def load_rows(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rows.append(row)
    return rows


def main():
    args = parse_args()
    rows = load_rows(args.dataset)
    if not rows:
        print(json.dumps({"selected_ids": []}, ensure_ascii=False))
        return
    topk = max(1, min(int(args.topk or 1), len(rows)))
    prompt = (args.prompt or "").strip()
    if not prompt:
        picked = [str(r.get("id", f"eval_{i+1}")) for i, r in enumerate(rows[:topk])]
        print(json.dumps({"selected_ids": picked, "mode": "prefix"}, ensure_ascii=False))
        return
    try:
        import numpy as np
        import faiss
        from sentence_transformers import SentenceTransformer
    except Exception as e:
        raise RuntimeError(f"faiss dependencies missing: {e}") from e

    texts = []
    ids = []
    for i, row in enumerate(rows):
        text = str((row.get("input") or {}).get("user_text") or (row.get("input") or {}).get("user_text_en") or "")
        texts.append(text)
        ids.append(str(row.get("id", f"eval_{i+1}")))

    model = SentenceTransformer(args.model)
    doc_emb = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    q_emb = model.encode([prompt], normalize_embeddings=True, convert_to_numpy=True)

    if doc_emb.dtype != np.float32:
        doc_emb = doc_emb.astype("float32")
    if q_emb.dtype != np.float32:
        q_emb = q_emb.astype("float32")

    index = faiss.IndexFlatIP(doc_emb.shape[1])
    index.add(doc_emb)
    _, indices = index.search(q_emb, topk)

    selected_ids = []
    seen = set()
    for idx in indices[0].tolist():
        if idx < 0 or idx >= len(ids):
            continue
        _id = ids[idx]
        if _id in seen:
            continue
        seen.add(_id)
        selected_ids.append(_id)

    print(
        json.dumps(
            {"selected_ids": selected_ids, "mode": "faiss", "model": args.model},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
