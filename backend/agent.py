"""Create an agent from a binder + rulebooks, and answer questions with it.

Each agent lives in its own folder:
  agents/<agent_id>/input/binder.pdf
  agents/<agent_id>/input/rulebooks/<file>.pdf   (optional)
  agents/<agent_id>/agent.db   (info, documents, equipment, search index)
"""

import os
import re
import sqlite3
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import pymupdf

import llm
import search
from register import build_register

AGENTS_DIR = Path(os.environ.get("AGENTS_DIR", "agents"))
PAUSE_SECONDS = float(os.environ.get("PAUSE_SECONDS", "4"))  # between LLM calls, for free-tier limits
PAGE_IMAGE_DPI = 100
MAX_PAGE_TEXT = 12000     # characters of page text sent to the LLM
MAX_CONTEXT_DOC = 3000    # characters per document when answering
ANSWER_RETRY_WAITS = (3,) # a person is waiting: retry a busy provider once, then move on
ANSWER_TIMEOUT_SECONDS = 150  # usually under 30 s, but the model thinks longer on big prompts
MAX_HISTORY_MESSAGES = 4  # earlier chat messages sent with a question (2 questions + answers)
MAX_HISTORY_TEXT = 800    # characters per earlier message; enough for follow-ups

SUMMARY_PROMPT = """You are reading one sheet of an engineering document ({kind}): {label}.
You get the sheet's raw text (unordered labels) and, if available, an image of the sheet.

Write a factual summary in plain English with these sections:
- Drawing: number, title, unit, revision.
- Equipment: each tag with its name and any printed data (size, pressure, temperature, material).
- Instruments: tags you can identify.
- Connections: for each piece of equipment, what flows in from where and out to where,
  including off-sheet connectors (their number and the equipment or unit they name).
- Codes and definitions: any abbreviations, codes or symbols defined on the sheet.
- Notes: important notes.
Use tags exactly as written in the text. Do not guess; leave out anything you cannot see.

Raw text of the sheet:
{text}"""

# A page citation as the answer prompt asks for it: "binder p. 12" or "rulebook <file> p. 1".
CITATION_RE = re.compile(r"\bbinder\s+p\.\s*(\d+)|\brulebook\s+([\w.-]+?)(?:\.pdf)?\s+p\.\s*(\d+)",
                         re.IGNORECASE)

ANSWER_PROMPT = """You answer questions about an engineering binder (P&ID drawings) and any rulebooks uploaded with it.
Use ONLY the information below. Cite pages like (binder p. 12) or (rulebook <file> p. 1),
one page per citation. If the information below does not contain the answer, say you could not find it.
Write plain text: use "- " for list items and **bold** for emphasis. Do not use headings or tables.

Equipment list extracted from the binder's machine-readable pages (use it for counts and lists):
{equipment}

Relevant pages:
{documents}

Earlier conversation (use it only to understand what the question refers to):
{history}

Question: {question}"""


# ---------- creating and building ----------

def create_agent(binder_name, binder_bytes, rulebooks):
    """Save the uploads in a new agent folder and return the agent id.

    rulebooks: list of (file_name, bytes); may be empty.
    """
    stem = re.sub(r"[^a-z0-9]+", "-", Path(binder_name).stem.lower()).strip("-") or "binder"
    agent_id = f"{stem}-{datetime.now():%Y%m%d-%H%M%S}"
    folder = AGENTS_DIR / agent_id
    (folder / "input" / "rulebooks").mkdir(parents=True)
    (folder / "input" / "binder.pdf").write_bytes(binder_bytes)
    for name, data in rulebooks:
        (folder / "input" / "rulebooks" / Path(name).name).write_bytes(data)

    with _connect(agent_id) as db:
        db.executescript("""
            CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE documents (
                id INTEGER PRIMARY KEY, source TEXT, file TEXT, page INTEGER,
                text TEXT, summary TEXT, summary_by TEXT, UNIQUE (source, file, page));
            CREATE TABLE equipment (tag TEXT PRIMARY KEY, category TEXT, name TEXT, pages TEXT);
            CREATE VIRTUAL TABLE documents_fts USING fts5(body);
        """)
        _set_info(db, name=binder_name, created=datetime.now().isoformat(timespec="seconds"),
                  status="created", done=0, total=0, error="")
    return agent_id


def build_agent(agent_id):
    """Read the rulebooks and binder. Safe to run again: finished pages are skipped."""
    folder = AGENTS_DIR / agent_id
    binder = folder / "input" / "binder.pdf"
    rulebooks = sorted((folder / "input" / "rulebooks").glob("*.pdf"))
    try:
        with _connect(agent_id) as db:
            _set_info(db, status="processing", error="")

        # 1. Equipment list (fast, exact, no LLM), and the binder pages it could not read.
        #    Agents built before 'unread_pages' existed get it on their next resume.
        if "unread_pages" not in get_info(agent_id):
            page_types, assets = build_register(str(binder))
            unread = [n for n, t in sorted(page_types.items()) if t != "text"]
            with _connect(agent_id) as db:
                db.execute("DELETE FROM equipment")
                db.executemany("INSERT INTO equipment VALUES (?, ?, ?, ?)", [
                    (tag, a["category"], a["name"], ",".join(map(str, sorted(a["pages"]))))
                    for tag, a in assets.items()])
                _set_info(db, unread_pages=",".join(map(str, unread)))

        # 2. Every rulebook page and binder page, summarised by the LLM
        sheets = [("rulebook", path) for path in rulebooks] + [("binder", binder)]
        total = sum(_page_count(path) for _, path in sheets)
        done = 0
        for source, path in sheets:
            with pymupdf.open(path) as doc:
                for page in doc:
                    _read_page(agent_id, source, path.name, page)
                    done += 1
                    with _connect(agent_id) as db:
                        _set_info(db, done=done, total=total)

        # 3. Search index, totals
        with _connect(agent_id) as db:
            search.build_index(db)
            by_llm = db.execute("SELECT COUNT(*) FROM documents WHERE summary_by != 'raw text'").fetchone()[0]
            equipment = db.execute("SELECT COUNT(*) FROM equipment").fetchone()[0]
            _set_info(db, status="ready", summarised=by_llm, equipment=equipment)
    except Exception as error:
        with _connect(agent_id) as db:
            _set_info(db, status="failed", error=str(error))


def _read_page(agent_id, source, file_name, page):
    """Summarise one page with the LLM, unless it is already done."""
    page_no = page.number + 1
    with _connect(agent_id) as db:
        row = db.execute("SELECT summary_by FROM documents WHERE source=? AND file=? AND page=?",
                         (source, file_name, page_no)).fetchone()
        if row and row[0] != "raw text":
            return  # already summarised
        if row:     # stored as plain text last time: try the LLM again
            db.execute("DELETE FROM documents WHERE source=? AND file=? AND page=?",
                       (source, file_name, page_no))

    text = page.get_text()
    image = page.get_pixmap(dpi=PAGE_IMAGE_DPI).tobytes("png")
    label = f"{file_name}, page {page_no}"
    prompt = SUMMARY_PROMPT.format(kind=source, label=label, text=text[:MAX_PAGE_TEXT])
    try:
        summary, summary_by = llm.ask(prompt, image)
        time.sleep(PAUSE_SECONDS)
    except llm.LLMError:
        summary, summary_by = "", "raw text"  # still searchable through its raw text

    with _connect(agent_id) as db:
        db.execute("INSERT INTO documents (source, file, page, text, summary, summary_by) "
                   "VALUES (?, ?, ?, ?, ?, ?)",
                   (source, file_name, page_no, text, summary, summary_by))


# ---------- questions ----------

def answer(agent_id, question, history=()):
    """Return {'answer', 'provider', 'sources'} for a question.

    history: earlier chat messages as (role, text) pairs, role 'user' or 'agent', oldest first.
    """
    history = list(history)[-MAX_HISTORY_MESSAGES:]
    # A follow-up like "and its design temperature?" names nothing to search for,
    # so search with the previous question's words as well.
    previous = [text for role, text in history if role == "user"][-1:]
    with _connect(agent_id) as db:
        matches = search.search(db, " ".join(previous + [question]))
        docs = [db.execute("SELECT id, source, file, page, summary FROM documents WHERE id=?",
                           (doc_id,)).fetchone() + (passage,) for doc_id, passage in matches]
        equipment = db.execute("SELECT tag, category, name, pages FROM equipment ORDER BY tag").fetchall()
    unread = get_info(agent_id).get("unread_pages", "")

    counts = Counter(row[1] for row in equipment)
    equipment_text = "Counts: " + ", ".join(f"{c}: {n}" for c, n in counts.most_common()) + "\n" + \
        "\n".join(f"{tag} | {cat} | {name} | pages {pages}" for tag, cat, name, pages in equipment)
    if unread:
        equipment_text += (
            f"\nNote: binder pages {unread.replace(',', ', ')} could not be machine-read for this list "
            "(scanned, or text drawn as lines). Equipment shown only on those pages may be missing, "
            "so say this whenever you give a count or a complete list.")
    documents_text = "\n\n".join(
        # The summary is cut to MAX_CONTEXT_DOC characters, so the passage that matched the
        # question is added too: it may lie beyond the cut. A page without a summary sends the passage.
        f"[{_source_label(source, file, page)}]\n"
        + (f"{summary[:MAX_CONTEXT_DOC]}\nPassage matching the question: {passage}" if summary else passage)
        for _, source, file, page, summary, passage in docs) or "(no matching pages)"

    history_text = "\n".join(
        f"{'User' if role == 'user' else 'Agent'}: {text[:MAX_HISTORY_TEXT]}"
        for role, text in history) or "(none)"

    prompt = ANSWER_PROMPT.format(equipment=equipment_text, documents=documents_text,
                                  history=history_text, question=question)
    text, provider = llm.ask(prompt, retry_waits=ANSWER_RETRY_WAITS, timeout=ANSWER_TIMEOUT_SECONDS)

    # Show the pages the answer cites; if it cites none, show the pages that were searched.
    with _connect(agent_id) as db:
        pages = _cited_pages(db, text)
    cited = bool(pages)
    if not cited:
        pages = [(source, file, page) for _, source, file, page, _, _ in docs]
    sources = [{"source": source, "file": file, "page": page} for source, file, page in pages]
    return {"answer": text, "provider": provider, "sources": sources, "cited": cited}


# ---------- reading agent data ----------

def list_agents():
    agents = []
    for folder in sorted(AGENTS_DIR.glob("*/agent.db"), reverse=True):
        agents.append(get_info(folder.parent.name))
    return agents


def get_info(agent_id):
    with _connect(agent_id) as db:
        info = dict(db.execute("SELECT key, value FROM info"))
    info["id"] = agent_id
    info["rulebooks"] = len(list((AGENTS_DIR / agent_id / "input" / "rulebooks").glob("*.pdf")))
    return info


def list_equipment(agent_id):
    """The equipment register: [{'tag', 'category', 'name', 'pages': [binder page numbers]}]."""
    with _connect(agent_id) as db:
        rows = db.execute("SELECT tag, category, name, pages FROM equipment ORDER BY tag").fetchall()
    return [{"tag": tag, "category": category, "name": name, "pages": _page_numbers(pages)}
            for tag, category, name, pages in rows]


def list_sheets(agent_id):
    """Every binder and rulebook page, with the equipment titled on each binder page."""
    folder = AGENTS_DIR / agent_id / "input"
    tags_by_page = {}
    for item in list_equipment(agent_id):
        for page_no in item["pages"]:
            tags_by_page.setdefault(page_no, []).append(item["tag"])
    sheets = [{"source": "binder", "file": "binder.pdf", "page": n, "equipment": tags_by_page.get(n, [])}
              for n in range(1, _page_count(folder / "binder.pdf") + 1)]
    for path in sorted((folder / "rulebooks").glob("*.pdf")):
        sheets += [{"source": "rulebook", "file": path.name, "page": n, "equipment": []}
                   for n in range(1, _page_count(path) + 1)]
    return sheets


def page_image(agent_id, source, file_name, page_no, dpi=150):
    """PNG of one page, for showing the source of an answer."""
    folder = AGENTS_DIR / agent_id / "input"
    path = folder / "binder.pdf" if source == "binder" else folder / "rulebooks" / Path(file_name).name
    with pymupdf.open(path) as doc:
        return doc[page_no - 1].get_pixmap(dpi=dpi).tobytes("png")


def agent_exists(agent_id):
    return bool(re.fullmatch(r"[a-z0-9-]+", agent_id)) and (AGENTS_DIR / agent_id / "agent.db").exists()


# ---------- helpers ----------

@contextmanager
def _connect(agent_id):
    """Open the agent's database; commit on success and always close."""
    db = sqlite3.connect(AGENTS_DIR / agent_id / "agent.db", timeout=30)
    try:
        with db:
            yield db
    finally:
        db.close()


def _page_numbers(pages):
    """'2,3' -> [2, 3]."""
    return [int(n) for n in pages.split(",") if n]


def _page_count(path):
    with pymupdf.open(path) as doc:
        return doc.page_count


def _set_info(db, **values):
    db.executemany("INSERT OR REPLACE INTO info VALUES (?, ?)",
                   [(k, str(v)) for k, v in values.items()])


def _cited_pages(db, text):
    """Pages cited in an answer that exist in this agent, as (source, file, page), in order."""
    known = {(source, Path(file).stem.lower(), page): (source, file, page)
             for source, file, page in db.execute("SELECT source, file, page FROM documents")}
    pages = []
    for match in CITATION_RE.finditer(text):
        binder_page, rulebook, rulebook_page = match.groups()
        key = (("binder", "binder", int(binder_page)) if binder_page
               else ("rulebook", rulebook.lower(), int(rulebook_page)))
        if key in known and known[key] not in pages:
            pages.append(known[key])
    return pages


def _source_label(source, file, page):
    return f"binder p. {page}" if source == "binder" else f"rulebook {file} p. {page}"