---
name: implement-book
description: "Execute a ticket end-to-end via /implement (TDD + code-review), extract the verified git commits and diff, and write a self-contained engineering book chapter (.md) grounded in the real changes."
disable-model-invocation: true
---

# Implement as Verified Book Chapter

Build the ticket for real in this reference repository first—so every line of code is compiled, tested, and code-reviewed—then turn the verified git history into a self-contained engineering book chapter (`.md`) that the human uses to implement the project in their own separate repository.

## Process

### 1. Pin the Starting Point
- Resolve the ticket reference passed by the user (fetch from `docs/agents/issue-tracker.md` or `.scratch/<feature>/issues/`) and state its title[cite: 2]. If ambiguous, ask[cite: 2].
- Record the current `HEAD` commit hash as `BASE_SHA` (`git rev-parse HEAD`).
- Ensure the working tree is clean (`git status --porcelain`). If there are uncommitted changes, stop and ask the user to commit or stash them before starting.

### 2. Build & Review via `/implement`
- Call the Skill tool with `implement` for this ticket[cite: 2].
- Let `implement` run its full lifecycle: vertical TDD slices, running tests, calling `code-review`, fixing review findings, and committing the verified work to the current branch[cite: 2].
- Do not proceed to Step 3 until all tests pass and `implement` has committed its work[cite: 2].

### 3. Mine the Verified Git History
- Inspect the commits and diff created since `BASE_SHA`:
  - `git log <BASE_SHA>..HEAD --stat`[cite: 2]
  - `git diff <BASE_SHA>...HEAD`[cite: 2]
- Read `GLOSSARY.md` and relevant ADRs in `docs/adr/` (if present) to align terminology[cite: 2].
- Consult the `codebase-design` skill vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) to frame the architectural explanation[cite: 2].

### 4. Author & Commit the Book Chapter
Create `docs/book/<NN>-<ticket-slug>.md` (creating `docs/book/` lazily if needed), numbered sequentially to match the ticket. Write it as a self-contained, hands-on chapter of a software engineering book grounded strictly in the verified diff from Step 3:

<chapter-template>
# Chapter <NN>: <Ticket Title>

## 1. The Goal & Big Picture
- **What we are building:** End-to-end behavior delivered by this slice[cite: 2].
- **Where it fits:** How this slice connects to existing modules and previous chapters (include a concise ASCII or Mermaid sequence/component diagram when flow crosses modules)[cite: 2].
- **Prerequisites:** Existing classes, schemas, or tickets this chapter builds upon[cite: 2].

## 2. Architectural Deep Dive (The "Why")
- Explain the design decisions, seams, and module depth revealed in the implementation[cite: 2].
- Explain why this structure was chosen over alternatives, plus any edge cases or invariants enforced by the code.
- If `code-review` surfaced subtle improvements during Step 2, highlight those lessons here so the reader avoids those traps[cite: 2].

## 3. File Map (Build Order)
Checklist of every file added or modified in `git diff <BASE_SHA>...HEAD`, ordered logically for manual coding (e.g., migrations -> domain models -> repositories -> deep modules -> handlers -> tests):
- [ ] `path/to/File.ext` — responsibility

## 4. Step-by-Step Implementation
Walk through each file in build order using the exact verified code from `HEAD`:
1. **Context & Purpose:** What this file does and how it connects to the slice.
2. **Verified Code:** The complete, exact file content (or exact diff/method context for modified files) taken directly from the verified commit—zero placeholders.
3. **Code Walkthrough:** Block-by-block explanation of annotations, types, library mechanics, and domain rules.

## 5. Verification & Testing (TDD Walkthrough)
- **Seam & Test Strategy:** Explain which public seam is tested and what observable behavior is verified[cite: 2].
- **Verified Test Code:** Provide the exact test file(s) from `HEAD` and walk through the assertions[cite: 2].
- **How to Verify Locally:** Exact terminal commands to run the tests and verify the feature manually in your own repo.
- **Acceptance Checklist:** The ticket's acceptance criteria to check off once you finish coding[cite: 2].
</chapter-template>

Commit `docs/book/<NN>-<ticket-slug>.md` to the current branch with message `docs: add book chapter <NN> (<ticket-slug>)`.

## Completion Criterion
Done when:
1. The ticket was genuinely implemented, tested, and reviewed via `/implement`[cite: 2].
2. `docs/book/<NN>-<ticket-slug>.md` is written and committed to the reference repository alongside the verified code.
3. Report to the user:
   - The path to the book chapter (`docs/book/<NN>-<ticket-slug>.md`)
   - The commit range (`<BASE_SHA>..HEAD`) for reference
   - A 3-bullet summary of what they will build and learn in this chapter.