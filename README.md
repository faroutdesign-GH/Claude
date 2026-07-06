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
