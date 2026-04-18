# Ask User Skill × Extension Interaction Spec

## Purpose

This document defines a minimal decision-gating protocol for using the `ask-user` skill with the `ask_user` tool.

Goal: require explicit user decisions at high-impact or ambiguous boundaries before implementation continues.

---

## 1) Trigger Matrix (When to Call `ask_user`)

| Scenario | Must Ask? | Why |
|---|---:|---|
| Architecture trade-off (e.g., queue vs cron, SQL vs KV) | Yes | Preference-sensitive, high blast radius |
| Data schema / migration path selection | Yes | Costly to reverse |
| Security/compliance posture trade-off | Yes | Risk ownership is human |
| Requirements conflict or ambiguity | Yes | Need explicit intent |
| Non-trivial scope cut/prioritization | Yes | Product decision, not purely technical |
| Purely local refactor with identical behavior | Usually no | No policy-level decision |
| Formatting-only edits | No | Trivial |
| User already gave explicit choice for exact trade-off | No (unless new ambiguity) | Decision already captured |

---

## 2) Decision Handshake

Use this protocol whenever the trigger matrix says to ask.

1. **Detect boundary**
   - classify as `high_stakes`, `ambiguous`, `both`, or `clear`
2. **Gather evidence**
   - read code/docs/logs first; do not ask blindly
3. **Summarize context**
   - prepare concise trade-off context (3–7 bullets or short paragraph)
4. **Ask the right `ask_user` shape**
   - default to one decision at a time for a single high-stakes gate
   - when several related clarifications are already known up front, prefer one `mode: "batch"` call instead of repeated single-question pauses
   - use `mode: "batch"` only for one related clarification sweep with 2-7 questions known up front
   - do not use batch mode for unrelated or branching questions
5. **Commit and proceed**
   - restate chosen option or collected clarifications and implement accordingly
   - successful `ask_user` results expose model-visible answer text in plain-text `content`, in addition to structured details

### Retry/cancel policy

- Max **2** `ask_user` attempts for the same decision boundary.
- Attempt 1: normal structured question.
- Attempt 2: narrower question with recommendation and explicit options.
- After attempt 2:
  - `high_stakes` / `both`: stop and report blocked.
  - `ambiguous` only: proceed only if user delegates (e.g., “your call”), using the most reversible default.

---

## 3) Batch UX and response notes

- Batch mode is a lightweight one-overlay clarification flow, not a generic form engine.
- In the interactive overlay, the user can move across batch questions and type direct freeform answers where allowed.
- If the agent already knows it needs several related clarifications before implementation, it should ask them together in one batch instead of serializing them into multiple pauses.
- Successful results include visible answer text in `content`, so the agent can continue even when only plain-text tool output is surfaced.

## 4) Example Payloads

### Architecture decision

```json
{
  "question": "Which implementation path should we use for v1?",
  "context": "Path A is faster to ship but less extensible. Path B takes longer but supports plugin-style growth. Existing deadline is 2 weeks.",
  "options": [
    { "title": "Path A (ship fast)", "description": "Lowest scope, revisit architecture later" },
    { "title": "Path B (extensible)", "description": "Higher initial effort, cleaner long-term composition" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

### Requirement-priority decision

```json
{
  "question": "Which requirement should be prioritized first?",
  "context": "Current request mixes performance tuning and UI redesign. Doing both now risks delaying delivery.",
  "options": [
    "Performance first",
    "UI redesign first",
    "Do a minimal pass on both"
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```
