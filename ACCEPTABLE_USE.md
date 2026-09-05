# Acceptable Use and Responsible Use Policy

Agent Change Map is a pre-alpha VS Code extension that reads Git worktrees, may edit code with explicit user approval, and runs untrusted Python snippets only inside its restricted Docker runtime. Use it only on systems, repositories, and code you own or are authorized to access.

## Allowed use

You may use Agent Change Map for legitimate development, review, education, testing, and authorized security research. You remain responsible for the code, data, tools, containers, and infrastructure you provide or affect.

## Prohibited use

Do not use Agent Change Map to:

- access, inspect, copy, modify, or disclose repositories, worktrees, source code, or data without authorization;
- create, distribute, deploy, or assist malware, ransomware, destructive code, persistence mechanisms, or supply-chain attacks;
- escape, weaken, probe for bypasses of, or gain unauthorized access beyond the Docker sandbox or host boundaries;
- steal, expose, solicit, or misuse credentials, tokens, keys, cookies, personal data, or other secrets;
- execute code intended to harm people, systems, services, data, or networks, or to conceal such harm;
- bypass, disable, misrepresent, or automate around confirmation prompts, safety checks, permission boundaries, resource limits, or audit controls; or
- use the project in violation of applicable law, contractual duties, or third-party rights.

Discovery of a safety or security weakness does not authorize exploitation, persistence, access to unrelated data, or public disclosure of sensitive details.

## Safe operation

- Review repository scope, proposed edits, and command inputs before approving them.
- Treat repositories and snippets as untrusted. Keep Docker and VS Code updated, use least privilege, and avoid mounting secrets or sensitive host paths.
- Inspect generated changes before applying, committing, or publishing them.
- Stop execution if behavior, scope, or output is unexpected.

## Security reporting

Do not open a public issue containing a vulnerability, secret, exploit payload, or sensitive log. Use the repository's **Security** tab and select **Report a vulnerability** to submit a private GitHub security advisory. If private reporting is unavailable, contact the maintainers privately and share only enough information to establish a secure reporting channel.

## No security warranty

Agent Change Map is pre-alpha software. Its confirmation flows and restricted Docker execution reduce risk but do not guarantee isolation, correctness, confidentiality, integrity, availability, or fitness for security-sensitive use. The project provides no security warranty. You are responsible for independent review, backups, environment hardening, and compliance with applicable requirements.

Violations may result in rejected contributions, restricted participation, or other action appropriate to protect users and the project.
