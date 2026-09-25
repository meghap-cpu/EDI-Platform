import { useEffect, useRef, useState } from "react";
import { askAgent, createAgent, getAgent, listAgents, pageImageUrl, resumeAgent } from "./api.js";

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

  const addMessage = (message) =>
    setMessages((all) => ({ ...all, [selectedId]: [...(all[selectedId] || []), message] }));

  return (
    <div className="layout">
      <aside className="setup">
        <h1 className="brand">Binder agent</h1>
        <p className="lede">Upload a P&amp;ID binder and its rulebooks, then ask anything about them.</p>
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
      {info.status === "ready" && Number(info.summarised) < total && (
        <div className="tb-cell tb-wide tb-note">
          {total - Number(info.summarised)} sheets were stored as plain text because no AI provider answered.
          They can still be searched.
        </div>
      )}
    </section>
  );
}

function Chat({ agentId, ready, messages, addMessage, onViewSource }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    addMessage({ role: "user", text: q });
    setQuestion("");
    setBusy(true);
    try {
      const reply = await askAgent(agentId, q);
      addMessage({ role: "agent", text: reply.answer, provider: reply.provider, sources: reply.sources });
    } catch (e) {
      addMessage({ role: "agent", error: true, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat">
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
              <p>The agent is reading the binder. You can ask questions once it shows Ready.</p>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <article key={i} className={`message ${m.role}${m.error ? " failed" : ""}`}>
            <FormattedText text={m.text} />
            {m.sources?.length > 0 && (
              <div className="sources">
                <span>Checked:</span>
                {m.sources.map((s) => (
                  <button key={`${s.source}-${s.file}-${s.page}`} onClick={() => onViewSource(s)}>
                    {s.source === "binder" ? `Binder p. ${s.page}` : `${s.file.replace(/\.pdf$/i, "")} p. ${s.page}`}
                  </button>
                ))}
              </div>
            )}
            {m.provider && <span className="provider">Answered by {m.provider}</span>}
          </article>
        ))}
        {busy && <p className="thinking">Looking through the binder…</p>}
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
          placeholder={ready ? "Ask about this binder" : "Available when the agent is ready"}
          disabled={!ready}
          autoComplete="off"
        />
        <button className="primary" disabled={!ready || busy || !question.trim()}>Ask</button>
      </form>
    </section>
  );
}

// Shows line breaks and **bold** from the model's reply without rendering raw HTML.
function FormattedText({ text }) {
  return (
    <div className="text">
      {text.split("\n").map((line, i) => (
        <p key={i}>
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? <strong key={j}>{part.slice(2, -2)}</strong> : part
          )}
        </p>
      ))}
    </div>
  );
}

function PageViewer({ agentId, source, onClose }) {
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
          <button onClick={onClose} autoFocus>Close</button>
        </header>
        <div className="viewer-body">
          <img src={pageImageUrl(agentId, source)} alt={title} />
        </div>
      </div>
    </div>
  );
}
