"""
CWK Batch Selector — server-side messaging layer.
Pauses the worker thread until the JS frontend POSTs a response.
"""

import json
import threading
import time
from typing import Optional

from aiohttp import web
from server import PromptServer
from comfy.model_management import (
    InterruptProcessingException,
    throw_exception_if_processing_interrupted,
)

# ── Special message codes ───────────────────────────────────────────────────
CANCEL                 = "-3"
REGENERATE             = "-4"
WAITING_FOR_RESPONSE   = "-9"


class Response:
    """Wraps the selection payload coming back from the frontend."""
    def __init__(self, selection: Optional[list] = None, **_unused):
        self.selection: list[int] = [int(x) for x in selection] if selection else []

class TimeoutResponse(Response): pass
class CancelledResponse(Response): pass
class RegenerateResponse(Response): pass


# ── Shared state machine ────────────────────────────────────────────────────
# Keyed per graph_id (in practice the originating node's UNIQUE_ID) so that
# multiple CWKBatchSelector nodes / concurrent prompt executions don't clobber
# each other's wait state. A single process-wide `_latest` slot previously
# meant a second node calling start_waiting() would silently orphan the first
# node's wait loop; this can no longer happen since each node gets its own
# slot in `_waiters`.
class MessageState:
    _waiters: "dict[str, MessageState]" = {}
    _lock = threading.Lock()

    def __init__(self, data=None):
        if data is None:
            data = {}
        elif isinstance(data, str):
            try:
                data = json.loads(data)
            except (TypeError, ValueError):
                data = {}
        data = dict(data)  # copy so we can pop
        self.graph_id: Optional[str] = data.pop("graph_id", None)
        self.special:  Optional[str] = data.pop("special",  None)
        self.response: Response       = Response(**data)

    def __repr__(self):
        return (
            f"MessageState(graph_id={self.graph_id!r}, special={self.special!r}, "
            f"selection={self.response.selection!r})"
        )

    @classmethod
    def start_waiting(cls, graph_id: str) -> None:
        with cls._lock:
            existing = cls._waiters.get(graph_id)
            if existing is not None and existing.special == WAITING_FOR_RESPONSE:
                print(
                    f"[CWK Batch Selector] WARNING: start_waiting() called for "
                    f"graph_id={graph_id!r} while a previous wait for the same id was "
                    f"still active. The previous wait will be replaced; if that node is "
                    f"still running it may now spin forever."
                )
            cls._waiters[graph_id] = cls({"special": WAITING_FOR_RESPONSE, "graph_id": graph_id})

    @classmethod
    def stop_waiting(cls, graph_id: str) -> None:
        with cls._lock:
            cls._waiters.pop(graph_id, None)

    @classmethod
    def waiting(cls, graph_id: str) -> bool:
        with cls._lock:
            state = cls._waiters.get(graph_id)
            return state is not None and state.special == WAITING_FOR_RESPONSE

    @classmethod
    def get_response(cls, graph_id: str) -> Response:
        with cls._lock:
            state = cls._waiters.get(graph_id)
        if state is None or state.special == WAITING_FOR_RESPONSE:
            return TimeoutResponse()
        if state.special == CANCEL:
            return CancelledResponse()
        if state.special == REGENERATE:
            return RegenerateResponse()
        return state.response

    @classmethod
    def deliver(cls, msg: "MessageState"):
        """Attempt to hand an incoming POSTed message to the waiter that
        matches its graph_id. Returns (success, reason) for logging/ack."""
        gid = msg.graph_id
        with cls._lock:
            state = cls._waiters.get(gid)
            if state is None:
                return False, "no_matching_waiter"
            if state.special != WAITING_FOR_RESPONSE:
                return False, "not_waiting"
            cls._waiters[gid] = msg
            return True, "ok"

    @classmethod
    def pending_graph_ids(cls) -> list:
        with cls._lock:
            return list(cls._waiters.keys())


# ── HTTP endpoint — JS frontend posts here ──────────────────────────────────
@PromptServer.instance.routes.post("/cwk-batch-selector-message")
async def _cwk_batch_selector_message(request):
    post = await request.post()
    raw  = post.get("response")

    if raw is None:
        print(
            f"[CWK Batch Selector] Received POST with no 'response' field "
            f"(form keys={list(post.keys())}); message dropped."
        )
        return web.json_response({"ok": False, "reason": "missing_response"}, status=400)

    msg = MessageState(raw)
    print(f"[CWK Batch Selector] Received message: {msg}")

    ok, reason = MessageState.deliver(msg)
    if not ok:
        print(
            f"[CWK Batch Selector] Ignoring message (reason={reason}) for "
            f"graph_id={msg.graph_id!r}; pending waiters={MessageState.pending_graph_ids()}"
        )

    return web.json_response({"ok": ok, "reason": reason})


# ── Blocking wait loop (worker thread) ──────────────────────────────────────
def _wait_for_response(uid: str, graph_id: str) -> Response:
    MessageState.start_waiting(graph_id)
    try:
        while MessageState.waiting(graph_id):
            throw_exception_if_processing_interrupted()
            PromptServer.instance.send_sync(
                "cwk-batch-selector-tick",
                {"tick": 0, "uid": uid, "graph_id": graph_id},
            )
            time.sleep(0.5)
        return MessageState.get_response(graph_id)
    finally:
        MessageState.stop_waiting(graph_id)


def send_images_and_wait(payload: dict, uid: str, graph_id: str) -> Response:
    """Send image URLs to the frontend and block until the user responds."""
    payload = dict(payload)
    payload["uid"]      = uid
    payload["graph_id"] = graph_id

    PromptServer.instance.send_sync("cwk-batch-selector-images", payload)
    r = _wait_for_response(uid, graph_id)

    if isinstance(r, CancelledResponse):
        raise InterruptProcessingException()

    return r
