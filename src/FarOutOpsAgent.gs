/***********************************************************************
 * FAR OUT DESIGN — OPS AGENT  (Permit + Intake, email reply-to-act)
 * Runs every 15 min on ops@faroutdesign.us. Emails curtice@ on each
 * action or question. Reply to a [FOD-Q: id] email to resolve it.
 *
 * SETUP (one time):
 *   1. Script Properties (Project Settings > gear > Script Properties):
 *        JT_GRANT_KEY      = <Job Tread grant key>
 *        ANTHROPIC_KEY     = <sk-ant-... key>
 *   2. Run  setupTriggers  once, approve permissions.
 *   3. Done. It now runs every 15 min.
 *
 * REFINEMENTS (2026-07):
 *   - One Claude call per email (classify + extract combined) instead of two.
 *   - Fixed the reply loop: Curtice's answers to [FOD-Q: id] emails are now
 *     found and applied (previously they were never processed).
 *   - Fixed the Job Tread "where" query used to look up a job by number
 *     (previous syntax was rejected by the API, so permit replies always failed).
 ***********************************************************************/

// ---- CONSTANTS (verified IDs) ----
const ORG_ID        = "22P6fNy3jgsx";
const NOTIFY_EMAIL  = "curtice@faroutdesign.us";
const OPS_EMAIL     = "ops@faroutdesign.us";
const QMERIT_PARENT = "22PYR8DCRVRa";      // Qmerit E. 2026 parent account
const MB_SARAH      = "22P6fPTkLMXe";       // Sarah membership (service calls + scheduling)
const MB_BEN        = "22P7hfYhwMB7";       // Ben membership (sales rep, non-service)
const USER_CURTICE  = "22P2WhSVDyFd";
// Custom field IDs
const CF_PERMIT_STATUS = "22PAsRrJJc4X";
const CF_PERMIT_NUM    = "22PYpifdVwGr";
const CF_LEAD_TYPE     = "22P95YPX8fwP";
const CF_CONTRACT      = "22PGA8as4gD9";
const CF_SALES_STATUS  = "22P6fNyvcwAk";
const CF_SALES_REP     = "22PBgFev6YGS";
const CF_CONTACT_EMAIL = "22P6fNyvMdLz";
const CF_CONTACT_PHONE = "22P6fNzBDr7r";
// Gmail labels
const L_DONE    = "Agent-Processed";
const L_PENDING = "Agent-Awaiting-Curtice";
const L_REVIEW  = "Agent-Needs-Review";

const JT_URL = "https://api.jobtread.com/pave";
const CLAUDE_MODEL = "claude-sonnet-4-6";

/* ============================ ENTRY POINTS ============================ */

function runOpsAgent() {
  ensureLabels_();
  processReplies_();        // first: apply any answers Curtice sent back
  processInbox_();          // then: handle new email
}

function setupTriggers() {
  // clear old
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("runOpsAgent").timeBased().everyMinutes(15).create();
  Logger.log("Trigger installed: runOpsAgent every 15 minutes.");
}

/* One-shot manual check: does the PDF-attachment fallback correctly read a real
 * permit email? Open the message in Gmail, copy its message ID from the URL
 * (the long string after #inbox/ or #all/), then in the Apps Script editor run
 * testPermitPdfExtraction_() after pasting the ID below, or call it from the
 * console with a message ID string. Emails the result — never touches JobTread. */
function testPermitPdfExtraction_(messageId) {
  const msg = GmailApp.getMessageById(messageId);
  if (!msg) { Logger.log("No message found for id " + messageId); return; }
  const result = readPermitPdf_(msg);
  const out = result ? JSON.stringify(result, null, 2) : "(no PDF attachment found, or extraction failed)";
  Logger.log(out);
  MailApp.sendEmail(NOTIFY_EMAIL, "FOD Ops Agent — permit PDF test",
    "Message: " + (msg.getSubject() || "") + "\n\n" + out);
}

function testAgent() {
  const checks = [];
  // 1. Job Tread
  try {
    const r = jt_({ organization: { $: { id: ORG_ID }, id: {}, name: {} } });
    checks.push("JT OK: " + (r.organization ? r.organization.name : "??"));
  } catch (e) { checks.push("JT FAIL: " + e); }
  // 2. Anthropic
  try {
    const a = callClaude_("Reply with the single word: ok");
    checks.push("Anthropic OK: " + a.slice(0, 20));
  } catch (e) { checks.push("Anthropic FAIL: " + e); }
  // 3. Gmail
  try { ensureLabels_(); checks.push("Gmail labels OK"); }
  catch (e) { checks.push("Gmail FAIL: " + e); }
  Logger.log(checks.join("\n"));
  MailApp.sendEmail(NOTIFY_EMAIL, "FOD Ops Agent — Test Results", checks.join("\n"));
}

/* ============================ INBOX ============================ */

function processInbox_() {
  // Unread, not already handled
  const threads = GmailApp.search('in:inbox is:unread -label:' + L_DONE + ' -label:' + L_PENDING, 0, 20);
  for (const th of threads) {
    const msgs = th.getMessages();
    const msg = msgs[msgs.length - 1];
    const subj = msg.getSubject() || "";
    const body = msg.getPlainBody() || "";

    // Skip our own question replies (handled in processReplies_)
    if (subj.indexOf("[FOD-Q:") !== -1) continue;

    // Single Claude call: classify AND extract type-specific fields at once.
    let result;
    try { result = classifyAndExtract_(subj, body); }
    catch (e) { flagReview_(th, "Could not classify/parse: " + e); continue; }

    const kind = (result.type || "other").toLowerCase().replace(/[^a-z]/g, "");
    const j = result.data || {};

    try {
      if (kind === "qmerit")       handleQmerit_(th, msg, j);
      else if (kind === "permit")  handlePermit_(th, msg, j);
      else if (kind === "lead")    handleLead_(th, msg, j);
      else                          flagReview_(th, "Unrecognized email type. Please review.");
    } catch (e) {
      flagReview_(th, "Error while processing: " + e);
    }
  }
}

/* ---- combined classification + extraction via Claude (one call) ---- */
function classifyAndExtract_(subj, body) {
  const prompt =
    "You triage and extract data from an email for an electrical contractor's ops inbox (Far Out Design).\n" +
    "Return STRICT JSON only, no prose, with this exact shape:\n" +
    '{"type": "qmerit"|"permit"|"lead"|"other", "data": { ...type-specific fields... }}\n\n' +
    "Type definitions and the fields to put in \"data\" (use null for any missing field):\n" +
    "- qmerit: a Qmerit installation request (mentions Qmerit, a project #, EV charger install).\n" +
    "    data fields: project, name, phone, email, address, quoteDue\n" +
    "- permit: a permit or inspection notification from a municipality/county (Accela, EnerGov, HillsGovHub, etc.).\n" +
    "    data fields: permitNumber, address, status, inspectionType, inspectionDate, inspector, municipality\n" +
    "    IMPORTANT — these emails are usually FORWARDED. IGNORE the forwarder's own signature block\n" +
    "    (a person's name, \"Far Out Design Inc\", a phone number, and a state contractor license such as\n" +
    "    \"EC13016150\" or \"EC13016150/ES12001208\") that sits ABOVE the \"---------- Forwarded message ---------\" line.\n" +
    "    A permitNumber is the ID issued by the municipality/county and looks like \"HC-BTR-26-0325569\" or\n" +
    "    \"COMELE-2026-000796\". A contractor license (EC#####, ES#####, or \"EC#####/ES#####\") is NEVER a\n" +
    "    permit number. If the forwarded content contains no municipal permit number, set permitNumber to null.\n" +
    "- lead: a new customer job request, quote request, or service call from a person/website/platform.\n" +
    "    data fields: name, phone, email, address, jobDescription, jobType\n" +
    "    jobType must be one of: Service Call, Panel Installation, EV Charger, Generator, " +
    "Residential Electrical, Commercial Electrical, Residential Security/AV/Automation, Commercial Security/AV/Automation\n" +
    "- other: anything else. Use \"data\": {}\n\n" +
    "SUBJECT: " + subj + "\n\nBODY:\n" + body.slice(0, 3000) + "\n\nJSON only.";
  const parsed = extractJSON_(callClaude_(prompt));
  if (!parsed || typeof parsed !== "object") throw "Claude returned no usable JSON.";
  if (!parsed.data || typeof parsed.data !== "object") parsed.data = {};
  return parsed;
}

/* ============================ QMERIT ============================ */
function handleQmerit_(th, msg, j) {
  if (!j.project || !j.address || !j.name) {
    return askQuestion_(th, "qmerit-" + (j.project || Date.now()),
      "Qmerit email missing key fields (project/name/address). Extracted: " + JSON.stringify(j) +
      "\n\nReply with the missing info and I'll create it, or reply SKIP.");
  }

  // Dedup: existing location at this address under Qmerit parent?
  const streetPart = (j.address || "").split(",")[0].trim();
  let existing = null;
  if (streetPart.length >= 5) {  // only check when we have a real street, avoids false dup on bare city/zip
    const loc = jt_({ account: { $: { id: QMERIT_PARENT },
      locations: { $: { size: 40, where: { like: [{ field: ["address"] }, { value: "%" + streetPart + "%" }] } },
        nodes: { id: {}, address: {} } } } });
    existing = (loc.account.locations.nodes || []).find(Boolean);
  }
  if (existing) {
    return askQuestion_(th, "qmerit-dup-" + j.project,
      "A location already exists at " + j.address + " under Qmerit E. 2026. " +
      "This may be a duplicate of an existing job. Reply CREATE to make a new job anyway, or SKIP.");
  }

  const created = createJob_({
    parentAccount: QMERIT_PARENT,
    locName: j.name, address: j.address,
    jobName: (j.name + " EVC #" + j.project).slice(0, 30),
    leadType: "EV Charger", rep: "Ben", repMb: MB_BEN, contract: "Pay Upon Completion",
    contactName: j.name, phone: j.phone, email: j.email,
    desc: "Qmerit installation request #" + j.project + ".\nSite: " + j.address +
          "\nQuote due: " + (j.quoteDue || "see email") + " — Custom quote required.\nSubmit via Qmerit App, project #" + j.project + ".",
    comment: "⚡ Qmerit job #" + j.project + " — " + j.name + "\nPhone: " + j.phone + " | Email: " + j.email +
             "\nSite: " + j.address + "\n⚠ QUOTE DUE " + (j.quoteDue || "soon") + " — submit via Qmerit App.",
    todoName: "Submit Qmerit quote #" + j.project + " — " + j.name,
    todoMb: MB_BEN, todoDue: dueDate_(msg.getDate())
  });

  markDone_(th);
  notify_("✅ Created Qmerit Job #" + created.number + " — " + j.name,
    "New Qmerit job created under Qmerit E. 2026.\n\n" +
    "Job #" + created.number + " — " + created.name + "\n" +
    "Customer: " + j.name + " (" + j.phone + ", " + j.email + ")\n" +
    "Site: " + j.address + "\n" +
    "Quote due: " + (j.quoteDue || "see email") + " (Ben todo set for " + dueDate_(msg.getDate()) + ")");
}

/* ============================ PERMIT ============================ */
function handlePermit_(th, msg, j) {
  // Guard: never treat Far Out's own contractor license (pulled from the forwarded
  // signature, e.g. "EC13016150/ES12001208") as a permit number.
  j.permitNumber = sanitizePermitNumber_(j.permitNumber);

  // Fallback: some notices (e.g. Hernando County "Permit Issued") carry no permit
  // number in the email text — it lives only on the attached permit-card PDF. When
  // the body gave us nothing, read the attachment and fill in what's missing.
  let fromPdf = false;
  if (!j.permitNumber) {
    const pdf = readPermitPdf_(msg);
    if (pdf) {
      if (pdf.permitNumber) { j.permitNumber = pdf.permitNumber; fromPdf = true; }
      j.address        = j.address        || pdf.address;
      j.status         = j.status         || pdf.status;
      j.inspectionType = j.inspectionType || pdf.inspectionType;
      j.inspectionDate = j.inspectionDate || pdf.inspectionDate;
      j.inspector      = j.inspector      || pdf.inspector;
      j.municipality   = j.municipality   || pdf.municipality;
    }
  }

  if (!j.permitNumber && !j.address) {
    return flagReview_(th, "Permit email but no permit number or address found (checked the body and any PDF attachments). Review manually.");
  }

  // Match by permit number FIRST (scan recent jobs' permit-number field in JS — no invalid query path)
  let match = null;
  if (j.permitNumber) {
    match = findJobByPermit_(j.permitNumber);
  }

  if (match) {
    // Known permit on a job → auto-update status + customer-facing comment
    updateJobPermit_(match.id, j);
    markDone_(th);
    return notify_("✅ Permit " + j.permitNumber + " → Job #" + match.number,
      "Permit/inspection update applied automatically" + (fromPdf ? " (permit # read from the attached permit card)" : "") + ".\n\n" +
      "Job #" + match.number + " — " + match.name +
      "\nStatus: " + (j.status || j.inspectionType) + "\n" +
      (j.inspectionDate ? "Inspection: " + j.inspectionDate + " " + (j.inspector || "") : ""));
  }

  // No permit-number match → try address, but FLAG (never guess across multiple jobs)
  askQuestion_(th, "permit-" + (j.permitNumber || Date.now()),
    "New permit/inspection received that I can't match to a known permit number:\n\n" +
    "Permit: " + (j.permitNumber || "—") + (fromPdf ? " (from attached card)" : "") +
    "\nAddress: " + (j.address || "—") +
    "\nStatus: " + (j.status || j.inspectionType || "—") +
    (j.inspectionDate ? "\nInspection: " + j.inspectionDate + " " + (j.inspector || "") : "") +
    "\n\nReply with the Job NUMBER to apply it to (e.g. 1853), or SKIP.");
}

/* Read the attached permit-card PDF when the email text has no permit number.
 * Returns extracted permit fields (permitNumber may still be null), or null if
 * there's no readable PDF / extraction fails. Never throws. */
function readPermitPdf_(msg) {
  let attachments;
  try { attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || []; }
  catch (e) { return null; }
  for (const att of attachments) {
    const ctype = (att.getContentType() || "").toLowerCase();
    const nm = (att.getName() || "").toLowerCase();
    if (ctype.indexOf("pdf") === -1 && !nm.endsWith(".pdf")) continue;
    // Anthropic's PDF limit is 32MB per request and base64 inflates size ~33%,
    // so cap the raw file well under that to leave room for the prompt/overhead.
    try { if (att.getSize() > 15 * 1024 * 1024) continue; } catch (e) {} // skip oversized
    let b64;
    try { b64 = Utilities.base64Encode(att.getBytes()); } catch (e) { continue; }
    const prompt =
      "This PDF is a building/electrical permit card for an electrical contractor. " +
      "Extract as STRICT JSON only, no prose: " +
      '{"permitNumber": ..., "address": ..., "status": ..., "inspectionType": ..., ' +
      '"inspectionDate": ..., "inspector": ..., "municipality": ...}. ' +
      "permitNumber is the municipal/county permit number printed on the card " +
      "(e.g. HC-BTR-26-0325569, COMELE-2026-000796) — it is NOT a contractor license " +
      "like EC13016150 or EC13016150/ES12001208. Use null for anything not present. JSON only.";
    let parsed;
    try { parsed = extractJSON_(callClaudePdf_(prompt, b64)); }
    catch (e) { continue; }
    if (parsed && parsed.permitNumber) parsed.permitNumber = sanitizePermitNumber_(parsed.permitNumber);
    if (parsed && (parsed.permitNumber || parsed.address)) return parsed;
  }
  return null;
}

/* ============================ LEAD / INTAKE ============================ */
function handleLead_(th, msg, j) {
  // Freeform leads are risky — require name + (phone or email) + address before auto-creating
  if (!j.name || !j.address || (!j.phone && !j.email)) {
    return askQuestion_(th, "lead-" + Date.now(),
      "New lead received but missing info needed to create a clean record:\n\n" +
      "Name: " + (j.name || "—") + "\nPhone: " + (j.phone || "—") + "\nEmail: " + (j.email || "—") +
      "\nAddress: " + (j.address || "—") + "\nJob: " + (j.jobDescription || "—") +
      "\n\nReply with the missing details and I'll create it, or reply SKIP.");
  }

  const isService = (j.jobType === "Service Call");
  const created = createJob_({
    standalone: true, accountName: j.name, locName: j.name + " Residence", address: j.address,
    jobName: ((j.jobType || "New Lead") + " - " + j.name).slice(0, 30),
    leadType: j.jobType || "Residential Electrical",
    rep: isService ? "Curtice" : "Ben", repMb: isService ? MB_SARAH : MB_BEN,
    contract: isService ? "Pay Upon Completion" : "60 / 40",
    contactName: j.name, phone: j.phone, email: j.email,
    desc: "New lead via ops inbox.\n" + (j.jobDescription || "") + "\nPhone: " + j.phone + " | Email: " + j.email,
    comment: "💡 New lead — " + j.name + "\n" + (j.jobDescription || "") + "\nPhone: " + j.phone + " | Email: " + j.email,
    todoName: (isService ? "Schedule service call — " : "New lead follow up — ") + j.name,
    todoMb: isService ? MB_SARAH : MB_BEN, todoDue: dueDate_(msg.getDate())
  });

  markDone_(th);
  notify_("✅ Created Job #" + created.number + " — " + j.name,
    "New " + (j.jobType || "lead") + " job created.\n\nJob #" + created.number + " — " + created.name +
    "\nCustomer: " + j.name + " (" + j.phone + ", " + j.email + ")\nSite: " + j.address +
    "\nRep: " + (isService ? "Curtice (service)" : "Ben") +
    "\nTodo due: " + dueDate_(msg.getDate()) + (isService ? " (Sarah)" : " (Ben)"));
}

/* ============================ REPLY HANDLER ============================ */
function processReplies_() {
  // Curtice's answers to [FOD-Q: id] question emails come back to ops@ as their
  // OWN thread — the question was sent as a fresh outbound email, so the L_PENDING
  // label on the original inbound thread never sees the reply. Find the reply
  // threads directly by subject instead of by label.
  const threads = GmailApp.search('in:inbox is:unread subject:FOD', 0, 30);
  for (const th of threads) {
    const subj = th.getFirstMessageSubject() || "";
    const m = subj.match(/\[FOD-Q:\s*([^\]]+)\]/);
    if (!m) continue;  // matched "FOD" loosely but isn't one of our question threads

    const msgs = th.getMessages();
    const last = msgs[msgs.length - 1];
    const from = (last.getFrom() || "").toLowerCase();

    // Newest message is still our own outbound question → no reply yet.
    if (from.indexOf(OPS_EMAIL.toLowerCase()) !== -1) continue;
    // Only act on Curtice's reply.
    if (from.indexOf(NOTIFY_EMAIL.toLowerCase()) === -1 && from.indexOf("curtice") === -1) {
      continue;
    }

    const qid = m[1].trim();
    const answer = (last.getPlainBody() || "").trim().split("\n")[0].trim();

    if (/^skip$/i.test(answer)) {
      markDone_(th);
      notify_("↩︎ Skipped: " + qid, "You replied SKIP. No action taken.");
      continue;
    }

    try {
      applyAnswer_(qid, answer, th);
      markDone_(th);
    } catch (e) {
      th.markRead();
      notify_("⚠ Could not apply your reply to " + qid, "Error: " + e + "\nYour answer: " + answer);
    }
  }
}

function applyAnswer_(qid, answer, th) {
  // permit-* : answer is a job number
  if (qid.indexOf("permit-") === 0) {
    const jobNum = answer.replace(/[^0-9]/g, "");
    if (!jobNum) throw "No job number found in reply.";
    const r = jt_({ organization: { $: { id: ORG_ID },
      jobs: { $: { size: 3, where: { "=": [{ field: ["number"] }, { value: jobNum }] } },
        nodes: { id: {}, name: {}, number: {} } } } });
    const job = (r.organization.jobs.nodes || [])[0];
    if (!job) throw "Job #" + jobNum + " not found.";
    // pull the stored permit data from the original question email body
    const body = th.getMessages()[0].getPlainBody();
    const permitNumber = ((body.match(/Permit:\s*([^\n]+)/) || [])[1] || "").trim();
    const status       = ((body.match(/Status:\s*([^\n]+)/) || [])[1] || "").trim();
    updateJobPermit_(job.id, {
      permitNumber: (permitNumber && permitNumber !== "—") ? permitNumber : null,
      status:       (status && status !== "—") ? status : null
    });
    notify_("✅ Applied permit to Job #" + job.number, "Per your reply, permit applied to Job #" + job.number + " — " + job.name + ".");
    return;
  }
  // qmerit-dup-* : answer CREATE
  if (qid.indexOf("qmerit-dup-") === 0) {
    if (/^create$/i.test(answer)) {
      notify_("Noted", "Reply CREATE received. Please re-forward the Qmerit email; I'll create a fresh job now that you've confirmed it's not a duplicate.");
    }
    return;
  }
  // lead-* / qmerit-* missing info : Curtice supplied details — ask him to re-forward for clean creation
  notify_("Got your reply on " + qid, "Thanks — I've noted: " + answer +
    "\nFor records with missing info, please re-forward the original with the details added and I'll create it cleanly.");
}

/* ============================ JOB TREAD HELPERS ============================ */
function createJob_(o) {
  let accountId = o.parentAccount;
  if (o.standalone) {
    const acc = jt_({ createAccount: { $: { name: o.accountName, organizationId: ORG_ID, suffixIfNecessary: true, type: "customer" }, createdAccount: { id: {} } } });
    accountId = acc.createAccount.createdAccount.id;
  }
  const loc = jt_({ createLocation: { $: { accountId: accountId, address: o.address, name: o.locName, parseAddress: true }, createdLocation: { id: {} } } });
  const locId = loc.createLocation.createdLocation.id;
  const job = jt_({ createJob: { $: { locationId: locId, name: o.jobName, customFieldValues: {
    [CF_SALES_STATUS]: "New Lead", [CF_LEAD_TYPE]: o.leadType, [CF_PERMIT_STATUS]: "No Permit Needed",
    [CF_SALES_REP]: o.rep, [CF_CONTRACT]: o.contract }, description: o.desc },
    createdJob: { id: {}, name: {}, number: {} } } });
  const jb = job.createJob.createdJob;
  // contact
  const ct = jt_({ createContact: { $: { accountId: accountId, name: o.contactName, title: "Customer" }, createdContact: { id: {} } } });
  const ctId = ct.createContact.createdContact.id;
  const cfv = {}; if (o.email) cfv[CF_CONTACT_EMAIL] = o.email; if (o.phone) cfv[CF_CONTACT_PHONE] = o.phone;
  if (o.email || o.phone) jt_({ updateContact: { $: { id: ctId, customFieldValues: cfv } } });
  if (o.standalone) jt_({ updateAccount: { $: { id: accountId, primaryContactId: ctId, primaryLocationId: locId } } });
  // ACE link
  if (o.email && o.phone) jt_({ createAce: { $: { targetId: jb.id, targetType: "job", notify: true,
    assignee: { name: o.contactName, emailAddress: o.email, phoneNumber: normPhone_(o.phone) } }, createdAce: { id: {} } } });
  // comment
  jt_({ createComment: { $: { targetId: jb.id, targetType: "job", message: o.comment }, createdComment: { id: {} } } });
  // todo
  jt_({ createTask: { $: { targetId: jb.id, targetType: "job", name: o.todoName, isToDo: true,
    startDate: o.todoDue, endDate: o.todoDue, assignees: [{ membershipId: o.todoMb }],
    description: o.comment }, createdTask: { id: {} } } });
  return jb;
}

function findJobByPermit_(permitNumber) {
  const target = String(permitNumber).trim().toLowerCase();
  // Pull recent open jobs with their permit-number custom field, match in JS.
  const r = jt_({ organization: { $: { id: ORG_ID },
    jobs: { $: { size: 60, sortBy: [{ field: "createdAt", order: "desc" }] },
      nodes: { id: {}, name: {}, number: {},
        customFieldValues: { nodes: { customField: { id: {} }, value: {} } } } } } });
  const jobs = (r.organization.jobs.nodes) || [];
  for (const jb of jobs) {
    const cfs = (jb.customFieldValues && jb.customFieldValues.nodes) || [];
    for (const cf of cfs) {
      if (cf.customField && cf.customField.id === CF_PERMIT_NUM && cf.value &&
          String(cf.value).trim().toLowerCase() === target) {
        return { id: jb.id, name: jb.name, number: jb.number };
      }
    }
  }
  return null;
}

function updateJobPermit_(jobId, j) {
  const cfv = {};
  if (j.status) cfv[CF_PERMIT_STATUS] = mapPermitStatus_(j.status);
  if (j.permitNumber) cfv[CF_PERMIT_NUM] = j.permitNumber;
  if (Object.keys(cfv).length) jt_({ updateJob: { $: { id: jobId, customFieldValues: cfv } } });
  // internal log comment
  jt_({ createComment: { $: { targetId: jobId, targetType: "job",
    message: "📅 Permit/inspection update via ops agent\nPermit: " + (j.permitNumber || "—") +
      "\nStatus: " + (j.status || j.inspectionType || "—") +
      (j.inspectionDate ? "\nInspection: " + j.inspectionDate + " " + (j.inspector || "") + " " + (j.municipality || "") : ""),
    }, createdComment: { id: {} } } });
}

function sanitizePermitNumber_(pn) {
  // Reject values that are actually Far Out's Florida contractor license, which shows up
  // in the forwarded email signature (e.g. "EC13016150" or "EC13016150/ES12001208").
  // Municipal permit numbers never take that shape (they look like HC-BTR-26-0325569,
  // COMELE-2026-000796, etc.), so this only strips false positives.
  if (pn === null || pn === undefined) return null;
  const s = String(pn).trim();
  if (!s) return null;
  if (/^E[CS]\s*\d{5,}(\s*\/\s*E[CS]\s*\d{5,})*$/i.test(s)) return null; // license, alone or EC../ES..
  if (/E[CS]\d{5,}\s*\/\s*E[CS]\d{5,}/i.test(s)) return null;            // license embedded in a longer string
  return s;
}

function mapPermitStatus_(s) {
  s = (s || "").toLowerCase();
  if (s.indexOf("final") !== -1) return "Final Electrical";
  if (s.indexOf("rough") !== -1) return "Rough Inspection";
  if (s.indexOf("pass") !== -1 || s.indexOf("approv") !== -1) return "All Inspections Passed";
  if (s.indexOf("received") !== -1) return "Permit Received";
  if (s.indexOf("applied") !== -1) return "Permit Applied";
  return "Permit Applied";
}

/* ============================ EMAIL / UTIL ============================ */
function askQuestion_(th, qid, question) {
  const subj = "[FOD-Q: " + qid + "] Action needed";
  GmailApp.sendEmail(NOTIFY_EMAIL, subj,
    question + "\n\n--\nReply to THIS email. Put your answer on the first line. " +
    "Keep the [FOD-Q: " + qid + "] tag in the subject so I can match it.\n" +
    "Reply SKIP to take no action.");
  const lab = GmailApp.getUserLabelByName(L_PENDING); if (lab) th.addLabel(lab);
  th.markRead();
}

function notify_(subject, bodyText) {
  GmailApp.sendEmail(NOTIFY_EMAIL, "FOD Ops Agent — " + subject, bodyText);
}

function flagReview_(th, why) {
  const lab = GmailApp.getUserLabelByName(L_REVIEW); if (lab) th.addLabel(lab);
  notify_("Needs review", why + "\n\nSubject: " + th.getFirstMessageSubject());
  th.markRead();
}

function markDone_(th) {
  const lab = GmailApp.getUserLabelByName(L_DONE); if (lab) th.addLabel(lab);
  th.markRead();
}

function ensureLabels_() {
  [L_DONE, L_PENDING, L_REVIEW].forEach(n => { if (!GmailApp.getUserLabelByName(n)) GmailApp.createLabel(n); });
}

function dueDate_(emailDate) {
  // noon rule: before noon -> same day; after noon -> next business day
  const d = new Date(emailDate);
  const tz = "America/New_York";
  const hour = Number(Utilities.formatDate(d, tz, "H"));
  let due = new Date(d);
  if (hour >= 12) due.setDate(due.getDate() + 1);
  // skip weekend
  const dow = Number(Utilities.formatDate(due, tz, "u")); // 6=Sat,7=Sun
  if (dow === 6) due.setDate(due.getDate() + 2);
  else if (dow === 7) due.setDate(due.getDate() + 1);
  return Utilities.formatDate(due, tz, "yyyy-MM-dd");
}

function normPhone_(p) {
  const d = (p || "").replace(/[^0-9]/g, "");
  return d.length === 10 ? "+1" + d : (d.length === 11 ? "+" + d : p);
}

/* ============================ API PLUMBING ============================ */
function jt_(query) {
  const key = PropertiesService.getScriptProperties().getProperty("JT_GRANT_KEY");
  const payload = { query: Object.assign({ $: { grantKey: key } }, query) };
  const res = UrlFetchApp.fetch(JT_URL, { method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true });
  const txt = res.getContentText();
  let json;
  try { json = JSON.parse(txt); }
  catch (e) { throw "JT returned non-JSON (HTTP " + res.getResponseCode() + "): " + txt.slice(0, 300); }
  if (json.errors) throw "JT error: " + JSON.stringify(json.errors);
  return json;
}

function callClaude_(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_KEY");
  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post", contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000,
      messages: [{ role: "user", content: prompt }] }),
    muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (j.error) throw "Anthropic error: " + JSON.stringify(j.error);
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function callClaudePdf_(prompt, pdfBase64) {
  // Same endpoint as callClaude_, but attaches a PDF document block so Claude can
  // read the permit card. PDF input needs no beta header. The document block must
  // come before the text block.
  const key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_KEY");
  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post", contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: prompt }
      ] }] }),
    muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (j.error) throw "Anthropic PDF error: " + JSON.stringify(j.error);
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function extractJSON_(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1));
}
