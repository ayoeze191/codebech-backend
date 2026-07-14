const express = require("express");
const router = express.Router();
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const { addSubmissionJob } = require("../services/queueServices");
const EmailService = require("../services/emailService");
const CodeExecutionService = require("../services/executionService");
const crypto = require("crypto");

router.post(
  "/",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { title, description, duration, questions } = req.body;

      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }

      if (!duration || typeof duration !== "number" || duration <= 0) {
        return res
          .status(400)
          .json({ error: "Duration must be a positive number (minutes)" });
      }

      if (!Array.isArray(questions) || questions.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one question is required" });
      }

      for (const [i, q] of questions.entries()) {
        if (
          !q.title ||
          !q.description ||
          !q.difficulty ||
          typeof q.points !== "number"
        ) {
          return res.status(400).json({
            error: `Question ${i + 1} is missing required fields (title, description, difficulty, points)`,
          });
        }
        if (!Array.isArray(q.testCases) || q.testCases.length === 0) {
          return res.status(400).json({
            error: `Question ${i + 1} needs at least one test case`,
          });
        }
      }

      const assessment = await prisma.assessment.create({
        data: {
          title: title.trim(),
          description: description?.trim() || null,
          duration,
          createdBy: req.user.id,
          questions: {
            create: questions.map((q, index) => ({
              title: q.title,
              description: q.description,
              difficulty: q.difficulty,
              points: q.points,
              order: index,
              testCases: {
                create: q.testCases.map((tc, tcIndex) => ({
                  input: tc.input,
                  expectedOutput: tc.expectedOutput,
                  isHidden: tc.isHidden || false,
                  order: tc.order ?? tcIndex,
                })),
              },
            })),
          },
        },
        include: {
          questions: {
            include: { testCases: true },
            orderBy: { order: "asc" },
          },
        },
      });

      res.status(201).json(assessment);
    } catch (error) {
      console.error("Create assessment error:", error);
      res.status(500).json({ error: "Failed to create assessment" });
    }
  },
);

router.get(
  "/",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { search, page = 1, limit = 20 } = req.query;

      const where = {
        ...(req.user.role === "ADMIN" ? {} : { createdBy: req.user.id }),
        ...(search && {
          title: { contains: search, mode: "insensitive" },
        }),
      };

      const skip = (Number(page) - 1) * Number(limit);

      const [assessments, total] = await Promise.all([
        prisma.assessment.findMany({
          where,
          include: {
            _count: {
              select: {
                questions: true,
                submissions: true,
                invitations: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: Number(limit),
        }),
        prisma.assessment.count({ where }),
      ]);

      res.json({
        assessments,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error("List assessments error:", error);
      res.status(500).json({ error: "Failed to fetch assessments" });
    }
  },
);

router.patch(
  "/:id",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, description, duration, questions } = req.body;

      const existingAssessment = await prisma.assessment.findUnique({
        where: { id },
        include: { questions: { include: { testCases: true } } },
      });

      if (!existingAssessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      if (
        req.user.role !== "ADMIN" &&
        existingAssessment.createdBy !== req.user.id
      ) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (title !== undefined && (typeof title !== "string" || !title.trim())) {
        return res.status(400).json({ error: "Title cannot be empty" });
      }

      if (
        duration !== undefined &&
        (typeof duration !== "number" || duration <= 0)
      ) {
        return res
          .status(400)
          .json({ error: "Duration must be a positive number" });
      }

      if (Array.isArray(questions)) {
        const invitationCount = await prisma.invitation.count({ where: { assessmentId: id } });
        if (invitationCount > 0) {
          return res.status(409).json({
            error: "Assessment questions cannot be changed after invitations have been sent.",
          });
        }
      }

      const updatedAssessment = await prisma.$transaction(async (tx) => {
        const data = {};
        if (title !== undefined) data.title = title.trim();
        if (description !== undefined)
          data.description = description?.trim() || null;
        if (duration !== undefined) data.duration = duration;

        if (Object.keys(data).length > 0) {
          await tx.assessment.update({ where: { id }, data });
        }

        if (Array.isArray(questions)) {
          const existingQuestionIds = existingAssessment.questions.map(
            (q) => q.id,
          );
          const incomingQuestionIds = questions
            .filter((q) => q.id)
            .map((q) => q.id);

          const questionIdsToDelete = existingQuestionIds.filter(
            (qId) => !incomingQuestionIds.includes(qId),
          );

          if (questionIdsToDelete.length > 0) {
            await tx.testCase.deleteMany({
              where: { questionId: { in: questionIdsToDelete } },
            });
            await tx.question.deleteMany({
              where: { id: { in: questionIdsToDelete } },
            });
          }

          for (const [index, q] of questions.entries()) {
            if (q.id) {
              const existingQuestion = existingAssessment.questions.find(
                (eq) => eq.id === q.id,
              );
              if (!existingQuestion) {
                throw new Error(
                  `Question ${q.id} not found on this assessment`,
                );
              }

              await tx.question.update({
                where: { id: q.id },
                data: {
                  title: q.title,
                  description: q.description,
                  difficulty: q.difficulty,
                  points: q.points,
                  order: index,
                },
              });

              if (Array.isArray(q.testCases)) {
                const existingTcIds = existingQuestion.testCases.map(
                  (tc) => tc.id,
                );
                const incomingTcIds = q.testCases
                  .filter((tc) => tc.id)
                  .map((tc) => tc.id);

                const tcIdsToDelete = existingTcIds.filter(
                  (tcId) => !incomingTcIds.includes(tcId),
                );
                if (tcIdsToDelete.length > 0) {
                  await tx.testCase.deleteMany({
                    where: { id: { in: tcIdsToDelete } },
                  });
                }

                for (const [tcIndex, tc] of q.testCases.entries()) {
                  if (tc.id) {
                    await tx.testCase.update({
                      where: { id: tc.id },
                      data: {
                        input: tc.input,
                        expectedOutput: tc.expectedOutput,
                        isHidden: tc.isHidden ?? false,
                        order: tc.order ?? tcIndex,
                      },
                    });
                  } else {
                    await tx.testCase.create({
                      data: {
                        questionId: q.id,
                        input: tc.input,
                        expectedOutput: tc.expectedOutput,
                        isHidden: tc.isHidden ?? false,
                        order: tc.order ?? tcIndex,
                      },
                    });
                  }
                }
              }
            } else {
              await tx.question.create({
                data: {
                  assessmentId: id,
                  title: q.title,
                  description: q.description,
                  difficulty: q.difficulty,
                  points: q.points,
                  order: index,
                  testCases: {
                    create: (q.testCases || []).map((tc, tcIndex) => ({
                      input: tc.input,
                      expectedOutput: tc.expectedOutput,
                      isHidden: tc.isHidden ?? false,
                      order: tc.order ?? tcIndex,
                    })),
                  },
                },
              });
            }
          }
        }

        return tx.assessment.findUnique({
          where: { id },
          include: {
            questions: {
              include: { testCases: true },
              orderBy: { order: "asc" },
            },
          },
        });
      });

      res.json(updatedAssessment);
    } catch (error) {
      console.error("Update assessment error:", error);
      res.status(500).json({ error: "Failed to update assessment" });
    }
  },
);

router.delete(
  "/:id",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const assessment = await prisma.assessment.findUnique({
        where: { id },
        select: { id: true, createdBy: true },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await prisma.$transaction(async (tx) => {
        const invitations = await tx.invitation.findMany({
          where: { assessmentId: id },
          select: { id: true },
        });
        const invitationIds = invitations.map((inv) => inv.id);

        // CandidateEvent and Submission cascade from Invitation,
        // but only if we delete via the invitation itself.
        if (invitationIds.length > 0) {
          await tx.candidateEvent.deleteMany({
            where: { invitationId: { in: invitationIds } },
          });
          await tx.submission.deleteMany({
            where: { invitationId: { in: invitationIds } },
          });
        }

        // Submissions with no invitation edge case shouldn't exist per schema
        // (invitationId is required), so the above covers all submissions.

        await tx.invitation.deleteMany({ where: { assessmentId: id } });

        const questions = await tx.question.findMany({
          where: { assessmentId: id },
          select: { id: true },
        });
        const questionIds = questions.map((q) => q.id);

        if (questionIds.length > 0) {
          await tx.testCase.deleteMany({
            where: { questionId: { in: questionIds } },
          });
          await tx.question.deleteMany({ where: { assessmentId: id } });
        }

        await tx.assessment.delete({ where: { id } });
      });

      res.status(204).send();
    } catch (error) {
      console.error("Delete assessment error:", error);
      res.status(500).json({ error: "Failed to delete assessment" });
    }
  },
);

router.get(
  "/:id/candidates",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const assessment = await prisma.assessment.findUnique({
        where: { id },
        select: { id: true, createdBy: true },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const invitations = await prisma.invitation.findMany({
        where: { assessmentId: id },
        include: {
          events: { select: { eventType: true } },
          submissions: {
            where: { isFinal: true },
            select: {
              id: true,
              questionId: true,
              status: true,
              passed: true,
              failed: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const candidates = invitations.map((inv) => {
        const totalSubmissions = inv.submissions.length;
        const totalPassed = inv.submissions.reduce(
          (sum, s) => sum + (s.passed || 0),
          0,
        );
        const totalFailed = inv.submissions.reduce(
          (sum, s) => sum + (s.failed || 0),
          0,
        );

        let progress = "not_started";
        if (inv.completedAt) progress = "completed";
        else if (inv.startedAt) progress = "in_progress";
        else if (new Date() > inv.expiresAt) progress = "expired";

        return {
          invitationId: inv.id,
          email: inv.email,
          status: inv.status,
          progress,
          startedAt: inv.startedAt,
          completedAt: inv.completedAt,
          expiresAt: inv.expiresAt,
          questionsAttempted: totalSubmissions,
          questionsSolved: inv.submissions.filter((s) => (s.failed || 0) === 0 && (s.passed || 0) > 0).length,
          totalPassed,
          totalFailed,
          flaggedEvents: inv.events.filter((event) => ["TAB_SWITCH", "WINDOW_BLUR", "COPY", "PASTE", "FULLSCREEN_EXIT"].includes(event.eventType)).length,
        };
      });

      res.json(candidates);
    } catch (error) {
      console.error("List assessment candidates error:", error);
      res.status(500).json({ error: "Failed to fetch candidates" });
    }
  },
);

router.get("/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      return res.status(404).json({
        error: "Invitation not found.",
      });
    }
    if (new Date() > invitation.expiresAt) {
      return res.status(410).json({
        error: "This assessment link has expired.",
      });
    }

    const assessment = await prisma.assessment.findUnique({
      where: {
        id: invitation.assessmentId,
      },
      include: {
        questions: {
          include: {
            testCases: {
              where: {
                isHidden: false,
              },
            },
          },
          orderBy: {
            order: "asc",
          },
        },
      },
    });

    if (!assessment) {
      return res.status(404).json({
        error: "Assessment not found.",
      });
    }

    res.json(assessment);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to fetch assessment.",
    });
  }
});

// Candidate-facing endpoints use the invitation token rather than an account.
// Keep them explicit so they cannot be confused with the recruiter endpoints.
async function validInvitation(token) {
  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) return { error: { status: 404, message: "Invitation not found." } };
  if (invitation.status === "REVOKED") return { error: { status: 410, message: "This invitation has been revoked." } };
  if (new Date() > invitation.expiresAt) return { error: { status: 410, message: "This assessment link has expired." } };
  return { invitation };
}

router.get("/take/:token", async (req, res) => {
  try {
    const { invitation, error } = await validInvitation(req.params.token);
    if (error) return res.status(error.status).json({ error: error.message });

    const assessment = await prisma.assessment.findUnique({
      where: { id: invitation.assessmentId },
      include: {
        questions: {
          include: { testCases: { where: { isHidden: false }, orderBy: { order: "asc" } } },
          orderBy: { order: "asc" },
        },
      },
    });
    if (!assessment) return res.status(404).json({ error: "Assessment not found." });

    const startedAt = invitation.startedAt || new Date();
    if (!invitation.startedAt) {
      await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "STARTED", startedAt } });
    }
    res.json({ assessment, invitation: { id: invitation.id, startedAt, expiresAt: invitation.expiresAt } });
  } catch (error) {
    console.error("Load candidate assessment error:", error);
    res.status(500).json({ error: "Failed to fetch assessment." });
  }
});

router.get("/take/:token/submissions", async (req, res) => {
  try {
    const { invitation, error } = await validInvitation(req.params.token);
    if (error) return res.status(error.status).json({ error: error.message });
    const submissions = await prisma.submission.findMany({
      where: { invitationId: invitation.id },
      select: { id: true, questionId: true, status: true, passed: true, failed: true, createdAt: true, isFinal: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(submissions);
  } catch (error) {
    console.error("Load candidate submissions error:", error);
    res.status(500).json({ error: "Failed to fetch submissions." });
  }
});

router.post("/take/:token/finish", async (req, res) => {
  try {
    const { invitation, error } = await validInvitation(req.params.token);
    if (error) return res.status(error.status).json({ error: error.message });
    const [totalQuestions, attempted, processingSubmissions] = await Promise.all([
      prisma.question.count({ where: { assessmentId: invitation.assessmentId } }),
      prisma.submission.count({ where: { invitationId: invitation.id, isFinal: true } }),
      prisma.submission.count({ where: { invitationId: invitation.id, status: { in: ["PENDING", "RUNNING"] } } }),
    ]);
    if (processingSubmissions > 0) {
      return res.status(409).json({ error: "Wait for all submitted code to finish running before completing the assessment." });
    }
    const updated = await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "COMPLETED", completedAt: new Date() },
      select: { id: true, completedAt: true },
    });
    res.json({ invitation: updated, unansweredQuestions: Math.max(0, totalQuestions - attempted) });
  } catch (error) {
    console.error("Finish assessment error:", error);
    res.status(500).json({ error: "Failed to finish assessment." });
  }
});

module.exports = router;
