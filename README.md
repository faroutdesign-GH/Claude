# Far Out Design — Ops Agent

A Google Apps Script that runs on `ops@faroutdesign.us` every 15 minutes. It
triages inbound email with Claude and acts in JobTread:

- **Qmerit installs** → creates a job + customer + quote-due todo under the Qmerit parent account
- **Permit / inspection notices** → updates the matching job's permit status and logs a comment
- **New leads / service calls** → creates a standalone customer, job, contact, and follow-up todo
- **Permitting-portal account notices** (CommunityCore, Accela, etc. — "account created", "activate your account") → emails Curtice the details; never touches JobTread and never clicks the link itself
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
here). Confirm it works before relying on it — it's read-only, never touches
JobTread:

1. Paste the updated `src/FarOutOpsAgent.gs` into the Apps Script project (replacing what's there), Save.
2. In the function dropdown at the top of the editor, choose `testPermitPdfExtraction_HernandoSample`, then click **Run**.
   (This runs against a real Hernando County "Permit Issued" email already in the
   inbox that has a permit-card PDF attached and no permit number in the email text —
   exactly the case this fix is for.)
3. Approve any permission prompt the first time.
4. Check `curtice@faroutdesign.us` for an email titled "FOD Ops Agent — permit PDF test" —
   it will show the permit number, address, and status the PDF extraction found.
   Confirm those match the actual permit card before trusting this on live email.

To test against any other permit email later, open it in Gmail, copy the long ID
from the browser URL (after `#inbox/` or `#all/`), and run
`testPermitPdfExtraction_("that id")` from the editor's console instead.

### New category: permitting-portal account notices

Running the agent live surfaced a real miss: a "CommunityCore - Account Setup"
email (CommunityCore is a municipal permitting portal — same category as
Accela/EnerGov/HillsGovHub — this one for the North Redington Beach jurisdiction)
was classified as "Unrecognized email type" with no useful detail. These are
account-access notices ("account created", "activate your account", password
resets) with no permit number or job to attach to, so `permit` handling doesn't
fit them — but silently binning them as "unrecognized" isn't good enough either,
since the activation link expires (5 days on this one) and a missed link means
losing portal access to that municipality's permit records.

Added a `portal` classification: when it fires, it sends Curtice a specific email
naming the portal, the municipality, and the expiry window, instead of a generic
"please review." **It deliberately never fetches or clicks the link itself** —
account setup/password-reset links are exactly the kind of thing an automated
script should never auto-visit, so this only surfaces the details for a human to
act on.

**Verification:** this classification has not been confirmed against a real
message yet. To check it, run `testClassifyMessage_CommunityCoreSample` from the
Apps Script Run dropdown — it's **read-only**: it only calls the classifier and
emails you the result, it never calls a handler, so it cannot create a JobTread
job/account or send Curtice a live notification. Confirm the email you get back
shows `"type": "portal"` with `portalName`/`municipality` filled in correctly,
not `"type": "other"`. (It targets the exact email that was previously flagged
"Unrecognized" — that original email won't get reprocessed by the live agent on
its own since it's already marked read; this test hook is how to check the fix
without waiting for a new similar email to arrive.)

To test classification against any other email, open it in Gmail, copy its
message ID from the URL, and run `testClassifyMessage_("that id")` instead.
