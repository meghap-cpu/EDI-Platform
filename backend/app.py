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
    return agent.list_agents()


@app.post("/api/agents")
async def create_agent(binder: UploadFile = File(...), rulebooks: list[UploadFile] = File(...)):
    if not binder.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "The binder must be a PDF file.")
    rulebook_files = [(f.filename, await f.read()) for f in rulebooks if f.filename.lower().endswith(".pdf")]
    if not rulebook_files:
        raise HTTPException(400, "Add at least one rulebook PDF.")
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
        raise HTTPException(409, "This agent is not ready yet.")
    try:
        return agent.answer(agent_id, body.question, [(m.role, m.text) for m in body.history])
    except llm.LLMError as error:
        print(f"Answer failed for agent {agent_id}: {error}")  # full detail for the server log
        raise HTTPException(503, "No AI service answered just now. Please try again in a minute.")


@app.get("/api/agents/{agent_id}/page")
def page(agent_id: str, source: str, file: str, page: int):
    _require(agent_id)
    try:
        return Response(agent.page_image(agent_id, source, file, page), media_type="image/png")
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
        raise HTTPException(404, "No agent with that id.")