# Security Policy

## Supported versions

Security fixes go into the latest 0.x release. Earlier releases are not patched:
update to the latest one.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/ichbinmeraj/abb-rws-mcp/security/advisories/new)
rather than opening a public issue. You should receive a response within a week.

## Scope notes

This software talks to industrial robot controllers. Anything that could allow
an unauthorized party to move a robot, alter RAPID programs, bypass an intended
safety gate, or intercept controller credentials is in scope.

For this server that includes: any path by which a tool, a prompt or controller
text could make it send something other than the daemon's read requests; the
daemon's access token (where it is read, where it is sent, and anything that
puts it in a log line or an answer); the loopback-only connection; and
controller text that escapes its controller-data block.

## Controller behaviour is not this project's scope

A finding about how an ABB controller itself behaves belongs with ABB's product
security team, not here. Please allow coordinated disclosure before publishing.
