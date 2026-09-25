# EDI Platform: Setup Guide

EDI Platform (Engineering Document Intelligence) reads a P&ID binder and its rulebooks, and answers questions about them with page references. It runs fully on one machine: a Python backend, a React frontend, and a local AI model through Ollama. No drawings leave the machine unless you add cloud API keys.

## 1. What you need

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.10 or newer | Tested with 3.12 |
| Node.js | 20.19 or newer (22 LTS recommended) | Includes npm; needed by the Vite version in use |
| Ollama | Latest | Runs the local AI model |
| GPU | 8 GB video memory recommended | The default model uses about 6.7 GB. It also runs on a CPU, but much more slowly. |
| Disk space | About 10 GB | For the model and the uploaded PDFs |

The project folder looks like this:

```
engineering-document-intelligence-platform/
├── backend/     Python API (FastAPI), PDF reading, search
├── frontend/    React app (Vite)
└── data/        Sample binder and rulebook PDFs
```

## 2. Install Ollama and the AI model

Install Ollama:

- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh`
- **macOS or Windows:** download the installer from https://ollama.com/download

Download the model (about 3 GB):

```
ollama pull qwen3-vl:4b
```

Check that it works:

```
ollama run qwen3-vl:4b "Say hello in one word."
```

## 3. Set up the backend

From the project folder:

```
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Start the backend:

```
PAUSE_SECONDS=0 uvicorn app:app --port 8000
```

On Windows PowerShell, set the variable first: `$env:PAUSE_SECONDS="0"`, then run `uvicorn app:app --port 8000`.

`PAUSE_SECONDS=0` removes a 4-second wait between pages that only matters for free cloud AI services. Leave the terminal open; this is where errors are printed.

To confirm the backend is running, open http://localhost:8000/api/agents in a browser. You should see `[]` (an empty list) on a new install.

## 4. Set up the frontend

In a second terminal, from the project folder:

```
cd frontend
npm install
npm run dev
```

Open the address it prints, normally http://localhost:5173.

The frontend sends every request starting with `/api` to the backend on port 8000. This is set in `frontend/vite.config.js`. If you change the backend port, change it there too.

## 5. Use it

1. **Create an agent.** On the left, choose the binder PDF (all drawing sheets in one file) and one or more rulebook PDFs (legends, symbols, abbreviations). Click **Create agent**.
2. **Wait for it to read.** The title block shows "Reading sheet X of Y". Each sheet takes up to a few minutes with the local model. A 3-page binder with 5 rulebook sheets takes roughly 10 to 30 minutes on a laptop GPU.
3. **Ask questions** once it shows **Ready**. Every answer lists its source pages. Click one to see the original drawing, and use **Full size** to read small text.

If reading stops (server restart, AI not answering), click **Continue reading**. Finished sheets are kept.

To try it quickly, use the sample files in `data/`: `Binder1_first3.pdf` as the binder, and the `PP05-0500-00-PID-80xx` files as rulebooks.

## 6. Settings

All settings are environment variables, set before starting the backend. The defaults work for a standard local setup.

| Variable | Default | What it does |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Where Ollama is running |
| `OLLAMA_MODEL` | `qwen3-vl:4b` | Which local model to use |
| `OLLAMA_NUM_CTX` | `16384` | How much text the model can take in at once. Higher helps dense sheets but uses more GPU memory. |
| `OLLAMA_TEMPERATURE` | `0.2` | Keep low, so values are copied faithfully and answers are repeatable |
| `PAUSE_SECONDS` | `4` | Wait between pages. Use `0` with Ollama. |
| `AGENTS_DIR` | `agents` | Where agents and their data are stored |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Not set | Optional cloud AI, tried before Ollama |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Not set | Optional cloud AI, tried before Ollama |

**Privacy:** the system tries Gemini first, then OpenRouter, then Ollama. Without those API keys, only Ollama is used and the drawings stay on the machine. If you set a key, pages are sent to that cloud service.

## 7. Where the data is stored

Each agent has its own folder under `backend/agents/`:

```
agents/<agent-id>/
├── input/binder.pdf           the uploaded binder
├── input/rulebooks/*.pdf      the uploaded rulebooks
└── agent.db                   everything it extracted (SQLite)
```

To delete an agent, stop the backend and delete its folder. To move agents to another machine, copy the folders.

To build just the equipment list from a binder, without the AI or the web app:

```
python register.py path/to/Binder.pdf
```

## 8. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| "No AI service answered just now" | Ollama isn't running, or took longer than 150 seconds. Run `ollama ps` to check it's running, and look for an "Answer failed" line in the backend terminal for the exact reason. |
| The first answer is slow | Ollama is loading the model. Later answers are faster. To keep the model loaded, start Ollama with `OLLAMA_KEEP_ALIVE=2h`. |
| "This agent is not ready yet" | The agent is still reading. Wait for **Ready**. |
| "N sheets were stored as plain text" | The AI couldn't summarise those sheets. They're still searchable by their text. To retry them: `curl -X POST http://localhost:8000/api/agents/<agent-id>/resume`, then click the agent in the list to follow progress. |
| The frontend loads but shows no agents or errors | The backend isn't running on port 8000, or `vite.config.js` points elsewhere. |
| `ollama ps` shows a CPU/GPU split | Not enough GPU memory. Answers will be slow. Lower `OLLAMA_NUM_CTX` or use a machine with more GPU memory. |
| `pip install` fails on `pymupdf` | Upgrade pip first: `pip install --upgrade pip` |

## 9. Known limits

- **Equipment tags and counts** are extracted exactly from the drawings. **Data values** (pressures, temperatures, connections) come from AI reading of each sheet and should be checked against the source page.
- **Scanned sheets, and sheets whose text is drawn as lines,** aren't read for the equipment list yet.
- **Search matches exact word forms:** "pumps" doesn't match "pump".
- **Very dense sheets** can overwhelm the local model, which then stores them as plain text.
- **The chat history** is lost when the page is refreshed.