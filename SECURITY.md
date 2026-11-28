# Security policy — OrdexaGo

OrdexaGo (https://ordexago.com) is an accounting and order-processing app that also handles Amazon and Shopify
buyer data. This file describes how security problems are reported, tracked and fixed.

## Reporting a vulnerability

Email **help@ordexago.com** with the subject "Security". Please don't open a public issue for an unfixed
vulnerability. We acknowledge reports within 3 working days.

## Remediation timelines (SLAs)

Counted from the day a finding is confirmed (scanner result, Dependabot alert, audit failure or report):

| Severity | Fix or mitigate within |
|---|---|
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low / informational | Next planned maintenance, or accepted with a written reason |

Severity follows the source's rating (CVSS for dependencies, ZAP risk level for scan alerts: High → high,
Medium → medium, Low → low). A finding that exposes buyer personal data or credentials is treated as critical.

## Where findings come from

- **Dependency audit in CI** (`.github/workflows/ci.yml`): `npm audit --omit=dev --audit-level=high` for the backend
  and the frontend on every push and pull request. A high or critical advisory fails the build; the dependency is
  upgraded or replaced, not ignored.
- **Dependabot** (`.github/dependabot.yml`): weekly update PRs for backend and frontend npm packages and GitHub
  Actions, plus Dependabot security alerts (enable in GitHub → Settings → Code security).
- **OWASP ZAP baseline scan** (`.github/workflows/zap-baseline.yml`): passive scan of https://ordexago.com monthly
  and on demand; results go to the issue "ZAP baseline scan: ordexago.com", updated on each run.

## Issue labels

| Label | Meaning |
|---|---|
| `security` | A security finding or fix (all ZAP issues and security reports) |
| `zap-scan` | Raised by the OWASP ZAP baseline scan |
| `dependencies` | Dependency update (Dependabot); with `backend`, `frontend` or `github-actions` |
| `severity:critical`, `severity:high`, `severity:medium`, `severity:low` | Set when a finding is triaged; drives the SLA above |

## Controls in the app (summary)

- Security log (Settings → Security): append-only record of sign-ins, failed sign-ins, password and two-step
  changes, user/role changes, Amazon order views and label downloads, exports, deletions and credential/settings
  changes, kept at least one year (400 days). Email alerts to the superadmin and company admins for repeated
  failed logins, blocked devices, Amazon data access outside 08:00–21:00 IST, unusual Amazon access volume, role
  changes and credential changes.
- Passwords: 12+ characters with mixed case, a number and a symbol; not the user's name/email or a common password;
  365-day expiry; last 5 not reusable; 5 failures in 10 minutes lock the account for 15 minutes.
- Sessions: 12 hours of inactivity; changing the password signs out all other sessions.
- Two-step login (TOTP + 10 one-time recovery codes), mandatory for the superadmin, company admins and anyone with
  store order or shipping access.
- Approved devices: staff can open Amazon buyer data (order details, labels, Easy Ship, exports) only from a
  browser an admin approved.
- Stored third-party credentials (Amazon, Shopify, couriers, GSP, email, Gemini) encrypted with AES-256-GCM
  (`CREDENTIALS_KEY`); never sent to the browser.
- Amazon buyer data erased 30 days after delivery (see /privacy).
- Rate limits per IP (in memory): sign-in steps 40 per 10 min, password-reset / sign-up emails 10 per hour,
  invitation / reset / verify links 60 per 10 min, public forms 30 per hour, the whole API 1,500 per minute; refusals
  are written to the security log. Loopback (the server itself) is exempt.
- NoSQL injection: keys starting with `$` are removed from every query string and JSON body before routes run.
- Reset, verification and invitation tokens are stored only as SHA-256 hashes; reset / verify links expire after
  1 hour, invitations after 7 days (14 for sellers / subscribers). Emailed links always use APP_URL.
- Uploaded files open in the browser only when they are images or PDFs; anything else downloads. Seller listing
  HTML keeps simple tags without attributes.
- AI (admins only, Gemini): tool results sent to the AI never include phone numbers, emails, addresses or store
  buyers' names.
- The app listens on 127.0.0.1 only (`HOST`); nginx terminates HTTPS and redirects HTTP.
- Encrypted nightly off-site backups to OCI Object Storage (AES-256-GCM with `BACKUP_KEY`), 30 days kept.
