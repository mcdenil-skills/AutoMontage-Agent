# Security policy

## Reporting a vulnerability

Do not publish a working exploit or secret in a public issue. Use the repository's
[private security advisory form](https://github.com/mcdenil-skills/AutoMontage-Agent/security/advisories/new)
and include the affected command, input shape, impact, and a minimal reproduction.

## Supported release

Security fixes target the latest released version. CI blocks high and critical npm
advisories and scans Git history with Gitleaks. A lower-severity exception is allowed only
when its exact dependency path, exposure, mitigation, owner-visible deadline, and revisit
triggers are recorded below and accepted by `npm run check:release`.

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
feature commits. The remaining accepted dependency risk is documented below. OCR remains a
warning system rather than a proof that an image has no text or logo, so the full visual preview
and explicit human approval remain mandatory.

## Temporary dependency exception

As of 2026-09-08, `npm audit` reports five moderate findings that all describe one
transitive advisory. The installed path is:

```text
node-vibrant@4.0.4
  -> @vibrant/image-node@4.0.4
  -> @jimp/custom@0.22.12
  -> @jimp/core@0.22.12
  -> file-type@16.5.4
```

[GHSA-5v7r-6r5c-r473 / CVE-2026-31808](https://github.com/advisories/GHSA-5v7r-6r5c-r473)
is a moderate denial of service: malformed ASF input with a zero-size sub-header can make
`file-type` loop indefinitely. Versions from 13.0.0 through 21.3.0 are affected; the fix
is in 21.3.1. The latest upstream `node-vibrant` release remains
[4.0.4](https://github.com/Vibrant-Colors/node-vibrant/releases/tag/v4.0.4), so there is no
compatible dependency update that brings this project to `file-type@21.3.1` today.

The reachable feature is optional `--autotheme`. AutoMontage passes the user video to
ffmpeg, which emits at most 20 scaled PNG frames. Jimp/Vibrant receives those locally
generated PNG files, not the raw video or an arbitrary ASF upload. This sharply reduces
exposure to the vulnerable ASF detector. The command still runs locally under the invoking
user, so a hang remains an availability risk and is not treated as fixed.

We keep `node-vibrant@4.0.4`. We do not run `npm audit fix --force`, install a major
override, or downgrade to the incompatible 3.x line. Reassess immediately on an upstream
node-vibrant/Jimp update, if severity becomes high, if direct untrusted-image input is
introduced, at the next release, or no later than 2026-10-06.

For release 1.7.0, the GitHub Security Advisory, npm registry metadata, and the installed
transitive dependency chain were reviewed again on 2026-09-08. The latest upstream
`node-vibrant` remains 4.0.4; the installed chain and limited local `--autotheme` exposure still
match the advisory and mitigation recorded below. This review accepts the remaining moderate
availability risk until 2026-10-06; it does not claim that the dependency is fixed.

The block below is the machine-readable release-gate record. Keep the prose and JSON in
sync. The gate also derives the installed five-package chain from the candidate
`package-lock.json`, requires exactly those five entries, and accepts `reviewedAt` only when
it matches the dated section for `reviewedFor`. A date one day ahead of UTC is accepted only
after 10:00 UTC, when that date has already begun in UTC+14.

```json security-exception
{
  "ghsa": "GHSA-5v7r-6r5c-r473",
  "cve": "CVE-2026-31808",
  "severity": "moderate",
  "package": "file-type@16.5.4",
  "fixedIn": "file-type@21.3.1",
  "chain": [
    "node-vibrant@4.0.4",
    "@vibrant/image-node@4.0.4",
    "@jimp/custom@0.22.12",
    "@jimp/core@0.22.12",
    "file-type@16.5.4"
  ],
  "exposure": "Optional --autotheme passes only ffmpeg-generated PNG frames to Jimp/Vibrant, not raw ASF input.",
  "mitigation": "Local-only CLI path, at most 20 scaled PNG frames, no direct untrusted-image upload into file-type.",
  "decision": "Keep node-vibrant@4.0.4; do not force-fix, override the major chain, or downgrade to 3.x.",
  "triggers": [
    "upstream node-vibrant/Jimp update",
    "severity becomes high",
    "direct untrusted-image input",
    "next release"
  ],
  "reviewedAt": "2026-09-08",
  "reviewedFor": "1.7.0",
  "revisitBy": "2026-10-06"
}
```
