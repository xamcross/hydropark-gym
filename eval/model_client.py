"""Model-call interface for the H2 harness (P0-07.3).

The model call sits behind an interface so the harness is runnable and testable
NOW (stub) and swappable to a real model later WITHOUT touching the scorer:

  - `StubModelClient`  — deterministic. Returns each prompt's authored
    `stub_output` (a *simulated* model answer). This is what makes the harness
    runnable today with no GGUF / no llama.cpp / no compiled app. Some
    stub_outputs are deliberately WRONG so the scorer's discrimination is
    demonstrable (a rigged all-correct run proves nothing). A stub run measures
    the HARNESS, never the model.
  - `LlamaCliModelClient` — shells out to `llama-cli` (llama.cpp) with the
    bundled Qwen2.5-3B GGUF. NOT run in this environment (no model file / no
    toolchain). This is the swap target for the real H2 pure-model pass.
  - `AppHttpModelClient` — placeholder for driving the app's own inference path
    (the full-system source) once it exposes one.

Only `StubModelClient` was executed for the report — see the harness banner.
"""

from __future__ import annotations

import subprocess
from abc import ABC, abstractmethod


class ModelClient(ABC):
    #: short identifier printed in the report so a reader always knows which
    #: backend produced the numbers.
    name: str = "abstract"

    @abstractmethod
    def complete(self, prompt: str, system: str = "") -> str:
        """Return the model's raw completion for `prompt` (the pure-model output)."""
        raise NotImplementedError


class StubModelClient(ModelClient):
    """Returns each record's authored `stub_output`. Deterministic; runnable now.

    Keyed by prompt text (prompts are unique in the set), so it presents the
    exact same `complete(prompt, system)` signature a real backend does — the
    scorer never knows which backend it got.
    """

    name = "stub"

    def __init__(self, records: list[dict]):
        self._by_prompt = {r["prompt"]: r for r in records}

    def complete(self, prompt: str, system: str = "") -> str:
        rec = self._by_prompt.get(prompt)
        if rec is None:
            return "[stub: no scripted answer]"
        return rec.get("stub_output", "[stub: empty]")


class LlamaCliModelClient(ModelClient):
    """Real pure-model pass via llama.cpp's `llama-cli`. NOT run here.

    Wired but unverified in this environment (no GGUF, no binary). Swap the
    harness to it with `--backend llama --model <path.gguf>` once available.
    """

    name = "llama-cli"

    def __init__(self, model_path: str, binary: str = "llama-cli", n_predict: int = 512):
        self._model = model_path
        self._binary = binary
        self._n_predict = n_predict

    def complete(self, prompt: str, system: str = "") -> str:
        full = f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
        proc = subprocess.run(
            [self._binary, "-m", self._model, "-p", full, "-n", str(self._n_predict), "--no-display-prompt"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"llama-cli failed: {proc.stderr.strip()[:400]}")
        return proc.stdout.strip()


class AppHttpModelClient(ModelClient):
    """Placeholder: drive the app's own inference endpoint (full-system source).

    NOT run here. Left as the seam the lead points at the Tauri app once it
    exposes an inference IPC/HTTP surface for the harness.
    """

    name = "app-http"

    def __init__(self, endpoint: str):
        self._endpoint = endpoint

    def complete(self, prompt: str, system: str = "") -> str:  # pragma: no cover
        raise NotImplementedError(
            "AppHttpModelClient is a seam only — point it at the app's inference "
            "surface when one exists (see harness README banner)."
        )
