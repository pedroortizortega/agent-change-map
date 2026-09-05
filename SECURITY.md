# Security Policy

Agent Change Map is pre-alpha and pre-implementation. No release is currently supported for security updates. Security reports about the design, specifications, repository, or future implementation are still welcome.

## Supported versions

| Version | Supported |
|---|---|
| No released version | No |

This table will be updated when the project publishes its first supported release.

## Report a vulnerability privately

1. Open this repository on GitHub.
2. Select the **Security** tab.
3. Select **Advisories**, then **Report a vulnerability** to create a private GitHub Security Advisory report.
4. Include the affected artifact or planned boundary, impact, reproduction conditions, and any suggested mitigation.

If GitHub does not show the private reporting option, contact a repository maintainer privately through an available GitHub contact channel and ask for a secure reporting route. Do **not** open a public issue, discussion, or pull request containing exploit details.

Please allow maintainers time to acknowledge, investigate, and coordinate a fix before disclosure. Maintainers will work with the reporter on an appropriate disclosure timeline and attribution, if desired. Because there is no supported release yet, response and remediation timelines are not guaranteed.

## Security scope

Reports are especially useful in these threat areas:

- parsing untrusted Python repositories without importing or executing them;
- Git reference, path, worktree, snapshot, or diff confusion that could mutate or expose unintended content;
- source-span or identity errors that navigate to or edit the wrong file;
- stale-state, race, conflict, backup, or atomic-write failures in direct-worktree editing;
- webview message validation, content security policy, injection, or privilege-boundary failures;
- command or argument injection into Git, Python, Docker, or other processes;
- Docker isolation failures involving network access, mounts, filesystem writes, capabilities, privileges, processes, resources, timeouts, output bounds, or cleanup;
- execution occurring without an explicit user action, or execution of unsupported non-Python/documentation-like files;
- leakage of repository content, snippet input, output, diagnostics, drafts, or persisted snapshots;
- denial-of-service through oversized repositories, diagrams, diffs, streams, or crafted parser input; and
- dependency, build, packaging, update, or extension-distribution supply-chain risks once those components exist.

## Not a security vulnerability

General feature requests, unsupported-language requests, diagram accuracy limitations without a security impact, and ordinary documentation corrections can use public project channels. When uncertain, report privately and let the maintainers triage it.

## Disclosure expectations

Do not publish exploit code, proof-of-concept details, sensitive repository data, or instructions that enable abuse before maintainers have assessed the report and coordinated disclosure. A sanitized public advisory may be published after mitigation is available or the risk is otherwise resolved.
