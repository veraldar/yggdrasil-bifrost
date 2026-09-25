"""LiveKit voice agent bridging phone audio to a local opencode server."""

import os
from typing import AsyncIterable

import httpx
import logging
from dotenv import load_dotenv
from livekit import plugins
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RoomInputOptions,
    cli,
    llm,
)
from livekit.agents.llm import ChatContext, LLMStream
from livekit.plugins import openai, silero

load_dotenv()

logger = logging.getLogger("opencode-bridge")

OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
VOICE_MODEL = os.environ.get("VOICE_MODEL", "opencode/ling-3.0-flash-fin-free")
SPEACHES_URL = os.environ.get("SPEACHES_URL", "http://127.0.0.1:8000/v1")
STT_MODEL = os.environ.get("STT_MODEL", "Systran/faster-whisper-small")
TTS_MODEL = os.environ.get("TTS_MODEL", "speaches-ai/Kokoro-82M-v1.0-ONNX")
TTS_VOICE = os.environ.get("TTS_VOICE", "af_heart")
INSTRUCTIONS = (
    "You relay the user's spoken words to a coding assistant and speak its answers. "
    "Answers arrive as text from opencode; speak them verbatim unless asked to summarize. "
    "Keep spoken replies concise: code is described, not read character by character."
)


class OpenCodeLLM(llm.LLM):
    """Bridges LiveKit chat to opencode's REST server (one session per room).

    Room name = slug of the session name; the opencode session with a matching
    title is reused, or created on first use.
    """

    def __init__(self, base_url: str, room_key: str = "voice") -> None:
        super().__init__()
        self._base = base_url.rstrip("/")
        self._room_key = room_key.lower()
        self._session_id: str | None = None

    @staticmethod
    def _slugify(title: str) -> str:
        import re
        return (
            re.sub(r"[^a-z0-9_-]", "", (title or "").lower().strip().replace(" ", "-"))[:60]
            or "session"
        )

    async def _ensure_session(self) -> str:
        if self._session_id is None:
            async with httpx.AsyncClient() as c:
                r = await c.get(f"{self._base}/session")
                r.raise_for_status()
                for s in r.json():
                    if self._slugify(s.get("title") or "") == self._room_key or s.get("id") == self._room_key:
                        self._session_id = s["id"]
                        break
                else:
                    r = await c.post(
                        f"{self._base}/session",
                        json={"title": self._room_key},
                    )
                    r.raise_for_status()
                    self._session_id = r.json()["id"]
            logger.info(f"opencode session for room {self._room_key!r}: {self._session_id}")
        return self._session_id

    async def ask(self, text: str) -> str:
        sid = await self._ensure_session()
        provider_id, model_id = VOICE_MODEL.split("/", 1)
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(
                f"{self._base}/session/{sid}/message",
                json={
                    "parts": [{"type": "text", "text": text}],
                    "model": {"providerID": provider_id, "modelID": model_id},
                },
            )
            r.raise_for_status()
            data = r.json()
        parts = data.get("parts") or []
        return "\n".join(
            p.get("text", "") for p in parts if p.get("type") == "text"
        ).strip() or "(opencode returned no text)"

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools=None,
        conn_options=None,
        **kwargs,
    ) -> LLMStream:
        return OpenCodeStream(
            llm=self, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options
        )


class OpenCodeStream(LLMStream):
    def __init__(
        self,
        *,
        llm: OpenCodeLLM,
        chat_ctx: ChatContext,
        tools=None,
        conn_options=None,
    ) -> None:
        super().__init__(llm=llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._oc = llm

    async def _run(self) -> None:
        messages = self._chat_ctx.messages()
        logger.debug(
            "opencode chat_ctx: %s",
            [(m.role, (m.text_content or "")[:60]) for m in messages],
        )
        prompt = ""
        for msg in reversed(messages):
            t = (msg.text_content or "").strip()
            if t:
                prompt = t
                break
        if not prompt:
            logger.warning("opencode bridge: no text content in chat_ctx, skipping")
            return
        try:
            reply = await self._oc.ask(prompt)
        except Exception as e:  # noqa: BLE001 - surface errors as speech
            reply = f"Sorry, talking to opencode failed: {e}"
        self._event_ch.send_nowait(
            llm.ChatChunk(id="opencode", delta=llm.ChoiceDelta(content=reply))
        )


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    _api_key = "not-needed"
    session = AgentSession(
        vad=silero.VAD.load(),
        stt=openai.STT(base_url=SPEACHES_URL, api_key=_api_key, model=STT_MODEL),
        llm=OpenCodeLLM(OPENCODE_URL, room_key=ctx.room.name),
        tts=openai.TTS(base_url=SPEACHES_URL, api_key=_api_key, model=TTS_MODEL, voice=TTS_VOICE),
    )
    await session.start(
        room=ctx.room,
        room_input_options=RoomInputOptions(text_enabled=True),
        agent=Agent(instructions=INSTRUCTIONS),
    )

    async def _commit_turn_rpc(data) -> str:
        # the phone can call this while the session is already closing (stale
        # room, participant disconnect race) — raising here surfaces as a raw
        # RPC error/timeout on the phone; a "not-running" answer lets it
        # self-heal by reconnecting
        try:
            await session.commit_user_turn()
        except Exception as e:  # noqa: BLE001
            logger.warning("commit_turn on dead session: %s", e)
            return "not-running"
        return "ok"

    ctx.room.local_participant.register_rpc_method("commit_turn", _commit_turn_rpc)

    # greet locally — generate_reply would post its instruction text into the
    # shared opencode session as if the user had typed it
    await session.say("Hi! You can ask me about the codebase.")


if __name__ == "__main__":
    cli.run_app(server)
