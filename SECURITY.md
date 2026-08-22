# Security Policy

## Supported versions

Until the first tagged release, security fixes are handled on the current `main` branch. There is no hosted service or guaranteed response SLA yet.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub Private Vulnerability Reporting on this repository, or contact the maintainer privately through the repository profile.

Do not include credentials, tokens, cookies, private skills, session data, runtime databases or unredacted logs in a report.

A useful report includes:

- affected component and commit/version;
- reproducible steps without private data;
- impact assessment;
- a minimal sanitized proof of concept where safe;
- any suggested mitigation.

The maintainer will acknowledge the report when practicable, investigate it, and coordinate disclosure after a fix or mitigation is available. Response timing cannot be guaranteed before a public security contact is configured.

## Public issue hygiene

Use the bug report template for non-sensitive defects. Sanitize logs and verify that paths, environment variables, generated provenance and fixtures do not reveal private runtime data.
