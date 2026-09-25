# Binder agent (demo)

Upload a P&ID binder and its rulebooks, click **Create agent**, then ask questions.
React frontend (`frontend/`) + Python backend (this folder).

## 1. One-time setup

Python backend:

    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt

React frontend (needs Node.js 20+):

    cd frontend && npm install

## 2. LLM providers (tried in this order; set up at least one)

| Provider | What to do | Notes |
|---|---|---|
| Gemini | Get a free key at aistudio.google.com ("Get API key") | Reads page images + text |
| OpenRouter | Free account at openrouter.ai, then Keys | Text only |
| Ollama | Install from ollama.com, then `ollama pull qwen2.5:7b` | Text only, runs on the laptop |

Set keys in the terminal that runs the backend:

    export GEMINI_API_KEY=...
    export OPENROUTER_API_KEY=...

Optional: `GEMINI_MODEL`, `OPENROUTER_MODEL`, `OLLAMA_MODEL` to change models (free model names
change often), `PAUSE_SECONDS` (default 4) to wait between page reads for free-tier limits.

## 3. Run (two terminals)

    uvicorn app:app --port 8000          # terminal 1, in this folder
    cd frontend && npm run dev           # terminal 2

Open http://localhost:5173

## How it works

- **Create agent**: saves the uploads in `agents/<id>/`, extracts the equipment list
  (`register.py`, exact), then an LLM reads every rulebook and binder page and writes a summary.
  If no provider answers, the page is kept as plain text and is still searchable.
  If reading stops, **Continue reading** resumes; finished pages are skipped.
- **Questions**: keyword search finds the best-matching pages; the LLM answers from those pages
  plus the equipment list, citing pages. Click a cited page to see the drawing.

| File | Role |
|---|---|
| `app.py` | Backend API used by the React app |
| `agent.py` | Create agent, read pages, answer questions |
| `llm.py` | Provider fallback: Gemini, then OpenRouter, then Ollama |
| `search.py` | Keyword search (SQLite full-text) |
| `register.py`, `equipment.py`, `pages.py` | Equipment list extraction (milestone 1) |
| `score.py`, `ground_truth/` | Connection-tracing evaluation (development only) |
| `frontend/src/App.jsx` | The screen |

## Demo tips

- Create the agent **the night before**: 132 pages on free tiers can take 30+ minutes and may
  hit daily limits (the app then falls back to the next provider).
- Rehearse the questions. Counts use the exact equipment list; connection questions rely on the
  page summaries and work best within one or two sheets.
