import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  askAgent, createAgent, getAgent, getEquipment, getSheets, listAgents, pageImageUrl, resumeAgent,
} from "./api.js";

const HISTORY_MESSAGES = 4; // earlier messages sent with each question, so follow-ups make sense
const CHAT_STORAGE_PREFIX = "edi-chat:"; // chats are kept in this browser, one per binder
const MAX_SAVED_MESSAGES = 50;
const SLOW_ANSWER_SECONDS = 15; // after this long, explain that the local AI can be slow
const POLL_MS = 2000; // how often to check a binder that is being read
const THUMB_DPI = 20; // sheet thumbnails
const DRAWING_DPI = 100; // the drawing tile; the full-size view uses the server default
// A page citation as the backend writes and checks it: "binder p. 12" or "rulebook <file> p. 1".
const CITATION_RE = /\bbinder\s+p\.\s*(\d+)|\brulebook\s+([\w.-]+?)(?:\.pdf)?\s+p\.\s*(\d+)/gi;

// Questions still waiting for an answer: binder id -> promise of the reply message. Kept outside
// the workspace so an answer that arrives after leaving the binder is not lost.
const pendingAnswers = new Map();

// ---------- routing: "#/" is the home page, "#/binder/<id>" a binder ----------

function useRoute() {
  const read = () => {
    const match = window.location.hash.match(/^#\/binder\/([a-z0-9-]+)$/);
    return match ? { view: "binder", id: match[1] } : { view: "home" };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

const binderHref = (id) => `#/binder/${id}`;

export default function App() {
  const route = useRoute();
  return route.view === "binder" ? <Workspace key={route.id} id={route.id} /> : <Home />;
}

function TopBar({ inBinder = false }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/">EDI Platform</a>
      {inBinder && <a className="back-link" href="#/">All binders</a>}
    </header>
  );
}

// ---------- home page: New binder, one tile per binder ----------

const isReading = (info) => info.status === "created" || (info.status === "processing" && info.running);
const isStopped = (info) => info.status === "failed" || (info.status === "processing" && !info.running);

function Home() {
  const [agents, setAgents] = useState(null); // null while loading
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // Load the binders, and keep checking while any of them is being read.
  useEffect(() => {
    let stopped = false;
    let timer;
    const load = async () => {
      try {
        const list = await listAgents();
        if (stopped) return;
        setAgents(list);
        setLoadError("");
        if (list.some(isReading)) timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (!stopped) setLoadError(e.message);
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const onResume = async (id) => {
    await resumeAgent(id);
    reload();
  };

  return (
    <div className="app">
      <TopBar />
      <main className="home">
        <div className="page-head">
          <h1>Binders</h1>
          <p>Upload a P&amp;ID binder, then ask questions about it. Every answer links to the sheet it came from.</p>
        </div>
        {loadError && <p className="error" role="alert">{loadError}</p>}
        <div className="home-grid">
          <NewBinderTile onCreated={reload} />
          <div className="binder-list">
            {agents?.length === 0 && (
              <section className="tile empty-tile">
                <h2>No binders yet</h2>
                <p className="muted">Add a binder PDF on the left to get started.</p>
              </section>
            )}
            {agents?.map((a) =>
              a.status === "ready" ? (
                <OverviewTile key={a.id} agent={a} />
              ) : (
                <ReadingTile key={a.id} agent={a} onResume={() => onResume(a.id)} />
              )
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function NewBinderTile({ onCreated }) {
  const [binder, setBinder] = useState([]);
  const [rulebooks, setRulebooks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await createAgent(binder[0], rulebooks);
      setBinder([]);
      setRulebooks([]);
      onCreated();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tile new-binder" aria-labelledby="new-binder-title">
      <div className="tile-intro">
        <h2 id="new-binder-title">New binder</h2>
        <p className="muted">Drop your PDFs here or choose files.</p>
      </div>
      <DropZone label="Binder" hint="One PDF with all the drawing sheets" files={binder} onChange={setBinder} />
      <DropZone
        label="Rulebooks (optional)"
        hint="Legends, symbols and abbreviations"
        multiple
        files={rulebooks}
        onChange={setRulebooks}
      />
      <div className="spacer" />
      <p className="muted small">Reading takes a few minutes per sheet with the local AI. You can leave and come back.</p>
      <button type="button" className="btn primary big" disabled={!binder.length || busy} onClick={submit}>
        {busy ? "Uploading…" : "Create binder"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function DropZone({ label, hint, multiple = false, files, onChange }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const labelId = useId();
  const hintId = useId();

  const add = (fileList) => {
    const pdfs = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    if (!multiple) return onChange(pdfs.slice(0, 1));
    const names = new Set(files.map((f) => f.name));
    onChange([...files, ...pdfs.filter((f) => !names.has(f.name))]);
  };

  return (
    <div className="dropzone-field">
      <span id={labelId} className="field-label">{label}</span>
      <button
        type="button"
        className={over ? "dropzone over" : "dropzone"}
        aria-labelledby={`${labelId} ${hintId}`}
        onClick={() => inputRef.current.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        <UploadIcon />
        <span id={hintId}>{files.length ? (multiple ? "Add more files" : "Choose a different file") : hint}</span>
      </button>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.name}>
              <span className="file-name">{f.name}</span>
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((other) => other !== f))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = ""; // so choosing the same file again still counts
        }}
      />
    </div>
  );
}

function OverviewTile({ agent }) {
  const titleId = useId();
  return (
    <section className="tile binder-tile" aria-labelledby={titleId}>
      <div className="tile-head">
        <h2 id={titleId} className="binder-name">{agent.name}</h2>
        <StatusPill kind="ready" />
      </div>
      <div className="thumb-strip">
        {[1, 2, 3].map((page) => (
          <img
            key={page}
            src={pageImageUrl(agent.id, { source: "binder", file: "binder.pdf", page }, THUMB_DPI)}
            alt=""
            loading="lazy"
            onError={(e) => { e.currentTarget.hidden = true; }} // binders shorter than 3 sheets
          />
        ))}
      </div>
      <div className="tile-foot">
        <div className="stats">
          <Stat value={agent.total} label="sheets" />
          <Stat value={agent.equipment} label="equipment" />
          <Stat value={agent.rulebooks} label="rulebooks" />
        </div>
        <a className="btn primary" href={binderHref(agent.id)} aria-label={`Open ${agent.name}`}>Open</a>
      </div>
      <span className="muted small">Created {formatDate(agent.created)}</span>
    </section>
  );
}

function ReadingTile({ agent, onResume }) {
  const titleId = useId();
  const stopped = isStopped(agent);
  return (
    <section className="tile reading-tile" aria-labelledby={titleId}>
      <div className="tile-head">
        <h2 id={titleId} className="binder-name">{agent.name}</h2>
        <StatusPill kind={stopped ? "stopped" : "reading"} />
      </div>
      <ReadingProgress info={agent} />
      {stopped ? (
        <div className="stopped-row">
          <p>{agent.error || "Reading stopped before the end. Finished sheets are kept."}</p>
          <button type="button" className="btn secondary" onClick={onResume}>Continue reading</button>
        </div>
      ) : (
        <p className="muted small">You can ask questions once it shows Ready. Finished sheets are kept if reading stops.</p>
      )}
    </section>
  );
}

function ReadingProgress({ info }) {
  const done = Number(info.done || 0);
  const total = Number(info.total || 0);
  const timeLeft = useTimeLeft(info);
  const reading = isReading(info);
  let text = "Starting";
  if (total && reading) text = `Reading sheet ${Math.min(done + 1, total)} of ${total}`;
  if (total && !reading) text = `Stopped after ${done} of ${total} sheets`;
  return (
    <div className="progress-block">
      <div className="progress-line">
        <span className="strong">{text}</span>
        {reading && (
          <span className="muted">{timeLeft === null ? "Estimating time left…" : formatTimeLeft(timeLeft)}</span>
        )}
      </div>
      <progress max={total || 1} value={done} aria-label="Sheets read" />
    </div>
  );
}

// ---------- binder workspace: a status line, the chat, and a panel with drawing, equipment and sheets ----------

function Workspace({ id }) {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [equipment, setEquipment] = useState([]);
  const [sheets, setSheets] = useState([]);
  const [drawing, setDrawing] = useState(null); // the sheet shown in the Drawing tab
  const [tab, setTab] = useState("drawing");
  const [viewerOpen, setViewerOpen] = useState(false); // the full-size drawing
  const [messages, setMessages] = useState(() =>
    pendingAnswers.has(id) ? loadChat(id) : markInterrupted(loadChat(id))
  );
  const [busy, setBusy] = useState(() => pendingAnswers.has(id));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Came back while a question was still waiting: show its answer when it arrives.
  useEffect(() => {
    const pending = pendingAnswers.get(id);
    if (!pending) return;
    let active = true;
    pending.then((message) => {
      if (!active) return;
      setMessages((all) => [...all, message]);
      setBusy(false);
    });
    return () => { active = false; };
  }, [id]);

  // Load the binder, and keep checking while it is being read.
  useEffect(() => {
    let stopped = false;
    let timer;
    const load = async () => {
      try {
        const next = await getAgent(id);
        if (stopped) return;
        setInfo(next);
        if (isReading(next)) timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (!stopped) setLoadError(e.message);
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, reloadKey]);

  // Equipment and sheets are known once the equipment list is built; load them again when reading ends.
  const status = info?.status;
  useEffect(() => {
    if (!status) return;
    getEquipment(id).then(setEquipment).catch(() => setEquipment([]));
    getSheets(id)
      .then((list) => {
        setSheets(list);
        setDrawing((current) => current || list[0] || null);
      })
      .catch(() => setSheets([]));
  }, [id, status]);

  useEffect(() => { saveChat(id, messages); }, [id, messages]);

  const showSheet = (sheet) => {
    setDrawing(sheet);
    setTab("drawing");
  };

  const ready = status === "ready";
  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy || !ready) return;
    const history = messages
      .filter((m) => !m.error)
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((all) => [...all, { role: "user", text: q }]);
    setBusy(true);
    const request = askAgent(id, q, history).then(
      (reply) => ({
        role: "agent", text: reply.answer, provider: reply.provider, sources: reply.sources, cited: reply.cited,
      }),
      (e) => ({ role: "agent", error: true, text: e.message, question: q })
    );
    pendingAnswers.set(id, request);
    const message = await request;
    pendingAnswers.delete(id);
    if (!mounted.current) {
      saveChat(id, [...loadChat(id), message]); // left the binder while waiting: keep the answer for later
      return;
    }
    setMessages((all) => [...all, message]);
    if (message.cited && message.sources.length) showSheet(message.sources[0]); // show the evidence
    setBusy(false);
  };

  if (loadError) {
    return (
      <div className="app">
        <TopBar />
        <main className="home">
          <section className="tile empty-tile" role="alert">
            <h2>This binder couldn't be opened</h2>
            <p className="muted">{loadError}</p>
            <a className="btn secondary" href="#/">Back to binders</a>
          </section>
        </main>
      </div>
    );
  }

  const tabs = [
    { id: "drawing", label: "Drawing" },
    { id: "equipment", label: equipment.length ? `Equipment (${equipment.length})` : "Equipment" },
    { id: "sheets", label: sheets.length ? `Sheets (${sheets.length})` : "Sheets" },
  ];

  return (
    <div className="app">
      <TopBar inBinder />
      {!info ? (
        <main className="home"><p className="muted">Loading…</p></main>
      ) : (
        <main className="workspace">
          <StatusBar info={info} onResume={async () => { await resumeAgent(id); setReloadKey((k) => k + 1); }} />
          <ChatTile
            agentId={id}
            ready={ready}
            busy={busy}
            messages={messages}
            suggestions={suggestedQuestions(equipment, Number(info.rulebooks || 0))}
            onAsk={ask}
            onNewChat={() => setMessages([])}
            onViewSource={showSheet}
          />
          <section className="tile panel-tile" aria-label="Drawing, equipment and sheets">
            <Tabs tabs={tabs} current={tab} onChange={setTab} />
            <div className="panel-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === "drawing" && (
                <DrawingPanel agentId={id} source={drawing} sheets={sheets} onPick={setDrawing} onExpand={() => setViewerOpen(true)} />
              )}
              {tab === "equipment" && (
                <EquipmentTable
                  equipment={equipment}
                  onOpenPage={(page) => showSheet({ source: "binder", file: "binder.pdf", page })}
                />
              )}
              {tab === "sheets" && <SheetList agentId={id} sheets={sheets} current={drawing} onPick={showSheet} />}
            </div>
          </section>
        </main>
      )}
      {viewerOpen && drawing && <PageViewer agentId={id} source={drawing} onClose={() => setViewerOpen(false)} />}
    </div>
  );
}

function StatusBar({ info, onResume }) {
  const total = Number(info.total || 0);
  const done = Number(info.done || 0);
  const plainSheets = total - Number(info.summarised || 0);
  const ready = info.status === "ready";
  const stopped = isStopped(info);
  return (
    <section className="tile status-bar" aria-label="Binder status">
      <div className="status-row">
        <div className="status-title">
          <h1>{info.name}</h1>
          <StatusPill kind={ready ? "ready" : stopped ? "stopped" : "reading"} />
        </div>
        <div className="status-facts">
          <span><strong>{ready ? total : `${done}/${total || "–"}`}</strong> sheets</span>
          <span><strong>{info.equipment || 0}</strong> equipment</span>
          <span><strong>{info.rulebooks || 0}</strong> rulebooks</span>
        </div>
      </div>
      {!ready && <ReadingProgress info={info} />}
      {stopped && (
        <div className="stopped-row">
          <p>{info.error || "Reading stopped before the end. Finished sheets are kept."}</p>
          <button type="button" className="btn secondary" onClick={onResume}>Continue reading</button>
        </div>
      )}
      {ready && plainSheets > 0 && (
        <p className="muted small">
          {plainSheets === 1
            ? "1 sheet couldn't be summarised by the AI, so it's searched by its text only."
            : `${plainSheets} sheets couldn't be summarised by the AI, so they're searched by their text only.`}
        </p>
      )}
    </section>
  );
}

// Tabs with the standard keyboard behaviour: arrow keys move between them.
function Tabs({ tabs, current, onChange }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const i = tabs.findIndex((t) => t.id === current);
    const next = tabs[(i + step + tabs.length) % tabs.length].id;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="Binder panel" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          className="tab"
          aria-selected={t.id === current}
          aria-controls={`panel-${t.id}`}
          tabIndex={t.id === current ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function DrawingPanel({ agentId, source, sheets, onPick, onExpand }) {
  const selectId = useId();
  const index = sheets.findIndex((s) => sameSheet(s, source));
  const current = index >= 0 ? sheets[index] : source;
  if (!current) return <p className="muted">Sheets appear here once the binder is read.</p>;
  return (
    <div className="drawing-panel">
      <div className="tile-head">
        <div className="tile-titles">
          <h2>{sheetTitle(current)}</h2>
          <span className="muted small">{sheetSubtitle(current)}</span>
        </div>
        <IconButton label="Open the drawing full size" onClick={onExpand} />
      </div>
      <div className="drawing-frame">
        <button type="button" className="drawing-button" onClick={onExpand} aria-label={`Open ${sheetTitle(current)} full size`}>
          <img src={pageImageUrl(agentId, current, DRAWING_DPI)} alt={sheetTitle(current)} />
        </button>
      </div>
      <div className="sheet-nav">
        <button type="button" className="btn secondary" disabled={index <= 0} onClick={() => onPick(sheets[index - 1])}>
          Previous
        </button>
        <label htmlFor={selectId} className="visually-hidden">Sheet</label>
        <select id={selectId} value={Math.max(index, 0)} onChange={(e) => onPick(sheets[Number(e.target.value)])}>
          {sheets.map((s, i) => <option key={sheetKey(s)} value={i}>{sheetLabel(s)}</option>)}
        </select>
        <button
          type="button"
          className="btn secondary"
          disabled={index < 0 || index >= sheets.length - 1}
          onClick={() => onPick(sheets[index + 1])}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function SheetList({ agentId, sheets, current, onPick }) {
  if (!sheets.length) return <p className="muted">Sheets appear here once the binder is read.</p>;
  const groups = [
    ["Binder", sheets.filter((s) => s.source === "binder")],
    ["Rulebooks", sheets.filter((s) => s.source === "rulebook")],
  ];
  return (
    <div className="sheet-list">
      {groups.filter(([, list]) => list.length).map(([title, list]) => (
        <section key={title} aria-label={title}>
          <h3>{title}</h3>
          <div className="sheet-grid">
            {list.map((s) => (
              <SheetThumb key={sheetKey(s)} agentId={agentId} sheet={s} selected={sameSheet(s, current)} onPick={onPick} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function EquipmentTable({ equipment, onOpenPage }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState({ key: "tag", dir: 1 });
  const filterId = useId();
  const words = filter.trim().toLowerCase();
  const rows = equipment
    .filter((e) => !words || `${e.tag} ${e.category} ${e.name}`.toLowerCase().includes(words))
    .sort((a, b) => a[sort.key].localeCompare(b[sort.key]) * sort.dir);
  const header = (key, label) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}
      >
        {label}{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  return (
    <div className="equipment-table">
      <label htmlFor={filterId} className="field-label">Filter</label>
      <input
        id={filterId}
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Tag, category or name"
      />
      <p className="muted small" aria-live="polite">{rows.length} of {equipment.length} items</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>{header("tag", "Tag")}{header("category", "Category")}{header("name", "Name")}<th scope="col">Sheets</th></tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.tag}>
                <td className="strong">{e.tag}</td>
                <td>{e.category}</td>
                <td>{e.name || "–"}</td>
                <td>
                  <div className="page-links">
                    {e.pages.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="chip"
                        aria-label={`Open binder page ${p} for ${e.tag}`}
                        onClick={() => onOpenPage(p)}
                      >
                        p. {p}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SheetThumb({ agentId, sheet, selected = false, onPick }) {
  return (
    <button type="button" className={selected ? "sheet-thumb selected" : "sheet-thumb"} onClick={() => onPick(sheet)}>
      <img src={pageImageUrl(agentId, sheet, THUMB_DPI)} alt="" loading="lazy" />
      <span className="thumb-caption">{sheetLabel(sheet)}</span>
    </button>
  );
}

// ---------- chat ----------

function ChatTile({ agentId, ready, busy, messages, suggestions, onAsk, onNewChat, onViewSource }) {
  const [question, setQuestion] = useState("");
  const inputId = useId();
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, busy]);

  const submit = (text) => {
    if (!text.trim()) return;
    onAsk(text);
    setQuestion("");
  };

  return (
    <section className="tile chat-tile" aria-label="Chat">
      <div className="tile-head">
        <h2>Ask this binder</h2>
        {messages.length > 0 && (
          <div className="chat-actions">
            <span className="muted small">Follow-up questions build on this conversation.</span>
            <button type="button" className="btn secondary" onClick={onNewChat} disabled={busy}>New chat</button>
          </div>
        )}
      </div>
      <div className="messages">
        {!messages.length && (
          <div className="starter">
            <p className="muted">
              {ready
                ? "Ask about equipment, connections, notes or codes. Answers link to the sheet they came from."
                : "The binder is still being read. You can ask questions once it shows Ready."}
            </p>
            {ready && suggestions.length > 0 && (
              <div className="suggestions">
                {suggestions.map((q) => (
                  <button key={q} type="button" disabled={busy} onClick={() => onAsk(q)}>{q}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <article key={i} className={`message ${m.role}${m.error ? " failed" : ""}`}>
            <FormattedText text={m.text} sources={m.sources || []} agentId={agentId} onViewSource={onViewSource} />
            {m.error && m.question && i === messages.length - 1 && (
              <button type="button" className="retry" onClick={() => onAsk(m.question)} disabled={busy || !ready}>
                Try again
              </button>
            )}
            {m.sources?.length > 0 && (
              <div className="answer-foot">
                <div className="sources">
                  <span className="muted small">{m.cited ? "Sources" : "Pages searched"}</span>
                  {m.sources.map((s) => (
                    <button key={sheetKey(s)} type="button" className="chip" onClick={() => onViewSource(s)}>
                      {s.source === "binder" ? `Binder p. ${s.page}` : `${stem(s.file)} p. ${s.page}`}
                    </button>
                  ))}
                </div>
                {m.provider && (
                  <span className="muted small">
                    {m.provider === "Ollama" ? "Answered by the local AI (Ollama)" : `Answered by ${m.provider} (cloud AI)`}
                  </span>
                )}
              </div>
            )}
          </article>
        ))}
        {busy && <Waiting />}
        <div ref={endRef} />
      </div>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">Question</label>
        <input
          id={inputId}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={ready ? "Ask about this binder" : "Available once the binder is read"}
          disabled={!ready}
          autoComplete="off"
        />
        <button className="btn primary" disabled={!ready || busy || !question.trim()}>Ask</button>
      </form>
    </section>
  );
}

// Shows the time spent on the current question, so a slow answer doesn't look like a frozen app.
function Waiting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="thinking" role="status">
      <span>
        Reading the drawings… <span aria-hidden="true">{seconds} s</span>
      </span>
      {seconds >= SLOW_ANSWER_SECONDS && (
        <span className="small">Answers usually take under 30 seconds, occasionally up to 2½ minutes.</span>
      )}
    </div>
  );
}

// Shows line breaks and **bold** from the model's reply without rendering raw HTML.
// Page citations that match the answer's sources become links to the page.
function FormattedText({ text, sources, agentId, onViewSource }) {
  const cite = (part) => withCitations(part, sources, agentId, onViewSource);
  return (
    <div className="text">
      {text.split("\n").map(plainLine).map((line, i) => (
        <p key={i}>
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong key={j}>{cite(part.slice(2, -2))}</strong>
            ) : (
              <Fragment key={j}>{cite(stripItalics(part))}</Fragment>
            )
          )}
        </p>
      ))}
    </div>
  );
}

// "*(rulebook … p. 1)*" -> "(rulebook … p. 1)": the chat shows no italics, so drop the asterisks.
const stripItalics = (text) => text.replace(/\*([^*]+)\*/g, "$1");

// The prompt asks for plain text, but a model may still write "### Heading" or "* item".
function plainLine(line) {
  return line.replace(/^#+\s+/, "").replace(/^(\s*)\*\s+/, "$1- ");
}

function withCitations(text, sources, agentId, onViewSource) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_RE)) {
    const source = findCitedSource(match, sources);
    if (!source) continue;
    parts.push(text.slice(last, match.index));
    // A link (not a button) so a long citation wraps with the sentence.
    parts.push(
      <a
        key={match.index}
        className="cite"
        href={pageImageUrl(agentId, source)}
        onClick={(e) => {
          e.preventDefault();
          onViewSource(source);
        }}
      >
        {match[0]}
      </a>
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function findCitedSource([, binderPage, rulebook, rulebookPage], sources) {
  return sources.find((s) =>
    binderPage
      ? s.source === "binder" && s.page === Number(binderPage)
      : s.source === "rulebook" && s.page === Number(rulebookPage) &&
        s.file.replace(/\.pdf$/i, "").toLowerCase() === rulebook.toLowerCase()
  );
}

// ---------- dialogs ----------

function Modal({ title, actions = null, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal-frame" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <div className="modal-actions">
            {actions}
            <button type="button" className="btn secondary" onClick={onClose} autoFocus>Close</button>
          </div>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function PageViewer({ agentId, source, onClose }) {
  const [fullSize, setFullSize] = useState(false); // false: fit the page to the window
  const title = sheetTitle(source);
  const toggle = (
    <button type="button" className="btn secondary" onClick={() => setFullSize((f) => !f)} aria-pressed={fullSize}>
      {fullSize ? "Fit to window" : "Full size"}
    </button>
  );
  return (
    <Modal title={title} actions={toggle} onClose={onClose}>
      <div className="viewer-body">
        <img
          src={pageImageUrl(agentId, source)}
          alt={title}
          className={fullSize ? "full-size" : ""}
          onClick={() => setFullSize((f) => !f)}
        />
      </div>
    </Modal>
  );
}

// ---------- small shared pieces ----------

function StatusPill({ kind }) {
  const text = { ready: "Ready", reading: "Reading", stopped: "Stopped" }[kind];
  return <span className={`pill ${kind}`}><span className="pill-dot" aria-hidden="true" />{text}</span>;
}

function Stat({ value, label }) {
  return (
    <div className="stat">
      <span className="stat-value">{value === undefined || value === "" ? "–" : value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function IconButton({ label, onClick, disabled = false }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} onClick={onClick} disabled={disabled}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
      </svg>
    </button>
  );
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </svg>
  );
}

// ---------- helpers ----------

const stem = (file) => file.replace(/\.pdf$/i, "");
const sheetKey = (s) => `${s.source}-${s.file}-${s.page}`;
const sameSheet = (a, b) => Boolean(a && b) && a.source === b.source && a.file === b.file && a.page === b.page;

// "Binder p. 1: 0751-V-101" (the equipment titled on the sheet) or "PP05-...-8030_RevZ1 p. 1".
function sheetLabel(s) {
  if (s.source !== "binder") return `${stem(s.file)} p. ${s.page}`;
  const tags = s.equipment || [];
  if (!tags.length) return `Binder p. ${s.page}`;
  const more = tags.length > 2 ? ` +${tags.length - 2}` : "";
  return `Binder p. ${s.page}: ${tags.slice(0, 2).join(", ")}${more}`;
}

const sheetTitle = (s) => (s.source === "binder" ? `Binder page ${s.page}` : `${stem(s.file)}, page ${s.page}`);

function sheetSubtitle(s) {
  if (s.source !== "binder") return "Rulebook";
  return s.equipment?.length ? s.equipment.join(", ") : "No equipment titled on this sheet";
}

function countByCategory(equipment) {
  const counts = {};
  for (const e of equipment) counts[e.category] = (counts[e.category] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// Questions that fit this binder: a count of its most common equipment, one vessel's design
// pressure, and an abbreviation when there are rulebooks to look it up in.
function suggestedQuestions(equipment, rulebookCount) {
  const questions = [];
  const top = countByCategory(equipment).find(([c]) => c !== "Unknown" && c !== "Miscellaneous item");
  if (top) questions.push(`How many ${plural(top[0])} are there?`);
  const vessel = equipment.find((e) => e.category === "Vessel / drum") || equipment[0];
  if (vessel) questions.push(`What is the design pressure of ${vessel.tag}?`);
  if (rulebookCount > 0) questions.push("What does LO mean?");
  return questions;
}

// "Pump" -> "pumps", "Vessel / drum" -> "vessels".
function plural(category) {
  const word = category.split(" / ")[0].toLowerCase();
  return word.endsWith("s") ? word : `${word}s`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "–"
    : date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Estimates the time left from the reading pace seen since this binder was opened.
function useTimeLeft(info) {
  const start = useRef(null); // { id, done, time } when reading was first seen
  const done = Number(info.done || 0);
  const total = Number(info.total || 0);
  if (!isReading(info)) {
    start.current = null;
    return null;
  }
  if (!start.current || start.current.id !== info.id) start.current = { id: info.id, done, time: Date.now() };
  const sheetsRead = done - start.current.done;
  if (sheetsRead < 1) return null;
  return ((Date.now() - start.current.time) / sheetsRead) * (total - done);
}

function formatTimeLeft(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "Less than a minute left";
  return minutes === 1 ? "About 1 minute left" : `About ${minutes} minutes left`;
}

// A saved chat that ends with a question and nothing still waiting was interrupted by a reload.
function markInterrupted(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  return [...messages, {
    role: "agent", error: true, question: last.text,
    text: "This question was still waiting for an answer when the page was closed.",
  }];
}

function loadChat(agentId) {
  try {
    return JSON.parse(localStorage.getItem(CHAT_STORAGE_PREFIX + agentId)) || [];
  } catch {
    return [];
  }
}

function saveChat(agentId, messages) {
  try {
    localStorage.setItem(CHAT_STORAGE_PREFIX + agentId, JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES)));
  } catch {
    // storage full or blocked: the chat still works, it just isn't kept after a refresh
  }
}