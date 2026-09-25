"""Backend API for the React app.

Run:  uvicorn app:app --port 8000
"""

import threading
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import agent
import llm

app = FastAPI(title="Binder agent")
_building = set()  # agent ids with a build running in this process
_lock = threading.Lock()


class Message(BaseModel):
    role: Literal["user", "agent"]
    text: str


class Question(BaseModel):
    question: str
    history: list[Message] = []  # earlier messages in this chat, oldest first


@app.get("/api/agents")
def list_agents():
    return [{**info, "running": info["id"] in _building} for info in agent.list_agents()]


@app.post("/api/agents")
async def create_agent(binder: UploadFile = File(...), rulebooks: list[UploadFile] = File(default=[])):
    if not binder.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "The binder must be a PDF file.")
    # Rulebooks are optional; non-PDF files among them are ignored.
    rulebook_files = [(f.filename, await f.read()) for f in rulebooks if f.filename.lower().endswith(".pdf")]
    agent_id = agent.create_agent(binder.filename, await binder.read(), rulebook_files)
    _start_build(agent_id)
    return agent.get_info(agent_id)


@app.get("/api/agents/{agent_id}")
def get_agent(agent_id: str):
    _require(agent_id)
    info = agent.get_info(agent_id)
    info["running"] = agent_id in _building
    return info


@app.post("/api/agents/{agent_id}/resume")
def resume_agent(agent_id: str):
    """Continue a build that stopped (server restart, all providers failing, etc.)."""
    _require(agent_id)
    _start_build(agent_id)
    return agent.get_info(agent_id)


@app.post("/api/agents/{agent_id}/ask")
def ask(agent_id: str, body: Question):
    _require(agent_id)
    if agent.get_info(agent_id).get("status") != "ready":
        raise HTTPException(409, "This binder is still being read. Ask again once it shows Ready.")
    try:
        return agent.answer(agent_id, body.question, [(m.role, m.text) for m in body.history])
    except llm.LLMError as error:
        print(f"Answer failed for agent {agent_id}: {error}")  # full detail for the server log
        raise HTTPException(503, "No AI service answered just now. Please try again in a minute.")


@app.get("/api/agents/{agent_id}/equipment")
def equipment(agent_id: str):
    _require(agent_id)
    return agent.list_equipment(agent_id)


@app.get("/api/agents/{agent_id}/sheets")
def sheets(agent_id: str):
    _require(agent_id)
    return agent.list_sheets(agent_id)


@app.get("/api/agents/{agent_id}/page")
def page(agent_id: str, source: str, file: str, page: int, dpi: int = 150):
    _require(agent_id)
    dpi = min(max(dpi, 20), 200)  # small thumbnails up to the full-size view
    try:
        return Response(agent.page_image(agent_id, source, file, page, dpi), media_type="image/png")
    except (IndexError, FileNotFoundError, ValueError):
        raise HTTPException(404, "Page not found.")


def _start_build(agent_id):
    with _lock:
        if agent_id in _building:
            return
        _building.add(agent_id)

    def run():
        try:
            agent.build_agent(agent_id)
        finally:
            _building.discard(agent_id)

    threading.Thread(target=run, daemon=True).start()


def _require(agent_id):
    if not agent.agent_exists(agent_id):
        raise HTTPException(404, "No binder with that id.")