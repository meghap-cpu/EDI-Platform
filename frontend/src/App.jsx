import { Fragment, useEffect, useRef, useState } from "react";
import { askAgent, createAgent, getAgent, listAgents, pageImageUrl, resumeAgent } from "./api.js";

const HISTORY_MESSAGES = 4; // earlier messages sent with each question, so follow-ups make sense
const CHAT_STORAGE_PREFIX = "edi-chat:"; // chats are kept in this browser, one per agent
const MAX_SAVED_MESSAGES = 50;
const SLOW_ANSWER_SECONDS = 15; // after this long, explain that the local AI can be slow
// A page citation as the backend writes and checks it: "binder p. 12" or "rulebook <file> p. 1".
const CITATION_RE = /\bbinder\s+p\.\s*(\d+)|\brulebook\s+([\w.-]+?)(?:\.pdf)?\s+p\.\s*(\d+)/gi;

const EXAMPLE_QUESTIONS = [
  "How many pumps are there?",
  "What is the design pressure of 0751-V-101?",
  "Where does the sour water from 0751-V-101 go?",
  "What does LO mean?",
];

export default function App() {
  const [agents, setAgents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [info, setInfo] = useState(null);
  const [messages, setMessages] = useState({}); // agent id -> list of messages
  const [viewing, setViewing] = useState(null); // source being shown in the page viewer
  const [reloadKey, setReloadKey] = useState(0); // bump to restart polling after "Continue reading"

  const refreshAgents = () => listAgents().then(setAgents).catch(() => setAgents([]));
  useEffect(() => { refreshAgents(); }, []);

  // Load the selected agent, and keep polling while it is being built.
  useEffect(() => {
    if (!selectedId) return;
    let stopped = false;
    const load = async () => {
      try {
        const next = await getAgent(selectedId);
        if (stopped) return;
        setInfo(next);
        if (next.status === "created" || (next.status === "processing" && next.running)) {
          setTimeout(load, 2000);
        } else {
          refreshAgents();
        }
      } catch {
        if (!stopped) setInfo(null);
      }
    };
    load();
    return () => { stopped = true; };
  }, [selectedId, reloadKey]);

  const onCreated = (agent) => {
    refreshAgents();
    setSelectedId(agent.id);
  };

  const onResume = async () => {
    await resumeAgent(selectedId);
    setReloadKey((k) => k + 1);
  };

  // Load a chat from this browser the first time its agent is opened, and save it on every change.
  useEffect(() => {
    if (selectedId && !(selectedId in messages)) {
      setMessages((all) => ({ ...all, [selectedId]: loadChat(selectedId) }));
    }
  }, [selectedId]);
  useEffect(() => {
    if (selectedId && messages[selectedId]) saveChat(selectedId, messages[selectedId]);
  }, [selectedId, messages]);

  const addMessage = (message) =>
    setMessages((all) => ({ ...all, [selectedId]: [...(all[selectedId] || []), message] }));
  const clearChat = () => setMessages((all) => ({ ...all, [selectedId]: [] }));

  return (
    <div className="layout">
      <aside className="setup">
        <h1 className="brand">EDI Platform</h1>
        <p className="lede">
          Engineering Document Intelligence. Upload a P&amp;ID binder and its rulebooks, then ask anything about them.
        </p>
        <UploadPanel onCreated={onCreated} />
        <AgentList agents={agents} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>

      <main className="workspace">
        {info ? (
          <>
            <TitleBlock info={info} onResume={onResume} />
            <Chat
              agentId={selectedId}
              ready={info.status === "ready"}
              messages={messages[selectedId] || []}
              addMessage={addMessage}
              onNewChat={clearChat}
              onViewSource={setViewing}
            />
          </>
        ) : (
          <div className="empty">
            <p>Create an agent on the left, or open one you made earlier.</p>
          </div>
        )}
      </main>

      {viewing && <PageViewer agentId={selectedId} source={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function UploadPanel({ onCreated }) {
  const [binder, setBinder] = useState(null);
  const [rulebooks, setRulebooks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated(await createAgent(binder, rulebooks));
      setBinder(null);
      setRulebooks([]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="upload">
      <FileSlot
        label="Binder"
        hint="One PDF with all the drawing sheets"
        files={binder ? [binder] : []}
        onChange={(files) => setBinder(files[0] || null)}
      />
      <FileSlot
        label="Rulebooks"
        hint="One or more PDFs: legends, symbols, codes"
        multiple
        files={rulebooks}
        onChange={setRulebooks}
      />
      <button className="primary" disabled={!binder || rulebooks.length === 0 || busy} onClick={submit}>
        {busy ? "Uploading…" : "Create agent"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function FileSlot({ label, hint, multiple = false, files, onChange }) {
  const inputRef = useRef(null);
  return (
    <div className="slot">
      <span className="slot-label">{label}</span>
      <button type="button" className="dropzone" onClick={() => inputRef.current.click()}>
        {files.length ? files.map((f) => <span key={f.name} className="file">{f.name}</span>) : <span className="hint">{hint}</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple={multiple}
        hidden
        onChange={(e) => onChange(Array.from(e.target.files))}
      />
    </div>
  );
}

function AgentList({ agents, selectedId, onSelect }) {
  if (!agents.length) return null;
  return (
    <section className="agents">
      <h2>Your agents</h2>
      <ul>
        {agents.map((a) => (
          <li key={a.id}>
            <button className={a.id === selectedId ? "agent active" : "agent"} onClick={() => onSelect(a.id)}>
              <span className="agent-name">{a.name}</span>
              <span className="agent-meta">{new Date(a.created).toLocaleString()} ({a.status})</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TitleBlock({ info, onResume }) {
  const done = Number(info.done || 0);
  const total = Number(info.total || 0);
  const stalled = info.status === "processing" && !info.running;
  const timeLeft = useTimeLeft(info);
  const plainSheets = total - Number(info.summarised);
  const statusText = {
    created: "Starting",
    processing: stalled ? "Paused" : total ? `Reading sheet ${Math.min(done + 1, total)} of ${total}` : "Starting",
    ready: "Ready",
    failed: "Stopped",
  }[info.status] || info.status;

  return (
    <section className="titleblock" aria-live="polite">
      <div className="tb-cell tb-wide">
        <span className="tb-key">Binder</span>
        <span className="tb-value">{info.name}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-key">Created</span>
        <span className="tb-value">{new Date(info.created).toLocaleString()}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-key">Sheets read</span>
        <span className="tb-value">{total ? `${done} / ${total}` : "–"}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-key">Equipment found</span>
        <span className="tb-value">{info.equipment || "–"}</span>
      </div>
      <div className="tb-cell tb-status">
        {info.status === "ready" ? (
          <span className="stamp">Ready</span>
        ) : (
          <span className="tb-value">{statusText}</span>
        )}
        {info.status === "processing" && info.running && (
          <span className="tb-eta">{timeLeft === null ? "Estimating time left…" : formatTimeLeft(timeLeft)}</span>
        )}
        {total > 0 && info.status !== "ready" && (
          <progress max={total} value={done} aria-label="Sheets read" />
        )}
      </div>
      {(stalled || info.status === "failed") && (
        <div className="tb-cell tb-wide tb-action">
          <span>{info.error || "Reading stopped before the end. Finished sheets are kept."}</span>
          <button onClick={onResume}>Continue reading</button>
        </div>
      )}
      {info.status === "ready" && plainSheets > 0 && (
        <div className="tb-cell tb-wide tb-note">
          {plainSheets === 1
            ? "1 sheet couldn't be summarised by the AI, so it's searched by its text only."
            : `${plainSheets} sheets couldn't be summarised by the AI, so they're searched by their text only.`}
        </div>
      )}
    </section>
  );
}

// Estimates the time left from the reading pace seen since this agent was opened.
function useTimeLeft(info) {
  const start = useRef(null); // { id, done, time } when reading was first seen
  const done = Number(info.done || 0);
  const total = Number(info.total || 0);
  if (info.status !== "processing" || !info.running) {
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

function Chat({ agentId, ready, messages, addMessage, onNewChat, onViewSource }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    const history = messages
      .filter((m) => !m.error)
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, text: m.text }));
    addMessage({ role: "user", text: q });
    setQuestion("");
    setBusy(true);
    try {
      const reply = await askAgent(agentId, q, history);
      addMessage({
        role: "agent", text: reply.answer, provider: reply.provider, sources: reply.sources, cited: reply.cited,
      });
    } catch (e) {
      addMessage({ role: "agent", error: true, text: e.message, question: q });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat">
      {messages.length > 0 && (
        <div className="chat-bar">
          <span>Follow-up questions build on this conversation.</span>
          <button type="button" onClick={onNewChat} disabled={busy}>New chat</button>
        </div>
      )}
      <div className="messages">
        {!messages.length && (
          <div className="starter">
            {ready ? (
              <>
                <p>Ask about equipment, connections, notes or codes. For example:</p>
                <div className="examples">
                  {EXAMPLE_QUESTIONS.map((q) => (
                    <button key={q} onClick={() => ask(q)}>{q}</button>
                  ))}
                </div>
              </>
            ) : (
              <p>The binder is still being read. You can ask questions once it shows Ready.</p>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <article key={i} className={`message ${m.role}${m.error ? " failed" : ""}`}>
            <FormattedText text={m.text} sources={m.sources || []} agentId={agentId} onViewSource={onViewSource} />
            {m.error && m.question && i === messages.length - 1 && (
              <button type="button" className="retry" onClick={() => ask(m.question)} disabled={busy || !ready}>
                Try again
              </button>
            )}
            {m.sources?.length > 0 && (
              <div className="sources">
                <span>{m.cited ? "Sources:" : "Pages searched:"}</span>
                {m.sources.map((s) => (
                  <button key={`${s.source}-${s.file}-${s.page}`} onClick={() => onViewSource(s)}>
                    {s.source === "binder" ? `Binder p. ${s.page}` : `${s.file.replace(/\.pdf$/i, "")} p. ${s.page}`}
                  </button>
                ))}
              </div>
            )}
            {m.provider && (
              <span className="provider">
                {m.provider === "Ollama" ? "Answered by the local AI (Ollama)" : `Answered by ${m.provider} (cloud AI)`}
              </span>
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
          ask(question);
        }}
      >
        <label htmlFor="question" className="visually-hidden">Question</label>
        <input
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={ready ? "Ask about this binder" : "Available once the binder is read"}
          disabled={!ready}
          autoComplete="off"
        />
        <button className="primary" disabled={!ready || busy || !question.trim()}>Ask</button>
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
        <span className="thinking-hint">Answers usually take under 30 seconds, occasionally up to 2½ minutes.</span>
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
              <Fragment key={j}>{cite(part)}</Fragment>
            )
          )}
        </p>
      ))}
    </div>
  );
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

// The prompt asks for plain text, but a model may still write "### Heading" or "* item".
function plainLine(line) {
  return line.replace(/^#+\s+/, "").replace(/^(\s*)\*\s+/, "$1- ");
}

function PageViewer({ agentId, source, onClose }) {
  const [fullSize, setFullSize] = useState(false); // false: fit the page to the window
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = source.source === "binder" ? `Binder page ${source.page}` : `${source.file}, page ${source.page}`;
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="viewer-frame" onClick={(e) => e.stopPropagation()}>
        <header>
          <span>{title}</span>
          <span className="viewer-actions">
            <button onClick={() => setFullSize((f) => !f)} aria-pressed={fullSize}>
              {fullSize ? "Fit to window" : "Full size"}
            </button>
            <button onClick={onClose} autoFocus>Close</button>
          </span>
        </header>
        <div className="viewer-body">
          <img
            src={pageImageUrl(agentId, source)}
            alt={title}
            className={fullSize ? "full-size" : ""}
            onClick={() => setFullSize((f) => !f)}
          />
        </div>
      </div>
    </div>
  );
}