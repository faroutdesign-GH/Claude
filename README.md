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

### Audit against live inbox + JobTread data (2026-07-21)

Checked real mailbox history and JobTread against both the permit and lead paths.

**Fixed — a live bug, not historical.** `flagReview_` labels a thread
`Agent-Needs-Review` but not `Agent-Processed`, and `notify_` doesn't label the
thread at all. `processInbox_` only excluded `-label:Done -label:Pending`, so a
reply to any of *our own* outbound notifications — even a one-word "Ignore" from
Curtice — went unread again, got swept back into the inbox search, and was fed
through the classifier as if it were a new customer email. This actually happened
live: Curtice's "Ignore" reply to a review-flag email came back "Unrecognized
email type," producing a confusing self-referential notice and wasting a Claude
call. Fixed two ways: `processInbox_` now also excludes `-label:` Needs-Review,
and — the real fix — it now skips (and marks done) any thread whose **first**
message was sent by `ops@faroutdesign.us` itself, since a thread we started is
never new inbound business, no matter what label ended up on it.

**Hardened.** `extractJSON_` used a raw, unguarded `JSON.parse` — if Claude ever
replies with prose instead of JSON (confirmed happened for real on 2026-06-30, see
below), it threw an opaque `SyntaxError` instead of a readable message. It now
raises a clear "Claude did not return JSON" / "Claude's JSON was malformed"
error with the actual text, so a future occurrence is diagnosable from the
notification email alone instead of needing the execution log.

**Found, not caused by anything in this repo — needs manual follow-up.** A City
of Largo "Inspection Results - Electrical Final" email from 2026-06-25 (permit
`ELEC-26-000269`, inspector Cox/Andrew, status **Passed**) crashed the *original*
pre-refinement script with that same unguarded-JSON.parse bug and was never
applied to any job — confirmed by querying JobTread directly for a job with that
permit number: none exists. **This inspection pass may never have been recorded
in JobTread — worth checking that job manually.** The crash path itself no longer
exists in the current code (the classify+extract consolidation and the PDF
fallback's internal error handling both catch this now, and the extractJSON_
hardening above makes any future recurrence loud instead of silent), so this is
a one-time data gap to close by hand, not an ongoing risk.

**Update:** Curtice added the missing permit number to Job #1927 ("Service
Upgrade") directly in JobTread. Confirmed via a live query — `ELEC-26-000269`
is now on that job. Its **permit-status field is still "Permit Received"**
though, not updated to reflect the actual Passed/Electrical-Final result — the
number being missing is exactly why the automated match (and status update)
never fired in the first place. Applying that status update is a manual
follow-up, not something this audit changes on its own.

### Address matching for permits was never actually implemented

Real bug, reported directly: the code had a comment saying "try address, but
FLAG (never guess across multiple jobs)" right where a permit had no known
permit number — but no address-matching code ever followed that comment. Every
permit that didn't match by number went straight to asking Curtice, regardless
of whether the email had a usable address. So "recognizing jobs based on
addresses listed in the email" never worked at all, not intermittently.

Added `findJobsByAddress_`, matching the same pattern already used for the
Qmerit duplicate check: it queries `job.location.address` with a `LIKE` on the
street portion of the extracted address (before the first comma), skipping
short/generic fragments. Verified the exact query shape against the live API
(`{"like": [{"field": ["location", "address"]}, {"value": "%...%"}]}`) before
wiring it in — a first draft had a brace nested one level wrong that `node
--check` didn't catch (still valid JS, just querying the wrong field path); the
version that shipped was re-verified against a real address and returned the
correct single job.

Behavior now: **exactly one address match** → applied automatically, same as a
permit-number match, but the notification says "matched by ADDRESS, not permit
number" so it's easy to spot-check. **Zero or multiple matches** → still asks
Curtice as before, but now lists the candidate jobs when there's more than one,
instead of leaving him to hunt for the job number himself.

**Confirmed fine, not a bug.** A "Security alert" (a real Google sign-in
notification for `ops@faroutdesign.us`) was correctly classified as `other` and
flagged for review — that's the intended fallback for anything that genuinely
isn't a qmerit/permit/lead/portal email, working as designed.

**Lead path: unverified — never fired on real data.** Searched all mail history
for any `✅ Created Job #...` notification (non-Qmerit) or any `[FOD-Q: lead-...]`
question, going back over the full available history. **Zero results either
way.** `handleLead_` has not been exercised by a single real email since this
agent has existed, positive or negative. It's implemented correctly on read-through
and shares the same classification path as permit, so there's no known bug in
it — but "no evidence of failure" and "confirmed working" are different claims,
and only the first one is true right now. If a real new-customer-lead email
comes in, its outcome is worth checking the first time, the same way the permit
and portal paths were checked here.

### Live audit (2026-07-28) — two prior "unverified" items were actually confirmed, one new bug found

With direct access to the live mailbox and JobTread data, re-checked everything
this README had flagged as needing manual confirmation:

**PDF extraction — now confirmed, this document's caveat above was stale.** The
2026-07-21 "FOD Ops Agent — permit PDF test" email shows `testPermitPdfExtraction_`
correctly extracted `permitNumber: "RESELEC-000119-2026"`, the site address, and
`municipality: "Hernando County"` from a real forwarded "Permit Issued" email
with no permit number in the body text. Working as designed.

**Portal classification — now confirmed, same stale caveat.** The 2026-07-21
"FOD Ops Agent — classification test" email shows the CommunityCore "Account
Setup" message correctly classified `"type": "portal"` (not `"other"`), with
`portalName`, `purpose`, and `expiresIn` all extracted. Working as designed.

**Job #1927 permit-status field — resolved.** Queried the job directly: the
Permitting & Inspections field now reads "All Inspections Passed" with permit
`ELEC-26-000269` attached. The manual follow-up noted above is done; no code
or data action needed.

**New bug, real (though not yet harmful) impact: address matching accepted a
bare city name as a "street."** Both the Qmerit duplicate check and
`findJobsByAddress_` derived a "street" by taking everything before the first
comma and requiring only `length >= 5`. A live Qmerit email for **project
#584627** (2026-06-30) had its address extracted as just `"Plant City, FL
33565"` (no street) on the first pass;
`"Plant City"` is 10 characters, so it passed the length check and got matched
via `LIKE %Plant City%` against every Qmerit job in that city, not just jobs at
that address. In this specific case the same project's *second* extraction
pass (8 seconds later) returned the full address and correctly matched the
real duplicate (Job #1968, confirmed via JobTread), so no wrong outcome
resulted this time — but the mechanism itself was unsound: in a city with
multiple distinct Qmerit installs, a bare-city fragment could flag an
unrelated job as a false "duplicate" (or, on the permit side, a false address
match), and even when it happens to be correct, the notification shows the
uninformative "Plant City, FL 33565" instead of the real matched address.
Checked the other three live `qmerit-dup-*` cases in mailbox history
(`#585114` → Job #1983, `#585536` → Job #2001, `#457338` → Job #1989, the last
one only findable by job *name*, not description, which the initial description-only
check missed) — all three were genuine duplicates, so this bug had not yet
produced a wrong result live, just an unsound one waiting to happen.

Fixed by requiring the extracted "street" fragment to also contain a digit
(a house number) before it's used in either matcher — `"Plant City"` no longer
qualifies, `"3110 Charlie Taylor Rd"` still does. Same one-line guard applied
to both `handleQmerit_`'s dedup check and `findJobsByAddress_`.

**Still pending, not a code issue:** as of 2026-07-28 there are four
unanswered `[FOD-Q: permit-*]` questions in the mailbox (`PLUM-26-000221` ×2 —
same permit, "issued" then "Passed" status, neither with an address to match
by — `BLD-26-0523945`, and `EBP-26-11600`), all correctly awaiting Curtice's
reply since none matched an existing job by number or address. These are
business decisions for a human, not something for the agent to guess at.
