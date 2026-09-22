# Security Policy

## Supported versions

This project is in early development. Only the latest commit on `master`
receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/ichbinmeraj/abb-rws-mcp/security/advisories/new)
rather than opening a public issue. You should receive a response within a week.

## Scope notes

This software talks to industrial robot controllers. Anything that could allow
an unauthorized party to move a robot, alter RAPID programs, bypass an intended
safety gate, or intercept controller credentials is in scope - including
authentication flows, credential storage, TLS handling, and any path that lets
a write reach a controller without passing the intended confirmation.

## Controller behaviour is not this project's scope

A finding about how an ABB controller itself behaves belongs with ABB's product
security team, not here. Please allow coordinated disclosure before publishing.
