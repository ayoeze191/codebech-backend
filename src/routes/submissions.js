const express = require("express");
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const { addSubmissionJob } = require("../services/queueServices");
const { logger } = require("../config/monitoring");
const { getIO } = require("../socket");
const codeExecutionService = require("../services/executionService");

const router = express.Router();
const allowedLanguages = () => (process.env.ALLOWED_LANGUAGES || "javascript,python").split(",").map((x) => x.trim());

async function getValidInvitation(token) {
  if (!token) return { error: { status: 401, body: { error: "Invitation token is required." } } };
  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) return { error: { status: 404, body: { error: "Invitation not found." } } };
  if (invitation.status === "REVOKED" || new Date() > invitation.expiresAt || invitation.completedAt) {
    return { error: { status: 410, body: { error: "This assessment is no longer available." } } };
  }
  return { invitation };
}

function validateCode(code, language) {
  if (typeof code !== "string" || !code.trim()) return "Code is required.";
  if (Buffer.byteLength(code, "utf8") > (Number(process.env.MAX_CODE_SIZE) || 1048576)) return "Code exceeds the size limit.";
  if (!allowedLanguages().includes(language)) return `Language ${language} not supported.`;
  return null;
}

router.post("/", async (req, res) => {
  try {
    const { token, questionId, code, language = "javascript", isFinal = false } = req.body;
    const validationError = validateCode(code, language);
    if (!questionId || validationError) return res.status(400).json({ error: !questionId ? "questionId is required." : validationError });
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);
    const question = await prisma.question.findFirst({ where: { id: questionId, assessmentId: invitation.assessmentId }, include: { testCases: { orderBy: { order: "asc" } } } });
    if (!question) return res.status(404).json({ error: "Question not found on this assessment." });

    const submission = await prisma.$transaction(async (tx) => {
      const existing = await tx.submission.findFirst({ where: { invitationId: invitation.id, questionId } });
      if (existing && ["PENDING", "RUNNING"].includes(existing.status)) {
        return { existing };
      }
      return existing
        ? { submission: await tx.submission.update({ where: { id: existing.id }, data: { code, language, status: "PENDING", isFinal: Boolean(isFinal), results: null, passed: null, failed: null, executionTime: null, memoryUsed: null } }) }
        : { submission: await tx.submission.create({ data: { invitationId: invitation.id, assessmentId: invitation.assessmentId, questionId, code, language, status: "PENDING", isFinal: Boolean(isFinal) } }) };
    });
    if (submission.existing) {
      return res.status(409).json({ error: "A submission for this question is already being executed.", submissionId: submission.existing.id, status: submission.existing.status });
    }
    const createdSubmission = submission.submission;
    const job = await addSubmissionJob({ submissionId: createdSubmission.id, code, language, questionId, assessmentId: invitation.assessmentId });
    try { getIO().to(`assessment-${invitation.assessmentId}`).emit("submission:created", { submissionId: createdSubmission.id, questionId, invitationId: invitation.id }); } catch {}
    res.status(202).json({ message: "Submission accepted and queued for execution", submissionId: createdSubmission.id, queuePosition: typeof job.queuePosition === "function" ? await job.queuePosition() : 0, status: "PENDING" });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ error: "A submission for this question is already being executed." });
    logger.error("Submission error:", error);
    res.status(500).json({ error: "Failed to submit code" });
  }
});

router.post("/test", async (req, res) => {
  try {
    const { token, questionId, code, language = "javascript" } = req.body;
    const validationError = validateCode(code, language);
    if (!questionId || validationError) return res.status(400).json({ error: !questionId ? "questionId is required." : validationError });
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);
    const question = await prisma.question.findFirst({ where: { id: questionId, assessmentId: invitation.assessmentId }, include: { testCases: { where: { isHidden: false }, orderBy: { order: "asc" } } } });
    if (!question) return res.status(404).json({ error: "Question not found on this assessment." });
    const execution = await codeExecutionService.executeCode({ code, language, testCases: question.testCases });
    const results = Array.isArray(execution) ? execution : execution.results || [];
    res.json({ results, summary: { passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, total: results.length } });
  } catch (error) {
    logger.error("Code test error:", error);
    res.status(500).json({ error: "Failed to test code" });
  }
});

router.get("/assessment/:assessmentId", authMiddleware, roleMiddleware(["RECRUITER", "ADMIN"]), async (req, res) => {
  try {
    const assessment = await prisma.assessment.findUnique({ where: { id: req.params.assessmentId }, select: { createdBy: true } });
    if (!assessment) return res.status(404).json({ error: "Assessment not found." });
    if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    const data = await prisma.submission.findMany({ where: { assessmentId: req.params.assessmentId }, include: { question: { select: { id: true, title: true, difficulty: true, points: true } }, invitation: { select: { id: true, email: true } } }, orderBy: { createdAt: "desc" } });
    res.json({ data: data.map(({ invitation, ...submission }) => ({ ...submission, candidate: { id: invitation.id, name: invitation.email.split("@")[0], email: invitation.email } })) });
  } catch (error) { res.status(500).json({ error: "Failed to fetch submissions." }); }
});

module.exports = router;
