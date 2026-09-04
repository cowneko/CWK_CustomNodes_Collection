"""
CWK Batch Selector — server-side messaging layer.
Pauses the worker thread until the JS frontend POSTs a response.
"""

import json
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
class MessageState:
    _latest: "Optional[MessageState]" = None
    graph_id_expected: Optional[str] = None

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

    @classmethod
    def latest(cls) -> "MessageState":
        if cls._latest is None:
            cls._latest = cls()
        return cls._latest

    @classmethod
    def set_latest(cls, latest: "MessageState"):
        cls._latest = latest

    @classmethod
    def start_waiting(cls, graph_id: str):
        cls._latest = cls({"special": WAITING_FOR_RESPONSE})
        cls.graph_id_expected = graph_id

    @classmethod
    def stop_waiting(cls):
        cls._latest = cls()
        cls.graph_id_expected = None

    @classmethod
    def waiting(cls) -> bool:
        return cls.latest().special == WAITING_FOR_RESPONSE

    @classmethod
    def get_response(cls) -> Response:
        l = cls.latest()
        if l.special == WAITING_FOR_RESPONSE: return TimeoutResponse()
        if l.special == CANCEL:               return CancelledResponse()
        if l.special == REGENERATE:           return RegenerateResponse()
        return l.response


# ── HTTP endpoint — JS frontend posts here ──────────────────────────────────
@PromptServer.instance.routes.post("/cwk-batch-selector-message")
async def _cwk_batch_selector_message(request):
    post = await request.post()
    raw  = post.get("response")
    msg  = MessageState(raw)

    if str(MessageState.graph_id_expected) == str(msg.graph_id):
        if MessageState.waiting():
            MessageState.set_latest(msg)
        else:
            print(f"[CWK Batch Selector] Ignoring response (not waiting): {raw}")
    else:
        print(f"[CWK Batch Selector] Ignoring mismatched graph_id: {raw}")

    return web.json_response({})


# ── Blocking wait loop (worker thread) ──────────────────────────────────────
def _wait_for_response(uid: str, graph_id: str) -> Response:
    MessageState.start_waiting(graph_id)
    try:
        while MessageState.waiting():
            throw_exception_if_processing_interrupted()
            PromptServer.instance.send_sync(
                "cwk-batch-selector-tick",
                {"tick": 0, "uid": uid, "graph_id": graph_id},
            )
            time.sleep(0.5)
        return MessageState.get_response()
    finally:
        MessageState.stop_waiting()


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