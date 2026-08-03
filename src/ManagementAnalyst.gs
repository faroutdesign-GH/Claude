/***********************************************************************
 * FAR OUT DESIGN — MANAGEMENT ANALYST (weekly senior-employee review)
 * Runs weekly. Emails curtice@ a report on internal members in a
 * "senior" role (Admin, Project Manager by default — edit
 * SENIOR_ROLE_NAMES below to add more), covering:
 *
 *   1. Missed deadlines/commitments — to-dos assigned to a senior member
 *      whose due date has passed without being marked complete.
 *   2. Process deviations — open sales opportunities (JobTread "Sales
 *      Status" not yet "Project Awarded") whose Follow Up Date has
 *      passed, attributed to the senior member listed as Sales Rep.
 *
 * Read-only: this never writes to JobTread, it only emails a report.
 * Shares JT_GRANT_KEY / jt_() / ORG_ID / NOTIFY_EMAIL with
 * FarOutOpsAgent.gs (same Apps Script project, same globals).
 *
 * SETUP (one time):
 *   Run setupWeeklyAnalystTrigger once, approve permissions if asked.
 *   Run testWeeklyAnalystReport to confirm it emails a report now.
 *
 * VERIFICATION NOTE: the JobTread query shapes below (membership role
 * lookup, assignedTasks overdue filter, custom-field-by-id lookup for
 * Sales Status / Sales Rep / Follow Up Date) were each verified against
 * the live JobTread API for this organization — confirmed real overdue
 * to-dos and real stale sales follow-ups came back. The script itself
 * has not yet been run inside Apps Script — run testWeeklyAnalystReport
 * once and confirm the email looks right before trusting the weekly
 * trigger.
 ***********************************************************************/

const SENIOR_ROLE_NAMES = ["Admin", "Project Manager"]; // edit to add more senior roles
const CF_FOLLOWUP_DATE = "22PG9xqukFkP"; // "Follow Up Date" custom field on job
const ANALYST_TZ = "America/New_York";

/* ============================ ENTRY POINTS ============================ */

function runWeeklyAnalystReport() {
  const today = Utilities.formatDate(new Date(), ANALYST_TZ, "yyyy-MM-dd");
  const seniors = getSeniorMemberships_();
  if (!seniors.length) {
    notifyAnalyst_("no senior members found",
      "Checked roles: " + SENIOR_ROLE_NAMES.join(", ") + ". Nothing to report.");
    return;
  }

  const missedDeadlines = getMissedDeadlines_(seniors, today);
  const processDeviations = getProcessDeviations_(seniors, today);
  notifyAnalyst_(today, formatReport_(seniors, missedDeadlines, processDeviations, today));
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
// "Curtice Jarvis"; the "Sales Rep" custom field just says "Ben"/"Curtice".
function firstName_(fullName) {
  return (fullName || "").split(/[\s-]/)[0].trim();
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

function getProcessDeviations_(seniors, today) {
  const byFirstName = {};
  seniors.forEach(function (m) { byFirstName[m.firstName.toLowerCase()] = m.name; });

  const res = jt_({ organization: { $: { id: ORG_ID },
    jobs: { $: { size: 200, where: ["closedOn", "=", null] },
      nodes: {
        id: {}, name: {}, number: {},
        salesStatus: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_SALES_STATUS }] } },
          nodes: { value: {} } },
        salesRep: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_SALES_REP }] } },
          nodes: { value: {} } },
        followUp: { _: "customFieldValues",
          $: { where: { "=": [{ field: ["customField", "id"] }, { value: CF_FOLLOWUP_DATE }] } },
          nodes: { dateValue: {} } }
      } } } });

  const items = [];
  (res.organization.jobs.nodes || []).forEach(function (j) {
    const status = j.salesStatus.nodes.length ? j.salesStatus.nodes[0].value : null;
    const rep = j.salesRep.nodes.length ? j.salesRep.nodes[0].value : null;
    const followUp = j.followUp.nodes.length ? j.followUp.nodes[0].dateValue : null;
    // Skip: no status, deal already awarded, no follow-up date set, follow-up not yet due.
    if (!status || status === "Project Awarded" || !followUp || followUp >= today || !rep) return;
    const employee = byFirstName[rep.toLowerCase()];
    if (!employee) return; // Sales Rep value doesn't match a current senior member — nothing to attribute
    items.push({
      employee: employee,
      job: j.name + (j.number ? " (#" + j.number + ")" : ""),
      status: status,
      followUpDate: followUp,
      daysOverdue: daysBetween_(followUp, today)
    });
  });
  items.sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });
  return items;
}

function daysBetween_(earlierDate, laterDate) {
  return Math.round((new Date(laterDate) - new Date(earlierDate)) / 86400000);
}

/* ============================ REPORT ============================ */

function formatReport_(seniors, missedDeadlines, processDeviations, today) {
  const lines = [];
  lines.push("Weekly Management Review — " + today);
  lines.push("Senior roles checked: " + SENIOR_ROLE_NAMES.join(", "));
  lines.push("Employees: " + seniors.map(function (s) { return s.name; }).join(", "));
  lines.push("");
  lines.push("== Missed deadlines/commitments (" + missedDeadlines.length + ") ==");
  if (!missedDeadlines.length) lines.push("None.");
  missedDeadlines.forEach(function (i) {
    lines.push("- " + i.employee + ": \"" + i.task + "\" on " + i.job +
      " — due " + i.dueDate + " (" + i.daysOverdue + " days overdue)");
  });
  lines.push("");
  lines.push("== Process deviations — follow-up missed on an open opportunity (" +
    processDeviations.length + ") ==");
  if (!processDeviations.length) lines.push("None.");
  processDeviations.forEach(function (i) {
    lines.push("- " + i.employee + ": " + i.job + " — status \"" + i.status +
      "\", follow-up was due " + i.followUpDate + " (" + i.daysOverdue + " days overdue)");
  });
  lines.push("");
  lines.push("This report only reads JobTread data — it never edits jobs or tasks.");
  lines.push("Definitions live in src/ManagementAnalyst.gs (SENIOR_ROLE_NAMES, the two check functions).");
  return lines.join("\n");
}

function notifyAnalyst_(label, bodyText) {
  MailApp.sendEmail(NOTIFY_EMAIL, "FOD Management Analyst — " + label, bodyText);
}
