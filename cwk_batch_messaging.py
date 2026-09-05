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
class ConcurrentWaitError(RuntimeError):
    """Raised when start_waiting() is called for a graph_id that already has
    an active, unresolved wait. This can only happen if the same node/run
    correlation id is used to start a second wait before the first one has
    been resolved (Send/Cancel/Re-Generate) or interrupted — e.g. a bug
    causing the same node to be entered twice concurrently. Rather than
    silently replacing the first waiter's slot (which would orphan its wait
    loop forever, spinning until the user manually clicks Stop), this is
    raised so the failure is immediately visible as a node execution error
    instead of a silent hang.
    """


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
                message = (
                    f"[CWK Batch Selector] Refusing to start a second concurrent wait "
                    f"for graph_id={graph_id!r}; a previous wait for the same id is "
                    f"still active."
                )
                print(f"[CWK Batch Selector] ERROR: {message}")
                raise ConcurrentWaitError(message)
            cls._waiters[graph_id] = cls({"special": WAITING_FOR_RESPONSE, "graph_id": graph_id})


    @classmethod
    def stop_waiting(cls, graph_id: str) -> None:
        # Ordering dependency: callers must have already read whatever
        # response deliver() may have stored (via get_response()) before
        # calling this, since it unconditionally discards the entry. The
        # only caller, `_wait_for_response()`, satisfies this because its
        # `return MessageState.get_response(graph_id)` is evaluated before
        # the `finally: MessageState.stop_waiting(graph_id)` block runs.
        #
        # Known limitation: this relies on `_wait_for_response()`'s `finally`
        # block to run. If the worker thread is killed abruptly (process
        # crash / SIGKILL) rather than exiting normally or via
        # InterruptProcessingException, the entry for that graph_id could be
        # left orphaned in `_waiters` for the remainder of the process
        # lifetime. This is harmless (it only blocks a future node from
        # reusing that exact node id while a stale WAITING entry lingers,
        # which start_waiting() already logs a warning for) but is not
        # actively garbage-collected.
        with cls._lock:
            cls._waiters.pop(graph_id, None)

    @classmethod
    def waiting(cls, graph_id: str) -> bool:
        # NOTE: waiting() and get_response() are separate lock acquisitions
        # (not one atomic check-and-read), but this can't lose a delivered
        # message: deliver() only ever overwrites `_waiters[gid]` while the
        # existing entry's special is still WAITING_FOR_RESPONSE, and once a
        # non-waiting entry is stored, any further deliver() for the same id
        # is rejected as "not_waiting" until stop_waiting() clears it. So the
        # eventual get_response() call always observes whichever message (if
        # any) actually "won" the race, never a torn/partial state.
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
# Like every other CWK custom-node route (e.g. the `/cwk_live_preview/toggle`
# route registered in `__init__.py`), this endpoint is unauthenticated and
# trusts the local ComfyUI instance/network boundary — consistent with the
# rest of this repo and with ComfyUI's own default routes, none of which
# implement per-route auth or rate limiting. Logging is best-effort/debug
# only and intentionally lightweight; add real rate limiting here only if
# this route is ever exposed beyond a trusted local network.
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
    # Ordering dependency: get_response() (which reads whatever deliver()
    # stored) MUST run before stop_waiting() (which removes that entry).
    # `return MessageState.get_response(graph_id)` evaluates and captures the
    # return value *before* the `finally` block runs, so this holds for the
    # only call site in this module. Do not reorder this into e.g. calling
    # stop_waiting() first — that would discard a just-delivered response.
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
