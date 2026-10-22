# Security Policy

## Reporting A Vulnerability

Use GitHub private vulnerability reporting for this repository. Do not disclose a vulnerability, exploit, credential, private Google resource identifier, applicant information, or deployment detail in a public issue.

If private vulnerability reporting is unavailable, contact the repository owner through their GitHub profile without including sensitive technical details in the initial message.

Please include:

- the affected file or component;
- the security impact;
- minimal reproduction steps using synthetic data;
- whether the issue affects Apps Script, Sheet integrity, outbound requests, notification delivery, or dependency security;
- a suggested remediation, when available.

## Scope

Security reports may include authorization bypasses, unsafe outbound URLs, formula or HTML injection, secret exposure, notification abuse, lifecycle corruption, unbounded collection, and dependency vulnerabilities.

Ordinary source outages, stale job listings, matching disagreements, and unsupported companies are operational or product issues unless they create a security impact.

## Deployment Safety

This repository contains no live deployment identifiers or credentials. Keep `.clasp.json`, `.clasprc.json`, generated artifacts, runtime logs, private Sheet data, and Script Properties out of Git. Use a private container-bound Sheet and Apps Script project, review OAuth scopes, and keep notification delivery disabled until your own acceptance checks pass.
