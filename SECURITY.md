# Security policy

## Reporting a vulnerability

Do not publish a working exploit or secret in a public issue. Use the repository's
[private security advisory form](https://github.com/mcdenil-skills/AutoMontage-Agent/security/advisories/new)
and include the affected command, input shape, impact, and a minimal reproduction.

## Supported release

Security fixes target the latest released version. CI blocks high and critical npm
advisories and scans Git history with Gitleaks. A lower-severity advisory must be fixed
before release or documented in this file with its exact dependency path, exposure,
mitigation, and revisit date. No accepted dependency risk remains; `npm audit` reports no
findings (#33).

## B-roll discovery review for 1.6.0

The 2026-09-08 release review covered the new Pexels search, candidate proxy, selected-file
download, media import, OCR evidence, preview receipt, approval gate, and Remotion environment.
The public regression suite verifies these boundaries:

- `PEXELS_API_KEY` is read only by the local Node.js server, removed from preview child
  processes, and excluded from the Remotion browser environment;
- the browser receives opaque, expiring candidate IDs tied to one Review session, scene, query,
  and search generation; it cannot submit a download URL;
- remote requests require HTTPS, exact provider hosts, public DNS answers, revalidated redirects,
  identity encoding, bounded headers/body/time/redirects, and an expected MIME type;
- the selected file enters the existing owner-only quarantine and must pass file signature,
  ffprobe, full decode, geometry/duration limits, normalization, identity checks, and SHA-256;
- Save, preview, approval, and final render use revision/hash checks. Pending B-roll intent or
  unacknowledged OCR evidence blocks approval, and search or import never approves a draft;
- the loopback Review server checks the bearer token, Host, Origin, request shape, size, and
  edit capability before state-changing routes.

The review found no high or critical dependency advisory and Gitleaks found no secret in the
feature commits. OCR remains a warning system rather than a proof that an image has no text or
logo, so the full visual preview and explicit human approval remain mandatory.
