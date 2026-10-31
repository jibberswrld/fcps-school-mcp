import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callTool, validateToolCall } from "../src/fcps.js";

// Trimmed copies of the StudentVUE Course History and Documents markup, with made-up data.
const HISTORY = `<script>PXP.AGU = 0;
PXP.CourseHistory = [{"Grade":"09","GradeLevelOrder":13,"Terms":[{"SchoolName":"Example High","Year":"2026","TermName":"S1","TermOrder":30,
"Courses":[{"CourseID":"111","CourseTitle":"Biology; Honors","CreditsAttempted":"0.50","CreditsCompleted":"0.50","VerifiedCredit":"","Mark":"A-","CHSType":"High"}]}]}];
</script>
<h1><span>Graduation Status</span> <span class="class-of">Class of 2030</span></h1>
<h4>&nbsp;Diploma Type</h4><h6 style="x">Advanced Studies Diploma</h6>
<table class="table pres-table"><thead><tr><th scope="col"> Subject Area </th><th colspan="3">Progress</th></tr></thead></table>
<table class="table table-striped"><thead><tr><th scope="col">Subject Area</th><th scope="col">Required</th><th scope="col">Completed</th><th scope="col">In Progress</th><th scope="col" colspan="2">Remaining</th></tr></thead>
<tbody><tr data-guid="A"><th scope="row">English 9</th><td>1.00</td><td>1.00</td><td>0.00</td><td>0.00</td><td> </td></tr>
<tr data-guid="B"><th scope="row">Science</th><td>3.00</td><td>0.50</td><td>1.00</td><td>1.50</td><td> </td></tr></tbody>
<tfoot><tr><td>Total</td><td>4.00</td><td>1.50</td><td>1.00</td><td>1.50</td><td>&nbsp;</td></tr></tfoot></table>
<div class="test-req-container"><ul><li data-status="Passed" data-action="x"><div class="overview"><span class="title">CPR/AED FA Exam</span></div>
<div class="details"><div class="performance-group"><span class="score"></span><span class="performance-level">Pass</span></div>
<span class="date"> <span class="sr-only">taken on</span> 04/24/2026 </span> </div></li></ul></div>
<div class="chs-gpa-summary"><div class="gpa"> <h2>Cumulative</h2> <span class="gpa-score">3.900</span></div></div>`;

const DOCUMENTS = `<script>$('#grid').dxDataGrid({"columns":[{"lookup":{"dataSource":[{"Value":"Report Card","Desc":"Report Card"}]}}],
"dataSource":[{"DocumentUploadDate":"06/18/2026","DocumentTitle":"<a target=\\"_blank\\" href=\\"PXP_ShowDocument.aspx?AGU=&docToken=abc123\\">Final_2025-26_ExampleHS</a>","DocumentCategory":"Report Card"}]});</script>`;

test.before(async () => {
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "fcps-history-test-"));
  process.env.SCHOOLOGY_USERNAME = "1234567";
  process.env.SCHOOLOGY_PASSWORD = ["not", "a", "real", "password"].join("-");
});

function stubStudentVue(pdf) {
  const requested = [];
  globalThis.fetch = async (url) => {
    const { pathname, search } = new URL(url);
    requested.push(pathname + search);
    if (pathname.endsWith("/PXP2_CourseHistory.aspx")) return new Response(HISTORY, { status: 200 });
    if (pathname.endsWith("/PXP2_Documents.aspx")) return new Response(DOCUMENTS, { status: 200 });
    if (pathname.endsWith("/PXP_ShowDocument.aspx")) return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
    return new Response("unexpected", { status: 500 });
  };
  return requested;
}

test("course history returns past courses, GPA, credits, and test requirements", async () => {
  const originalFetch = globalThis.fetch;
  stubStudentVue();
  try {
    const result = JSON.parse((await callTool("studentvue_get_course_history"))[0].text);
    assert.equal(result.classOf, "2030");
    assert.equal(result.diplomaType, "Advanced Studies Diploma");
    assert.deepEqual(result.gpa, [{ type: "Cumulative", value: 3.9 }]);
    assert.deepEqual(result.credits[1], { subjectArea: "Science", required: 3, completed: 0.5, inProgress: 1, remaining: 1.5 });
    assert.deepEqual(result.creditTotals, { required: 4, completed: 1.5, inProgress: 1, remaining: 1.5 });
    assert.deepEqual(result.testRequirements, [{ test: "CPR/AED FA Exam", status: "Passed", result: "Pass", date: "04/24/2026" }]);
    assert.deepEqual(result.history[0].terms[0].courses[0], { courseId: "111", title: "Biology; Honors", mark: "A-", creditsAttempted: 0.5, creditsCompleted: 0.5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("documents are listed with stable ids and read through the per-login link", async () => {
  const originalFetch = globalThis.fetch;
  const requested = stubStudentVue("not a pdf");
  try {
    const [doc] = JSON.parse((await callTool("studentvue_list_documents"))[0].text);
    assert.equal(doc.title, "Final_2025-26_ExampleHS");
    assert.equal(doc.category, "Report Card");
    assert.match(doc.documentId, /^[0-9a-f]{16}$/);
    assert.equal(doc.url, undefined, "the per-login token link stays internal");
    await assert.rejects(callTool("studentvue_read_document", { documentId: doc.documentId }));
    assert.ok(requested.includes("/svue/PXP_ShowDocument.aspx?AGU=&docToken=abc123"));
    await assert.rejects(callTool("studentvue_read_document", { documentId: "0000000000000000" }), /studentvue_list_documents/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("studentvue_read_document validates its arguments", () => {
  assert.throws(() => validateToolCall("studentvue_read_document", { documentId: "../x" }), /16-character/);
  assert.throws(() => validateToolCall("studentvue_read_document", { documentId: "0123456789abcdef", pageCount: 9 }), /pageCount/);
  assert.deepEqual(validateToolCall("studentvue_read_document", { documentId: "0123456789abcdef" }), { documentId: "0123456789abcdef", startPage: 1, pageCount: 3, includeImages: true });
});
