# Contributing to Agent Change Map

Thank you for helping build Agent Change Map. The project is pre-alpha and pre-implementation, so contributions should remain aligned with the accepted specifications and should not imply that planned behavior already works.

## Before you start

1. Read the proposal, design, and capability specifications under `openspec/changes/initial-agent-change-map-mvp/`.
2. Keep the MVP boundaries and threat model intact.
3. For a substantial change, open or join a discussion before investing in implementation.
4. Never include secrets, private repository content, or public exploit details.

The project does not yet publish verified setup, build, or test commands. Do not invent them. Add commands only alongside the configuration that makes them executable and after verifying their behavior.

## Make a focused change

Use a short-lived feature branch and keep each branch responsible for one reviewable outcome.

For work that must be split into dependent slices, use a feature-branch chain:

1. Branch the first slice from the repository's current integration branch.
2. Branch each dependent slice from the preceding feature branch.
3. Open the pull requests in dependency order and identify the previous and next pull request in each description.
4. After an earlier slice merges, rebase or retarget the next slice as appropriate, then re-run its verification.

Do not combine unrelated cleanup with a feature or fix. Prefer pull requests under **400 authored changed lines** (additions plus deletions, excluding generated or vendored content). If a change must exceed that target, explain why it cannot be split without harming review or safety.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(optional-scope): <concise description>
```

Common types include `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, and `security`. Keep commits coherent and reviewable. Do not commit generated noise or unrelated formatting changes.

## Tests and verification

Every behavioral change must include tests that describe externally meaningful behavior, not merely implementation details.

- Start with the failing behavior or threat case.
- Cover the expected result and relevant refusal or error paths.
- For security boundaries, include adversarial inputs and verify that failure is safe.
- For bug fixes, add a regression test that fails before the fix.
- Record the exact verification performed in the pull request.
- If a test cannot yet run because the harness is not implemented, state that limitation honestly; do not claim it passed.

Documentation-only changes should be checked for accurate links, consistent terminology, and claims that match the repository's actual state.

## Pull requests

A pull request should:

- explain the user-visible or contributor-visible outcome;
- identify what is intentionally out of scope;
- link the relevant specification, discussion, or issue;
- list tests and their observed results;
- describe security implications and safe failure behavior;
- call out dependencies on other pull requests; and
- stay under the 400-line review target or justify the exception.

Review feedback should be addressed with focused follow-up commits or a clearly explained revision. Maintainers may ask for a large change to be split.

## Security and conduct

Do not report vulnerabilities in a public issue, discussion, or pull request. Follow the private process in [SECURITY.md](SECURITY.md).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
