#!/usr/bin/env python3
"""Exercise interactive unpublishing using the integration suite's fake Wrangler."""

from __future__ import annotations

import errno
import json
import os
import pty
import select
import shutil
import signal
import sys
import termios
import time
from contextlib import suppress
from pathlib import Path

SLUG = "pty-talk"
WORKER = f"altmejd-slides-{SLUG}"
PROMPT = b"or press Enter to cancel:"


def interact(
    publisher: Path,
    directory: Path,
    env: dict[str, str],
    input_chunks: tuple[bytes, ...],
    nonblocking: bool,
    terminal_mode: str,
) -> tuple[int, str]:
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(directory)
        os.set_blocking(0, not nonblocking)
        if terminal_mode != "canonical":
            settings = termios.tcgetattr(0)
            if terminal_mode == "crlf":
                settings[0] &= ~(termios.ICRNL | termios.IGNCR | termios.INLCR)
            else:
                settings[3] &= ~termios.ICANON
                settings[6][termios.VMIN] = 1
                settings[6][termios.VTIME] = 0
            termios.tcsetattr(0, termios.TCSANOW, settings)
        os.execvpe("quarto", ["quarto", "run", str(publisher), "--unpublish"], env)

    output = bytearray()
    status = None
    sent = 0
    prompt_at = None
    deadline = time.monotonic() + 15
    os.set_blocking(terminal, False)
    try:
        while time.monotonic() < deadline:
            if select.select([terminal], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(terminal, 8192))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            if len(output) > 64 * 1024:
                raise AssertionError("PTY output exceeded the test limit")
            now = time.monotonic()
            if prompt_at is None and PROMPT in output:
                prompt_at = now
            ended, child_status = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = child_status
                break
            # A real user cannot answer before seeing the prompt. Delaying also
            # reproduces prompt() returning immediately on nonblocking stdin.
            if sent < len(input_chunks) and prompt_at is not None and now - prompt_at >= 0.25:
                assert not Path(env["FAKE_WRANGLER_LOG"]).read_text(), (
                    "Wrangler was called before confirmation"
                )
                chunk = input_chunks[sent]
                assert os.write(terminal, chunk) == len(chunk)
                sent += 1
                prompt_at = now
        transcript = output.decode(errors="replace")
        assert status is not None, f"interactive unpublish timed out:\n{transcript}"
        assert sent == len(input_chunks), (
            f"interactive unpublish exited before complete input:\n{transcript}"
        )
        return os.waitstatus_to_exitcode(status), transcript
    finally:
        if status is None:
            with suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(terminal)


def run_case(
    publisher: Path,
    root: Path,
    name: str,
    input_chunks: tuple[bytes, ...],
    *,
    nonblocking: bool = False,
    accepted: bool = False,
    terminal_mode: str = "canonical",
) -> None:
    directory = root / name
    directory.mkdir(parents=True)
    fake_state = directory / "fake-state"
    fake_state.mkdir()
    calls = directory / "wrangler-calls.log"
    calls.touch()
    marker = fake_state / f"deployed-{WORKER}"
    marker.touch()
    state_path = directory / ".altmejd-slides-publish.json"
    state = {
        "version": 1,
        "decks": {
            SLUG: {
                "worker": WORKER,
                "host": "slides.example.test",
                "accountId": "11111111111111111111111111111111",
                "contentHash": "fixture",
                "published": "2026-09-16T00:00:00Z",
            }
        },
    }
    state_path.write_text(json.dumps(state))
    env = {
        **os.environ,
        "FAKE_WRANGLER_LOG": str(calls),
        "FAKE_WRANGLER_STATE": str(fake_state),
        "FAKE_WRANGLER_EXPECT_CONFIRMATION": "yes",
    }
    env.pop("ALTMEJD_SLIDES_WRANGLER", None)
    env.pop("CLOUDFLARE_ACCOUNT_ID", None)
    code, transcript = interact(publisher, directory, env, input_chunks, nonblocking, terminal_mode)
    if accepted:
        assert code == 0, f"{name} did not accept the exact slug:\n{transcript}"
        assert not marker.exists(), f"{name} did not delete the owned Worker"
        assert json.loads(state_path.read_text()) == {"version": 1, "decks": {}}
        assert (fake_state / f"delete-confirmation-{WORKER}").read_text() == "yes\n", (
            "publisher consumed the subsequent Wrangler confirmation"
        )
        deletions = [
            line for line in calls.read_text().splitlines() if line.startswith("wrangler delete ")
        ]
        assert len(deletions) == 1
    else:
        assert code != 0, f"{name} accepted cancellation:\n{transcript}"
        assert "confirmation did not match" in transcript, transcript
        assert not calls.read_text(), f"{name} contacted Wrangler"
        assert marker.exists(), f"{name} deleted the owned Worker"
        assert json.loads(state_path.read_text()) == state, f"{name} changed the ownership record"
    print(f"interactive unpublish: {name} passed")


def main() -> None:
    publisher, root = (Path(argument).resolve() for argument in sys.argv[1:])
    wrangler = shutil.which("wrangler")
    assert wrangler and "fake wrangler: unexpected command" in Path(wrangler).read_text(), (
        "run only with the integration suite's fake Wrangler on PATH"
    )
    for name, nonblocking in [("blocking", False), ("nonblocking", True)]:
        run_case(
            publisher,
            root,
            name,
            (f"{SLUG}\nyes\n".encode(),),
            nonblocking=nonblocking,
            accepted=True,
        )
    run_case(
        publisher, root, "crlf", (f"{SLUG}\r\nyes\n".encode(),), accepted=True, terminal_mode="crlf"
    )
    for name, input_chunks in [
        ("mismatch", (b"other-talk\n",)),
        ("blank", (b"\n",)),
        ("eof", (b"\x04",)),
        ("padded", (f" {SLUG} \n".encode(),)),
        ("partial-eof", (f"{SLUG}\x04\x04".encode(),)),
    ]:
        run_case(publisher, root, name, input_chunks)
    # Deliver a partial line immediately. The publisher must keep reading until
    # the later newline, instead of exiting with unread terminal input.
    run_case(publisher, root, "long-line", (b"x" * 1000, b"\n"), terminal_mode="noncanonical")


if __name__ == "__main__":
    main()
