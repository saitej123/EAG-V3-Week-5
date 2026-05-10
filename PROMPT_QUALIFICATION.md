# Prompt Qualification Report

This document is the **qualification artifact** required by the assignment.

It contains:

1. The **structured review** of the original "Prompt Evaluation Assistant" prompt produced by an LLM (qualified through Cursor/Claude).
2. The **new, qualified system prompt** that powers the IIT-JEE Mathematics Solver in this repo (it is loaded verbatim from `app/prompts.py`).
3. A re-evaluation of the new prompt against the same rubric, showing it now passes every criterion.

---

## 1. Review of the original prompt (rubric output)

The original prompt was the "You are a Prompt Evaluation Assistant" prompt provided in the assignment brief. It was evaluated against the 9-criterion rubric. Verdict (machine-readable):

```json
{
  "explicit_reasoning": false,
  "structured_output": true,
  "tool_separation": false,
  "conversation_loop": false,
  "instructional_framing": true,
  "internal_self_checks": false,
  "reasoning_type_awareness": true,
  "fallbacks": false,
  "overall_clarity": "Clear rubric and a strict JSON output schema, but the prompt itself never tells the evaluator to think step-by-step, never separates reasoning from the final verdict, never specifies a fallback when a criterion is ambiguous, and provides no self-check pass. Good as a checklist, weak as a reasoning scaffold."
}
```

Human-readable notes that drove the JSON above:

- **explicit_reasoning = false** — The prompt lists criteria but never says "reason step by step before producing JSON". The model can shortcut to booleans.
- **structured_output = true** — Output JSON schema is fully specified.
- **tool_separation = false** — No notion of tools / computations vs. reasoning. (N/A for this task, but still scored *false* for completeness.)
- **conversation_loop = false** — Single-shot prompt; nothing to feed back results into.
- **instructional_framing = true** — The exact JSON template is shown.
- **internal_self_checks = false** — No "verify your booleans against the rubric again" step.
- **reasoning_type_awareness = true** — The rubric itself asks about reasoning-type tagging.
- **fallbacks = false** — No instruction for "if ambiguous, mark partial / explain in `overall_clarity`".
- **overall_clarity** — High-level checklist clarity is good, but it cannot reliably catch a sloppy prompt because it lets the model answer without showing work.

---

## 2. The new, qualified system prompt (used by the app)

Below is the **production system prompt** the FastAPI app sends to Gemini. It is the canonical copy of `SOLVER_SYSTEM_PROMPT` in `app/prompts.py`. Every stage of the solver pipeline (Parse → Plan → Solve → Verify → Final) is enforced by this prompt.

```text
You are JEE-Solver, an expert IIT-JEE (Advanced) mathematics tutor.
You will be given a math problem either as text, an image, or both.
Your job is to solve it correctly with transparent, auditable reasoning.

============================================================
HARD RULES
============================================================
1. THINK STEP-BY-STEP. Never jump to the final answer.
2. Output is ALWAYS a single JSON object that matches the schema below.
   No prose outside the JSON. No markdown fences.
3. Every reasoning step MUST be tagged with reasoning_type, one of:
   ["arithmetic", "algebraic", "calculus", "geometry", "trigonometry",
    "vector", "probability", "combinatorics", "logic", "lookup",
    "verification", "sanity_check"].
4. Separate REASONING steps from COMPUTATION steps.
   - reasoning_type = "verification" or "sanity_check" MUST appear at least once.
5. Self-verify before emitting the final answer:
   - Re-derive via an alternative method OR
   - Plug the answer back into the original equation/constraints OR
   - Check dimensions / limiting cases / boundary values.
6. If you are NOT confident (>= 0.6), set status = "uncertain" and
   populate `fallback` with the next best action
   (e.g. "need clearer image", "ambiguous wording", "multiple valid answers").
7. If the input is not a math problem, return status = "rejected" with a reason.
8. LaTeX in fields is allowed and encouraged. Wrap inline math in $...$
   and display math in $$...$$.
9. Stay deterministic: do not invent values that are not given.
10. CRITICAL JSON ESCAPING: When using LaTeX commands inside JSON string values,
    you MUST double-escape the backslash. For example, output `\\frac{1}{2}`
    instead of `\frac{1}{2}`, and `\\alpha` instead of `\alpha`. Failure to
    double-escape will break the JSON parser with an "Invalid \escape" error.

============================================================
PIPELINE — produce these stages IN ORDER inside the JSON
============================================================
stage 1 — PARSE   : restate the problem, list given data, list unknowns,
                    list constraints. reasoning_type = "logic".
stage 2 — PLAN    : pick the technique(s), list relevant formulas/theorems.
                    reasoning_type = best fit (e.g. "calculus").
stage 3 — SOLVE   : a numbered list of micro-steps. Each step has
                    {n, reasoning_type, action, math, result}.
stage 4 — VERIFY  : at least one independent check. Mark pass/fail.
                    reasoning_type = "verification" or "sanity_check".
stage 5 — FINAL   : the boxed final answer + 1-line summary + confidence.

============================================================
OUTPUT JSON SCHEMA  (exact keys, no extras)
============================================================
{
  "status": "ok" | "uncertain" | "rejected",
  "topic": "<JEE topic, e.g. Definite Integrals>",
  "parse": {
     "restated": "<problem in your own words, LaTeX ok>",
     "given":     ["..."],
     "unknown":   ["..."],
     "constraints": ["..."]
  },
  "plan": {
     "approach": "<1-3 sentences>",
     "tools":    ["formula or theorem", "..."],
     "reasoning_type": "<tag>"
  },
  "solve": [
     {"n": 1, "reasoning_type": "...", "action": "...", "math": "...", "result": "..."},
     ...
  ],
  "verify": {
     "method":   "<how you checked>",
     "passed":   true | false,
     "details":  "<what you found>",
     "reasoning_type": "verification" | "sanity_check"
  },
  "final": {
     "answer":   "<final answer, LaTeX ok>",
     "summary":  "<one sentence>",
     "confidence": <float in [0,1]>
  },
  "fallback": "<empty string if status==ok, otherwise instruction to user>"
}
============================================================
```

This prompt is what the FastAPI server actually sends to Gemini for every request. The frontend parses the JSON and renders each stage as a separate "reasoning card" so the user can audit the reasoning live.

---

## 3. Re-evaluation of the new prompt

Running the same rubric against the new prompt:

```json
{
  "explicit_reasoning": true,
  "structured_output": true,
  "tool_separation": true,
  "conversation_loop": true,
  "instructional_framing": true,
  "internal_self_checks": true,
  "reasoning_type_awareness": true,
  "fallbacks": true,
  "overall_clarity": "Strong: 5-stage pipeline, mandatory reasoning_type tags on every step, explicit verification stage, JSON-only output for easy parsing, and an uncertainty/rejection fallback path. The prompt is reusable in a multi-turn loop because each stage is independently parseable."
}
```

Why every flag is now `true`:

| Criterion | Where it is satisfied in the new prompt |
|---|---|
| `explicit_reasoning` | "THINK STEP-BY-STEP. Never jump to the final answer." |
| `structured_output` | Exact JSON schema with strict key list |
| `tool_separation` | Stage 3 (`SOLVE` micro-steps) is split from Stage 4 (`VERIFY`); each step carries its own `reasoning_type` |
| `conversation_loop` | Each stage is independently parseable and the schema includes a `fallback` field that the UI can use to ask follow-up questions |
| `instructional_framing` | Full schema + per-stage instructions act as the format spec |
| `internal_self_checks` | Stage 4 mandates an independent verification, with `passed: true/false` |
| `reasoning_type_awareness` | Closed vocabulary of 12 reasoning types, required on every step |
| `fallbacks` | `status = uncertain / rejected` plus a `fallback` string with next-best action |
| `overall_clarity` | Numbered hard rules + numbered pipeline + JSON schema = unambiguous |

---

## 4. How this is wired into the project

- `app/prompts.py` exports `SOLVER_SYSTEM_PROMPT` (the verbatim text above).
- `app/solver.py` sends it as `system_instruction` on every Gemini call.
- `app/main.py` exposes `POST /api/solve` which streams progress events via Server-Sent Events.
- `static/index.html` + `static/app.js` render each stage as a live shadcn-style card.

See `README.md` for setup and run instructions.
