---
name: ask-user
description: Use when implementation needs explicit user alignment at a high-stakes or ambiguous boundary; returns a confirmed decision, a related clarification packet, or a blocked status.
metadata:
  short-description: Decision gate for ambiguity and high-stakes choices
---

# Ask User Decision Gate

## Workflow
1. Classify the current boundary as `high_stakes`, `ambiguous`, `both`, or `clear`.
2. If the boundary is `clear`, do not call `ask_user`.
3. Gather evidence first with available tools; do not ask the user to decide blind.
4. Synthesize a short neutral `context` summary covering current state, constraints, trade-offs, and any recommendation.
5. Choose one shape:
   - Single mode for one high-stakes, preference-sensitive, or ambiguous decision boundary.
   - `mode: "batch"` when several related clarifications are already known up front and can be answered in one pass.
6. Keep batch mode to one topic, 2-7 non-branching questions, and do not split one known clarification packet into repeated pauses unless later questions genuinely depend on earlier answers.
7. Ask concrete, outcome-oriented questions; keep `allowFreeform` on unless there is a good reason not to.
8. After the tool returns, restate the answer text in plain language, state the next action, and proceed only within that scope.

## Trigger guide

| Scenario | Ask? | Preferred shape |
|---|---:|---|
| Architecture, schema, API, deploy, or security trade-off | Yes | Single |
| Costly-to-reverse behavior change or migration | Yes | Single |
| Requirements conflict or ambiguity | Yes | Single or batch |
| Several related clarifications already known up front | Yes | Batch |
| Non-trivial scope cut or prioritization | Yes | Single or batch |
| Purely local refactor with identical behavior | Usually no | — |
| Formatting-only edits | No | — |

## Checkpoints
- `ask_user` is required before proceeding when the next step changes architecture, schema, API contracts, deployment strategy, security posture, or another costly-to-reverse behavior.
- `ask_user` is required when requirements, constraints, or success criteria are unclear, conflicting, or missing.
- `ask_user` is required when multiple valid options exist and the trade-off depends on user preference.
- Use at most 1 `ask_user` call per decision boundary in normal cases.
- Use at most 2 attempts for the same boundary if the first result is unclear or cancelled; a single batch clarification call counts as one attempt.
- Do not use batch mode for unrelated questions, branching interviews, or a single go/no-go decision.
- Avoid using `ask_user` for trivial formatting choices or questions that should be resolved by reading code or docs first.

## Output
Return one of these outcomes before leaving the skill:
- Confirmed decision: restate the chosen option in plain language and name the next implementation step.
- Clarification packet: restate the collected answers in plain language and name the next implementation step.
- Blocked: name the unresolved decision and why implementation cannot continue safely.

Successful `ask_user` results expose model-visible answer text in plain-text `content`, in addition to structured details.

## Safety
- Preflight: gather evidence before asking and keep the `context` summary neutral.
- Stop condition: if the boundary is `high_stakes` or `both` and the answer is still unclear after the second attempt, stop and report blocked.
- Safe fallback: if the boundary is only `ambiguous` and the user explicitly delegates the choice, proceed with the most reversible default and state assumptions clearly.

## Batch notes
- Batch mode is a lightweight clarification flow, not a generic form engine.
- Ask batch questions together when they are already known up front and can be answered in one pass.
- Keep batch questions independent enough to answer in one pass.
- In the interactive overlay, the user can move across questions and type direct freeform answers where allowed.

## Quick payload rules
- Ask one concrete decision in single mode.
- Prefer 2-5 short, understandable options when options are appropriate.
- Use batch mode only for 2-7 related clarifications on one topic.
- Keep `allowFreeform` on unless constrained input is genuinely required.
