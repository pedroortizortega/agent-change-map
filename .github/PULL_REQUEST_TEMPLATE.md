## Scope

<!-- What does this PR change? Lead with the reviewer-relevant outcome. -->

### Out of scope

<!-- What is intentionally not addressed? -->

## Linked issue

Closes #<!-- issue number -->

## Chain context

<!-- Standalone, or link the previous/next PR and state this PR's position in the chain. -->

- Previous PR: N/A
- Next PR: N/A

## Security impact

<!-- Cover repository/code access, edits, confirmations, secrets, Docker isolation, untrusted Python execution, and host boundaries as applicable. Write "None" with a reason if unaffected. Do not paste secrets or exploit payloads. -->

## Verification

### Tests

<!-- List commands and results. -->

### Runtime harness

<!-- Describe manual/runtime scenarios exercised, including Docker/Python harness coverage when relevant. Use N/A with a reason if not applicable. Redact secrets, private paths/code, and sensitive logs. -->

## Rollback

<!-- Explain how to disable or revert this safely, including any persisted-state implications. -->

## Review size

- Authored changed lines (additions + deletions, excluding generated/vendor files): <!-- number -->
- [ ] Authored line budget is **400 lines or fewer**.
- [ ] `size:exception` rationale is provided below because the budget is exceeded.

### `size:exception` rationale

<!-- Required only above 400 authored changed lines: explain why this cannot be split safely and how review risk is reduced. -->

## Checklist

- [ ] The linked issue defines the user need and acceptance criteria.
- [ ] The scope is focused; unrelated changes are excluded.
- [ ] I reviewed security and privacy impact, including untrusted input and confirmation boundaries.
- [ ] I added or updated tests for changed behavior, or explained why none are needed.
- [ ] I exercised the relevant runtime harness and recorded results, or marked it N/A with a reason.
- [ ] I updated documentation and user-facing text where needed.
- [ ] Logs, screenshots, fixtures, and examples contain no secrets or private code/data.
- [ ] The rollback path is documented and practical.
- [ ] Chain links are complete, or this PR is explicitly standalone.
- [ ] The review-size declaration is accurate; if over 400 authored lines, I supplied a `size:exception` rationale.
