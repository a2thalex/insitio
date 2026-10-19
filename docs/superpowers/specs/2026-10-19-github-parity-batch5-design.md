# GitHub parity, batch 5: account

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

Depends on batch 4 (merged). Organizations and the notification inbox are later batches.

## Intent

A signed-in person on git.iam.bot should be able to manage the account around their profile:
addresses, sessions, a second sign-in factor, appearance, people they have blocked, and short
replies. A password remains required. Nothing here reveals a private repository.

## Goals

1. **Emails** — `/settings/emails`. Up to 5 addresses. One is primary and is copied onto
   `users.email`, which commits in the browser already use. Adding an address while signed in
   makes it yours. There is no outbound mail, so there is no verification message. An address
   cannot belong to two accounts.
2. **Sessions** — `/settings/sessions` lists this account's sessions with the time and the
   user agent. You can revoke one, or every session except the one you are using. Revoking
   deletes that session row. The cookie for a revoked session stops working.
3. **Two-factor authentication** — `/settings/security`. TOTP, 6 digits, 30 second step, one
   step of leeway. Enabling shows the secret and an `otpauth://` link, then asks for a code
   before the secret counts. Eight recovery codes are shown once and stored as hashes. A used
   recovery code is spent. Sign-in with the factor on requires the password and a current code
   or a recovery code. Wrong codes use the existing failure limit. Disabling requires the
   current password and a current code.
4. **Appearance** — `/settings/appearance`. Dark (today's theme, the default for existing
   accounts), light, or match the system. The choice is an attribute on `<html>`.
5. **Notifications** — the same page stores `participating`, `all`, or `ignore`. Insitio still
   does not send mail. The inbox in a later batch reads this value. Default is participating.
6. **Blocked users** — `/settings/blocks`, up to 50. You cannot block yourself. A blocked person
   cannot open an issue or pull request on your repository, or comment on one. The response is
   403. They can still read a public repository.
7. **Saved replies** — `/settings/replies`, up to 20. Title (80) and body (10_000). The comment
   form lists them. If the comment body is empty and a reply is chosen, that body is the comment.
8. **SSH and GPG keys** — `/settings/keys`. An SSH key is an OpenSSH public key (`ssh-ed25519`,
   `ssh-rsa`, or `ecdsa-sha2-nistp256/384/521`). The page shows `SHA256:` of the decoded key. A
   GPG key is an ASCII-armored public key block. The page shows the first 16 hex characters of
   SHA256 of that block. Neither key signs in or pushes yet. SSH git is a later batch.
9. **Security log** — `/settings/security` lists the last 50 events for this account: sign-in,
   password change, token create and revoke, email add and remove, two-factor enable and disable,
   session revoke, key add and remove, and block. The detail is a short label, not a secret.

## Non-goals (this batch)

- Organizations, teams, and OAuth applications.
- Email delivery, address verification links, and the notification inbox.
- Using an SSH key to authenticate git, and checking commit signatures.
- WebAuthn and SMS codes.

## Anti-goals

- A TOTP secret or a recovery code must not be stored in a URL or written into the security log.
- Blocking someone must not hide a public repository or turn it into a 404.
- Session revocation must not delete another account's session.
- An SSH or GPG field must not be executed or written outside the database row.

## Constraints

- One new migration. Do not edit older migrations.
- CSRF on every form. Sign-in stays rate limited.
- Tests cover TOTP with a fixed clock, a blocked comment, and a saved reply.

## Left to the builder

Exact SQL, the base32 decoder, and where the block check sits. The check runs when an issue,
pull request, or comment is created, and nowhere else.
