// Small wrapper around the backend API. Throws an Error with the server's message on failure.

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch {
    throw new Error("Can't reach the EDI server. Check that the backend is running, then try again.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (body.detail) message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // response was not JSON; keep the generic message
    }
    throw new Error(message);
  }
  return response.json();
}

export const listAgents = () => request("/agents");

export const getAgent = (id) => request(`/agents/${id}`);

export const resumeAgent = (id) => request(`/agents/${id}/resume`, { method: "POST" });

export function createAgent(binder, rulebooks) {
  const form = new FormData();
  form.append("binder", binder);
  rulebooks.forEach((file) => form.append("rulebooks", file));
  return request("/agents", { method: "POST", body: form });
}

// history: earlier messages in this chat as [{ role: "user" | "agent", text }], oldest first.
export const askAgent = (id, question, history = []) =>
  request(`/agents/${id}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });

export const pageImageUrl = (id, source) =>
  `/api/agents/${id}/page?source=${source.source}&file=${encodeURIComponent(source.file)}&page=${source.page}`;