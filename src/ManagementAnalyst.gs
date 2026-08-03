/***********************************************************************
 * FAR OUT DESIGN — MANAGEMENT ANALYST (weekly senior-employee review)
 * Runs weekly. Emails curtice@ a report on internal members in a
 * "senior" role (Admin, Project Manager, Team Lead — edit
 * SENIOR_ROLE_NAMES below to add more), covering:
 *
 *   1. New leads not moved past "New Lead" within 48 hours of creation.
 *   2. Jobs with a scheduled (non-"on site") task that don't have an
 *      approved Contract/Agreement on file, or — for jobs $1000+ — an
 *      approved deposit/draw/progress invoice on file.
 *   3. Missed deadlines/commitments — to-dos assigned to a senior member
 *      whose due date has passed without being marked complete.
 *
 * Read-only: this never writes to JobTread, it only emails a report.
 * Shares JT_GRANT_KEY / jt_() / ORG_ID / NOTIFY_EMAIL / CF_SALES_STATUS /
 * CF_SALES_REP with FarOutOpsAgent.gs (same Apps Script project, same
 * globals).
 *
 * SETUP (one time):
 *   Run setupWeeklyAnalystTrigger once, approve permissions if asked.
 *   Run testWeeklyAnalystReport to confirm it emails a report now.
 *
 * DEFINITIONS, per Curtice (2026-08-03 review):
 *   - 48-hour clock is strict wall-clock hours, not business hours.
 *   - "Scheduled" = any task with a start date whose name doesn't
 *     contain "on site" (an "on site" task is just the estimate visit).
 *   - Every job requires a signed contract, including service calls —
 *     no price-based exception. Only the deposit is exempt under $1000.
 *   - A Change Order is only ever used after a contract is signed, so an
 *     approved Change Order with no approved Contract/Agreement behind
 *     it is itself a deviation, not proof a contract exists.
 *   - Deposit/draw/progress payment is verified against an approved
 *     invoice document, not the "Accounting Work Flow" custom field —
 *     that field was confirmed stale on real jobs during this review.
 *
 * VERIFICATION NOTE: every query shape below (membership role lookup,
 * assignedTasks overdue filter, custom-field-by-id lookup for Sales
 * Status/Sales Rep, document type/status/name checks, New Lead age)
 * was verified against the live JobTread API for this organization —
 * confirmed real overdue to-dos and two real scheduled-without-contract
 * jobs (A/V upgrade #1863, Bathroom Circuit #1995) came back correctly.
 * The script itself has not yet been run inside Apps Script — run
 * testWeeklyAnalystReport once and confirm the email looks right before
 * trusting the weekly trigger.
 ***********************************************************************/

const SENIOR_ROLE_NAMES = ["Admin", "Project Manager", "Team Lead"]; // edit to add more senior roles
const ANALYST_TZ = "America/New_York";
const NEW_LEAD_STATUS = "New Lead";
const NEW_LEAD_HOURS_THRESHOLD = 48;
const DEPOSIT_REQUIRED_AT_PRICE = 1000;
const SCHEDULE_WINDOW_DAYS_BACK = 7;  // how far back to check already-scheduled work
const SCHEDULE_WINDOW_DAYS_FWD = 14;  // how far ahead to check upcoming schedule

/* ============================ ENTRY POINTS ============================ */

function runWeeklyAnalystReport() {
  const now = new Date();
  const today = Utilities.formatDate(now, ANALYST_TZ, "yyyy-MM-dd");
  const seniors = getSeniorMemberships_();
  if (!seniors.length) {
    notifyAnalyst_("no senior members found",
      "Checked roles: " + SENIOR_ROLE_NAMES.join(", ") + ". Nothing to report.");
    return;
  }

  const newLeadViolations = getNewLeadViolations_(seniors, now.getTime());
  const scheduleViolations = getScheduleComplianceViolations_(seniors, today);
  const missedDeadlines = getMissedDeadlines_(seniors, today);
  notifyAnalyst_(today, formatReport_(seniors, newLeadViolations, scheduleViolations, missedDeadlines, today));
}

function setupWeeklyAnalystTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "runWeeklyAnalystReport"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("runWeeklyAnalystReport")
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  Logger.log("Trigger installed: runWeeklyAnalystReport every Monday ~7am.");
}

// Read-only — safe to run any time to preview the report by email.
function testWeeklyAnalystReport() {
  runWeeklyAnalystReport();
}

/* ============================ DATA ============================ */

function getSeniorMemberships_() {
  const res = jt_({ organization: { $: { id: ORG_ID },
    memberships: { $: { size: 100, where: ["isInternal", true] },
      nodes: { id: {}, user: { name: {} }, role: { name: {} } } } } });
  return res.organization.memberships.nodes
    .filter(function (m) { return m.role && SENIOR_ROLE_NAMES.indexOf(m.role.name) !== -1; })
    .map(function (m) {
      return { id: m.id, name: m.user.name, firstName: firstName_(m.user.name), roleName: m.role.name };
    });
}

// JobTread membership names here look like "Ben- Project Manager" or
// "Curtice Jarvis"; the "Sales Rep" custom field just says "Ben"/"Curtice"/"Derek".
function firstName_(fullName) {
  return (fullName || "").split(/[\s-]/)[0].trim();
}

function seniorsByFirstName_(seniors) {
  const map = {};
  seniors.forEach(function (m) { map[m.firstName.toLowerCase()] = m.name; });
  return map;
}

// Attributes a "Sales Rep" custom-field value to a senior member's display
// name, or labels it clearly when it doesn't match one of the three
// checked roles — never silently drops an unattributed violation.
function attributeToSenior_(byFirstName, rep) {
  if (!rep) return "(no Sales Rep set)";
  return byFirstName[rep.toLowerCase()] || (rep + " (not a current senior member)");
}

function getNewLeadViolations_(seniors, nowMs) {
  const byFirstName = seniorsByFirstName_(seniors);
  const res = jt_({ organization: { $: { id: ORG_ID },
    jobs: { $: { size: 100, where: ["closedOn", "=", null] },
      nodes: {
        id: {}, name: {}, number: {}, createdAt: {},
        salesStatus: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_SALES_STATUS }] } },
          nodes: { value: {} } },
        salesRep: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_SALES_REP }] } },
          nodes: { value: {} } }
      } } } });

  const items = [];
  (res.organization.jobs.nodes || []).forEach(function (j) {
    const status = j.salesStatus.nodes.length ? j.salesStatus.nodes[0].value : null;
    if (status !== NEW_LEAD_STATUS) return;
    const hoursOld = (nowMs - new Date(j.createdAt).getTime()) / 3600000;
    if (hoursOld < NEW_LEAD_HOURS_THRESHOLD) return;
    const rep = j.salesRep.nodes.length ? j.salesRep.nodes[0].value : null;
    items.push({
      employee: attributeToSenior_(byFirstName, rep),
      job: j.name + (j.number ? " (#" + j.number + ")" : ""),
      createdAt: j.createdAt,
      hoursOld: Math.round(hoursOld)
    });
  });
  items.sort(function (a, b) { return b.hoursOld - a.hoursOld; });
  return items;
}

function getScheduleComplianceViolations_(seniors, today) {
  const byFirstName = seniorsByFirstName_(seniors);
  const from = shiftDate_(today, -SCHEDULE_WINDOW_DAYS_BACK);
  const to = shiftDate_(today, SCHEDULE_WINDOW_DAYS_FWD);

  const res = jt_({ organization: { $: { id: ORG_ID },
    tasks: { $: { size: 100, where: { and: [
      ["isToDo", false],
      { ">=": [{ field: ["startDate"] }, { value: from }] },
      { "<=": [{ field: ["startDate"] }, { value: to }] }
    ] } },
    nodes: {
      id: {}, name: {}, startDate: {},
      job: {
        id: {}, name: {}, number: {}, closedOn: {}, projectedPrice: {},
        salesRep: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_SALES_REP }] } },
          nodes: { value: {} } },
        documents: { $: { size: 50 }, nodes: { name: {}, type: {}, status: {} } }
      }
    } } } });

  const seenJobs = {};
  const items = [];
  (res.organization.tasks.nodes || []).forEach(function (t) {
    if (!t.job || t.job.closedOn) return;
    if (/on site/i.test(t.name)) return;
    if (seenJobs[t.job.id]) return; // one flag per job even if several tasks are scheduled
    seenJobs[t.job.id] = true;

    const docs = t.job.documents.nodes || [];
    const hasContract = docs.some(function (d) {
      return d.type === "customerOrder" && d.status === "approved" && /contract|agreement/i.test(d.name);
    });
    const hasOnlyChangeOrder = !hasContract && docs.some(function (d) {
      return d.type === "customerOrder" && d.status === "approved" && /change order/i.test(d.name);
    });
    const needsDeposit = (t.job.projectedPrice || 0) >= DEPOSIT_REQUIRED_AT_PRICE;
    const hasDeposit = docs.some(function (d) {
      return d.type === "customerInvoice" && d.status === "approved" && /deposit|draw|progress/i.test(d.name);
    });

    const problems = [];
    if (!hasContract) {
      problems.push("no signed Contract/Agreement on file" +
        (hasOnlyChangeOrder ? " (only an approved Change Order found — a Change Order requires a signed contract to already exist)" : ""));
    }
    if (hasContract && needsDeposit && !hasDeposit) {
      problems.push("no approved deposit/draw/progress invoice on file");
    }
    if (!problems.length) return;

    const rep = t.job.salesRep.nodes.length ? t.job.salesRep.nodes[0].value : null;
    items.push({
      employee: attributeToSenior_(byFirstName, rep),
      job: t.job.name + (t.job.number ? " (#" + t.job.number + ")" : ""),
      scheduledOn: t.startDate,
      issue: problems.join("; ")
    });
  });
  return items;
}

function getMissedDeadlines_(seniors, today) {
  const items = [];
  seniors.forEach(function (m) {
    const res = jt_({ membership: { $: { id: m.id },
      assignedTasks: { $: { size: 100, where: { and: [
        ["isToDo", true], ["completed", "=", 0],
        { "<": [{ field: ["endDate"] }, { value: today }] }
      ] } },
      nodes: { id: {}, name: {}, endDate: {}, job: { name: {}, number: {} } } } } });
    (res.membership.assignedTasks.nodes || []).forEach(function (t) {
      items.push({
        employee: m.name,
        task: t.name,
        dueDate: t.endDate,
        daysOverdue: daysBetween_(t.endDate, today),
        job: t.job ? (t.job.name + (t.job.number ? " (#" + t.job.number + ")" : "")) : "(no job)"
      });
    });
  });
  items.sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });
  return items;
}

function daysBetween_(earlierDate, laterDate) {
  return Math.round((new Date(laterDate) - new Date(earlierDate)) / 86400000);
}

function shiftDate_(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, ANALYST_TZ, "yyyy-MM-dd");
}

/* ============================ REPORT ============================ */

function formatReport_(seniors, newLeadViolations, scheduleViolations, missedDeadlines, today) {
  const lines = [];
  lines.push("Weekly Management Review — " + today);
  lines.push("Senior roles checked: " + SENIOR_ROLE_NAMES.join(", "));
  lines.push("Employees: " + seniors.map(function (s) { return s.name; }).join(", "));
  lines.push("");
  lines.push("== New leads not moved past \"New Lead\" within 48 hours (" + newLeadViolations.length + ") ==");
  if (!newLeadViolations.length) lines.push("None.");
  newLeadViolations.forEach(function (i) {
    lines.push("- " + i.employee + ": " + i.job + " — created " + i.createdAt +
      " (" + i.hoursOld + " hours old, still New Lead)");
  });
  lines.push("");
  lines.push("== Scheduled without a signed contract / required deposit (" + scheduleViolations.length + ") ==");
  if (!scheduleViolations.length) lines.push("None.");
  scheduleViolations.forEach(function (i) {
    lines.push("- " + i.employee + ": " + i.job + " — scheduled " + i.scheduledOn + " — " + i.issue);
  });
  lines.push("");
  lines.push("== Missed deadlines/commitments (" + missedDeadlines.length + ") ==");
  if (!missedDeadlines.length) lines.push("None.");
  missedDeadlines.forEach(function (i) {
    lines.push("- " + i.employee + ": \"" + i.task + "\" on " + i.job +
      " — due " + i.dueDate + " (" + i.daysOverdue + " days overdue)");
  });
  lines.push("");
  lines.push("This report only reads JobTread data — it never edits jobs, tasks, or documents.");
  lines.push("Definitions live in src/ManagementAnalyst.gs.");
  return lines.join("\n");
}

function notifyAnalyst_(label, bodyText) {
  MailApp.sendEmail(NOTIFY_EMAIL, "FOD Management Analyst — " + label, bodyText);
}
