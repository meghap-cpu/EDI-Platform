"""Send a prompt to an LLM, trying providers in order: Gemini, OpenRouter, Ollama.

Settings come from environment variables:
  GEMINI_API_KEY, GEMINI_MODEL          (default model: gemini-3.6-flash)
  OPENROUTER_API_KEY, OPENROUTER_MODEL  (default model: meta-llama/llama-3.3-70b-instruct:free)
  OLLAMA_HOST, OLLAMA_MODEL             (defaults: http://localhost:11434, qwen3-vl:4b)
  OLLAMA_NUM_CTX                        (default: 16384; Ollama silently cuts longer input)
Model names change often; override them if a default no longer exists.

Gemini and Ollama are sent page images (a text-only Ollama model ignores them).
OpenRouter gets the text part only.
"""

import base64
import os
import time

import requests

TIMEOUT_SECONDS = 180
RETRY_WAITS = (5, 15, 30)          # seconds to wait before each retry of a busy provider
RETRYABLE_STATUS = {429, 500, 503}  # rate limited, server error, overloaded


class LLMError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def ask(prompt, image_png=None, retry_waits=RETRY_WAITS):
    """Return (answer_text, provider_name). Raises LLMError if every provider fails.

    retry_waits: seconds to wait before each retry of a busy provider. Use short
    waits when a person is waiting for the answer.
    """
    errors = []
    for name, call in (("Gemini", _gemini), ("OpenRouter", _openrouter), ("Ollama", _ollama)):
        try:
            return _with_retries(call, prompt, image_png, retry_waits), name
        except Exception as error:  # any failure: missing key, rate limit, network, bad reply
            errors.append(f"{name}: {error}")
    raise LLMError("All providers failed. " + " | ".join(errors))


def _with_retries(call, prompt, image_png, retry_waits):
    """Call a provider; if it is busy or rate limited, wait and try again a few times."""
    for wait in retry_waits:
        try:
            return call(prompt, image_png)
        except LLMError as error:
            if error.status not in RETRYABLE_STATUS:
                raise
            time.sleep(wait)
    return call(prompt, image_png)  # last attempt; its error goes to the caller


def _gemini(prompt, image_png):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise LLMError("GEMINI_API_KEY is not set")
    model = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
    parts = [{"text": prompt}]
    if image_png:
        parts.append({"inline_data": {"mime_type": "image/png",
                                      "data": base64.b64encode(image_png).decode()}})
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key},
        json={"contents": [{"parts": parts}]},
        timeout=TIMEOUT_SECONDS,
    )
    _raise_for_status(response)
    return response.json()["candidates"][0]["content"]["parts"][0]["text"]


def _openrouter(prompt, _image_png):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise LLMError("OPENROUTER_API_KEY is not set")
    model = os.environ.get("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "messages": [{"role": "user", "content": prompt}]},
        timeout=TIMEOUT_SECONDS,
    )
    _raise_for_status(response)
    return response.json()["choices"][0]["message"]["content"]


def _ollama(prompt, image_png):
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    model = os.environ.get("OLLAMA_MODEL", "qwen3-vl:4b")
    message = {"role": "user", "content": prompt}
    if image_png:
        message["images"] = [base64.b64encode(image_png).decode()]  # used by vision models
    response = requests.post(
        f"{host}/api/chat",
        json={
            "model": model,
            "messages": [message],
            "stream": False,
            "options": {"num_ctx": int(os.environ.get("OLLAMA_NUM_CTX", "16384"))},
        },
        timeout=TIMEOUT_SECONDS * 3,  # local model on a laptop GPU is slower
    )
    _raise_for_status(response)
    return response.json()["message"]["content"]


def _raise_for_status(response):
    if response.status_code != 200:
        raise LLMError(f"HTTP {response.status_code}: {response.text[:200]}", response.status_code)