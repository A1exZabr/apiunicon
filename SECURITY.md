# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. There are two ways:

1. **GitHub private vulnerability reporting.** Open the repository's **Security** tab and select **Report a vulnerability**. Only you and the maintainers see the report.
2. **Email** support@apiunicon.online with the subject **Security**. There is no separate security address; this mailbox is the right one.

Include what you can:

- what is affected (a file, an HTTP route, an MCP tool, a page);
- how to reproduce it, ideally against a fresh local install with test data;
- what an attacker gains: reading keys, sending requests to an address the person did not approve, changing data without confirmation, and so on.

We will confirm that we received the report, keep you informed while we work on it, and credit you in the fix unless you prefer otherwise. Please give us a reasonable time to release a fix before you publish details.

## Scope

This repository is the local version of APIUniCon. Reports about the cloud versions at apiunicon.online and apiunicon.ru are welcome through the same channels.

Only the latest code on the default branch is supported. Fixes are not backported to older snapshots.

## What not to post in public issues

Public issues are visible to everyone and are indexed by search engines. Never put any of these in an issue, a discussion, or a screenshot:

- details of a vulnerability before it is fixed;
- API keys, tokens, or passwords, including the local administrator password;
- the master key file, the SQLite database, or anything else from your APIUniCon data folder (`~/.apiunicon` by default);
- key-entry and confirmation links: each carries a one-time token;
- API responses, customer or account data, or service logs that contain them.

If you posted something like this by mistake, revoke the key or token at the service that issued it first, then edit or delete the post.
