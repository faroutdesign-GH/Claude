# Far Out Design — Ops Agent

A Google Apps Script that runs on `ops@faroutdesign.us` every 15 minutes. It
triages inbound email with Claude and acts in JobTread:

- **Qmerit installs** → creates a job + customer + quote-due todo under the Qmerit parent account
- **Permit / inspection notices** → updates the matching job's permit status and logs a comment
- **New leads / service calls** → creates a standalone customer, job, contact, and follow-up todo
- Anything ambiguous → emails Curtice a `[FOD-Q: id]` question. **Reply to that email** (answer on the first line) and the agent applies it on the next run, or reply `SKIP`.

Source: [`src/FarOutOpsAgent.gs`](src/FarOutOpsAgent.gs)

## Setup

1. In the Apps Script project: **Project Settings → Script Properties**, add:
   - `JT_GRANT_KEY` — JobTread grant key
   - `ANTHROPIC_KEY` — `sk-ant-...` API key
2. Run `setupTriggers` once and approve permissions (installs the 15-minute trigger).
3. Run `testAgent` to confirm JobTread, Anthropic, and Gmail all connect.

## What changed in this refinement (2026-07)

Three fixes, all verified against the live JobTread API:

1. **Reply loop now works.** `processReplies_` searched for the `Agent-Awaiting-Curtice`
   label, but that label sits on the original *inbound* thread — Curtice's reply
   to a `[FOD-Q: id]` email lands in a *separate* thread that never carries the
   label, so answers were never applied. It now finds the reply threads by subject.

2. **Permit replies no longer error.** The job-number lookup in `applyAnswer_` used
   `where: [["number","=",jobNum]]`, which the JobTread API rejects. It now uses the
   correct expression form `{"=": [{"field":["number"]}, {"value": jobNum}]}`, plus a
   guard so a missing permit number (`"—"`) isn't written to the job.

3. **One Claude call per email instead of two.** Classification and field extraction
   were two separate API calls per message; they're now a single `classifyAndExtract_`
   call, roughly halving the LLM cost and latency of processing each email.

No JobTread mutation logic, IDs, routing rules, or the noon-due-date logic were changed.

### Permit-number false positive (contractor license)

Permit emails are forwarded, and the forward adds Far Out's signature at the top —
including the Florida contractor license `EC13016150/ES12001208`. On municipality
notices that carry no permit number in the body text (e.g. Hernando County "Permit
Issued", where the number is only in the attached PDF), the extractor was grabbing
that license as the permit number. Fixed two ways: the extraction prompt now tells
the model to ignore the forwarder's signature/license and only take a municipal
permit number, and `sanitizePermitNumber_` drops any `EC#####` / `ES#####` /
`EC#####/ES#####` value as a backstop. When no real permit number is present it now
falls through to "match by job number" (asks Curtice) instead of storing the license.

### PDF attachment fallback for permit number/details

Some municipality "Permit Issued" emails (e.g. Hernando County) have **no permit
number in the email text at all** — it's only printed on the attached permit-card
PDF. When the body/subject give no permit number, `handlePermit_` now calls
`readPermitPdf_`, which pulls each PDF attachment on the message and sends it to
Claude as a PDF document (same Anthropic API, no beta header needed) to extract
the permit number, address, status, inspection details, etc. The same
`sanitizePermitNumber_` guard is applied to whatever the PDF extraction returns,
so a license printed on the PDF can't slip through either. If no PDF is attached,
or extraction finds nothing, it falls back to the existing "ask Curtice to match
by job number" flow — no behavior change from before for those cases.

This only fires when the body already didn't produce a permit number, so it adds
one extra Claude call only on the emails that actually need it (not on every
permit email).

**Verification note:** this was built against the real forwarded-email format
(signature-block false positive) and the documented Apps Script attachment API
(`GmailMessage.getAttachments`, `GmailAttachment.getBytes`, `Utilities.base64Encode`)
and Anthropic PDF document API — but it has **not** been run end-to-end against a
live permit PDF from this environment (no attachment-download tool was available
here). Before relying on it, run `testPermitPdfExtraction_("<message id>")` once
in the Apps Script editor against a real "Permit Issued" email (e.g. the Hernando
County one) — it only reads and emails the result, it never touches JobTread — and
confirm the extracted `permitNumber`/`address` look right.
