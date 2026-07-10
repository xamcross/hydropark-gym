"""The app's deterministic layers, applied to produce the FULL-SYSTEM pass.

PHASE0-PLAN §4b runs each prompt in two passes: a *pure-model* pass (raw
generation — characterises the model) and a *full-system* pass (through the app
path — characterises the experience). This module is the "app path": the
deterministic pieces the product interposes between the model and the user.

Two deterministic layers are modelled:

  1. ALLERGEN LAYER (P0-07.4, SAFETY-CRITICAL) — runs `allergen.scan` over the
     authoritative ingredient text and appends warnings. It fires regardless of
     what the model said, which is the whole point: the product does NOT trust
     the model for allergen safety (PHASE0-PLAN §5 grades them separately).

  2. UI-FIRST / DETERMINISTIC TOOL HANDLING — for unit-conversion and scaling
     prompts, the app routes the arithmetic through the deterministic
     `convert_units` tool (and linear scaling), NOT the model. The full-system
     answer therefore uses the exact tool value. This is why the unit-conversion
     exactness floor is clearable even if the raw model flubs arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import allergen
import unit_math


@dataclass
class FullSystemResult:
    output: str
    allergen_flags: list[str] = field(default_factory=list)
    allergen_warning: str | None = None
    deterministic_number: float | None = None
    tool_used: str | None = None


def _allergen_warning(flags) -> str | None:
    if not flags:
        return None
    labels = ", ".join(f.display for f in flags)
    return f"⚠ Allergen warning (automatic, on-device): {labels}. This is a rule-based check, not the AI."


def apply(record: dict, pure_output: str) -> FullSystemResult:
    """Apply the deterministic layers to `pure_output` for `record`."""
    flags = allergen.scan(record.get("ingredient_text", "") or "")
    flag_keys = [f.allergen for f in flags]
    warning = _allergen_warning(flags)

    det_num: float | None = None
    tool: str | None = None
    if "unit_conv" in record:
        det_num = unit_math.convert(record["unit_conv"])
        tool = "convert_units"
    elif "scale_calc" in record:
        sc = record["scale_calc"]
        det_num = round(sc["base"] * sc["to"] / sc["from"] * 1_000_000) / 1_000_000
        tool = "scaling"

    lines = [pure_output]
    if det_num is not None:
        # The deterministic tool result supersedes the model's arithmetic.
        pretty = int(det_num) if det_num == int(det_num) else det_num
        lines.append(f"[deterministic {tool}] exact result: {pretty}")
    if warning:
        lines.append(warning)

    return FullSystemResult(
        output="\n".join(lines),
        allergen_flags=flag_keys,
        allergen_warning=warning,
        deterministic_number=det_num,
        tool_used=tool,
    )
