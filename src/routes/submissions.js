const express = require("express");
const router = express.Router();
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const { addSubmissionJob } = require("../services/queueServices");
const { logger } = require("../config/monitoring");
const { getIO } = require("../sockets");
const codeExecutionService = require("../services/executionService");
// const { submissionLimiter } = require("../middleware/rateLimiter");

async function getValidInvitation(token) {
  if (!token) {
    return {
      error: { status: 401, body: { error: "Missing invitation token." } },
    };
  }

  const invitation = await prisma.invitation.findUnique({ where: { token } });

  if (!invitation) {
    return {
      error: { status: 403, body: { error: "Invalid invitation token." } },
    };
  }
  if (invitation.status === "REVOKED") {
    return {
      error: {
        status: 410,
        body: { error: "This assessment link has been revoked." },
      },
    };
  }
  if (new Date() > invitation.expiresAt) {
    return {
      error: {
        status: 410,
        body: { error: "This assessment link has expired." },
      },
    };
  }
  if (invitation.completedAt) {
    return {
      error: {
        status: 409,
        body: { error: "This assessment has already been submitted." },
      },
    };
  }

  return { invitation };
}

router.post("/", async (req, res) => {
  try {
    const {
      questionId,
      code,
      language = "javascript",
      isFinal = false,
      token,
    } = req.body;

    if (!questionId || !code) {
      return res.status(400).json({
        error: "Missing required fields: questionId, code",
      });
    }

    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    const assessmentId = invitation.assessmentId; // derived from token, not the body

    const maxCodeSize = parseInt(process.env.MAX_CODE_SIZE) || 1048576; // 1MB
    if (Buffer.byteLength(code, "utf8") > maxCodeSize) {
      return res.status(413).json({
        error: `Code size exceeds limit of ${maxCodeSize} bytes`,
      });
    }

    const allowedLanguages = (
      process.env.ALLOWED_LANGUAGES || "javascript,python"
    ).split(",");
    if (!allowedLanguages.includes(language)) {
      return res.status(400).json({
        error: `Language ${language} not supported. Allowed: ${allowedLanguages.join(", ")}`,
      });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        questions: {
          where: { id: questionId },
          include: { testCases: { orderBy: { order: "asc" } } },
        },
      },
    });

    if (!assessment || assessment.questions.length === 0) {
      return res
        .status(404)
        .json({ error: "Question not found on this assessment." });
    }

    const question = assessment.questions[0];

    // Prevents duplicate PENDING/RUNNING submissions AND the race condition
    // between two rapid requests, by upserting inside a transaction.
    const submission = await prisma.$transaction(async (tx) => {
      const existing = await tx.submission.findFirst({
        where: {
          invitationId: invitation.id,
          questionId,
          status: { in: ["PENDING", "RUNNING"] },
        },
      });

      if (existing) {
        return { existing, created: null };
      }

      const priorAttempt = await tx.submission.findFirst({
        where: { invitationId: invitation.id, questionId },
      });

      if (priorAttempt) {
        const updated = await tx.submission.update({
          where: { id: priorAttempt.id },
          data: {
            code,
            language,
            status: "PENDING",
            isFinal: Boolean(isFinal),
            results: null,
            passed: null,
            failed: null,
            executionTime: null,
            memoryUsed: null,
            // createdAt intentionally left untouched — preserves first-attempt timestamp
          },
        });
        return { existing: null, created: updated };
      }

      const created = await tx.submission.create({
        data: {
          invitationId: invitation.id,
          assessmentId,
          questionId,
          code,
          language,
          status: "PENDING",
          isFinal: Boolean(isFinal),
        },
      });
      return { existing: null, created };
    });

    if (submission.existing) {
      return res.status(409).json({
        error: "You already have a submission in progress for this question.",
        submissionId: submission.existing.id,
        status: submission.existing.status,
      });
    }

    const result = submission.created;

    logger.info(
      `Submission created: ${result.id} for invitation ${invitation.id}`,
    );

    const io = getIO();
    io.to(`assessment-${assessmentId}`).emit("submission:created", {
      submissionId: result.id,
      questionId,
      timestamp: new Date().toISOString(),
    });

    const job = await addSubmissionJob({
      submissionId: result.id,
      code,
      language,
      questionId,
      assessmentId,
      testCases: question.testCases,
    });

    res.status(202).json({
      message: "Submission accepted and queued for execution",
      submissionId: result.id,
      queuePosition: job.queuePosition || 0,
      status: "PENDING",
    });
  } catch (error) {
    logger.error("Submission error:", error);
    res.status(500).json({
      error: "Failed to submit code",
      message:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// POST /submissions/test  (practice run — visible test cases only, no Submission row)
router.post("/test", async (req, res) => {
  try {
    const { token, questionId, code, language = "javascript" } = req.body;

    if (!code || !questionId) {
      return res
        .status(400)
        .json({ error: "code and questionId are required." });
    }

    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    const maxCodeSize = parseInt(process.env.MAX_CODE_SIZE) || 1048576;
    if (Buffer.byteLength(code, "utf8") > maxCodeSize) {
      return res.status(413).json({
        error: `Code size exceeds limit of ${maxCodeSize} bytes`,
      });
    }

    const allowedLanguages = (
      process.env.ALLOWED_LANGUAGES || "javascript,python"
    ).split(",");
    if (!allowedLanguages.includes(language)) {
      return res
        .status(400)
        .json({ error: `Language ${language} not supported` });
    }

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: {
        testCases: { where: { isHidden: false }, orderBy: { order: "asc" } },
      },
    });

    if (!question || question.assessmentId !== invitation.assessmentId) {
      return res
        .status(404)
        .json({ error: "Question not found on this assessment." });
    }

    if (question.testCases.length === 0) {
      return res
        .status(400)
        .json({ error: "No visible test cases available to run against." });
    }

    const results = await codeExecutionService.executeCode({
      code,
      language,
      testCases: question.testCases.map((tc) => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      })),
    });

    res.json({
      results,
      summary: {
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        total: results.length,
      },
    });
  } catch (error) {
    logger.error("Code test error:", error);
    res.status(500).json({
      error: "Failed to test code",
      message:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

module.exports = router;
