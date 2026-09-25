"""Keyword search over an agent's documents (SQLite full-text search)."""

import re

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from",
    "how", "i", "in", "is", "it", "many", "me", "of", "on", "or", "show", "tell", "that",
    "the", "there", "this", "to", "what", "when", "where", "which", "who", "why", "with",
}


def build_index(db):
    """(Re)build the search index from each document's summary, or its raw text if none."""
    db.execute("DELETE FROM documents_fts")
    db.execute(
        "INSERT INTO documents_fts (rowid, body) "
        "SELECT id, COALESCE(NULLIF(summary, ''), text) FROM documents"
    )


def search(db, question, limit=6):
    """Return [(document id, passage around the matching words)] for the best matches."""
    words = re.findall(r"[a-z0-9]+", question.lower())
    terms = sorted({w for w in words if w not in STOPWORDS})
    if not terms:
        return []
    query = " OR ".join(f'"{term}"' for term in terms)
    rows = db.execute(
        "SELECT rowid, snippet(documents_fts, 0, '', '', ' ... ', 64) FROM documents_fts "
        "WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?",
        (query, limit),
    )
    return rows.fetchall()
