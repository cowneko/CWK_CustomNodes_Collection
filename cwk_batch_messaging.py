"""CWK Batch Selector — server-side messaging layer."""

import json
import time
from typing import Optional

from aiohttp import web
from server import PromptServer
from comfy.model_management import (
    InterruptProcessingException,
    throw_exception_if_processing_interrupted,
)

CANCEL               = "-3"
REGENERATE           = "-4"
WAITING_FOR_RESPONSE = "-9"


class Response:
    def __init__(self, selection: Optional[list] = None, **_unused):
        self.selection: list[int] = [int(x) for x in selection] if selection else []

class TimeoutResponse(Response): pass
class CancelledResponse(Response): pass
class RegenerateResponse(Response): pass


class MessageState:
    _latest: "Optional[MessageState]" = None
    graph_id_expected: Optional[str] = None
    uid_expected: Optional[str] = None                       # CHANGED

    def __init__(self, data=None):
        if data is None:
            data = {}
        elif isinstance(data, str):
            try:
                data = json.loads(data)
            except (TypeError, ValueError):
                data = {}
        data = dict(data)
        self.graph_id = data.pop("graph_id", None)
        self.node_id  = data.pop("node_id", data.pop("uid", None))   # CHANGED
        self.special  = data.pop("special", None)
        self.response = Response(**data)

    @classmethod
    def latest(cls): return cls._latest or cls()
    @classmethod
    def set_latest(cls, latest): cls._latest = latest

    @classmethod
    def start_waiting(cls, uid, graph_id):                   # CHANGED: uid first
        cls._latest = cls({"special": WAITING_FOR_RESPONSE})
        cls.uid_expected      = str(uid) if uid is not None else None
        cls.graph_id_expected = str(graph_id) if graph_id else None

    @classmethod
    def stop_waiting(cls):
        cls._latest = cls()
        cls.graph_id_expected = None
        cls.uid_expected = None                              # CHANGED

    @classmethod
    def waiting(cls): return cls.latest().special == WAITING_FOR_RESPONSE

    @classmethod
    def get_response(cls):
        l = cls.latest()
        if l.special == WAITING_FOR_RESPONSE: return TimeoutResponse()
        if l.special == CANCEL:               return CancelledResponse()
        if l.special == REGENERATE:           return RegenerateResponse()
        return l.response


@PromptServer.instance.routes.post("/cwk-batch-selector-message")
async def _cwk_batch_selector_message(request):
    try:
        post = await request.post()
        raw  = post.get("response")
        msg  = MessageState(raw)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"bad body: {e}"}, status=400)

    # CHANGED: exact node-id match (frontend sends node.id == backend's UNIQUE_ID);
    # graph_id kept as legacy fallback.
    uid_match = (msg.node_id is not None
                 and MessageState.uid_expected is not None
                 and str(msg.node_id) == str(MessageState.uid_expected))
    gid_match = (MessageState.graph_id_expected is not None
                 and str(MessageState.graph_id_expected) == str(msg.graph_id))

    if uid_match or gid_match:
        if MessageState.waiting():
            MessageState.set_latest(msg)
            return web.json_response({"ok": True})
        print(f"[CWK Batch Selector] Ignoring response (not waiting): {raw}")
        return web.json_response({"ok": False, "error": "not waiting"}, status=409)

    print(f"[CWK Batch Selector] Ignoring unmatched response "
          f"(expected uid={MessageState.uid_expected!r}): {raw}")
    return web.json_response({"ok": False, "error": "unmatched"}, status=409)


def _wait_for_response(uid: str, graph_id: str) -> Response:
    MessageState.start_waiting(uid, graph_id)                # CHANGED
    try:
        while MessageState.waiting():
            throw_exception_if_processing_interrupted()
            PromptServer.instance.send_sync(
                "cwk-batch-selector-tick",
                {"tick": 0, "uid": uid, "graph_id": graph_id},
            )
            time.sleep(0.1)
        return MessageState.get_response()
    finally:
        MessageState.stop_waiting()


def send_images_and_wait(payload: dict, uid: str, graph_id: str) -> Response:
    payload = dict(payload)
    payload["uid"]      = uid
    payload["graph_id"] = graph_id

    PromptServer.instance.send_sync("cwk-batch-selector-images", payload)
    r = _wait_for_response(uid, graph_id)

    if isinstance(r, CancelledResponse):
        raise InterruptProcessingException()
    return r
