const express = require("express");
const router = express.Router();
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const { addSubmissionJob } = require("../services/queueServices");
const EmailService = require("../services/emailService");
const CodeExecutionService = require("../services/executionService");
const crypto = require("crypto");
// TODO: this is used in /take/:token/run and /take/:token/submit but is
// never imported anywhere in this file. Add the real require, e.g.:
// const CodeExecutionService = require("../services/cCodeExecutionService");

/**
 * Shared guard for all candidate-facing "/take/:token" style routes.
 * Looks up an Invitation by its token and returns a structured error
 * for the four states that should block access: not found, revoked,
 * expired, already completed.
 */
async function getValidInvitation(token) {
  const invitation = await prisma.invitation.findUnique({ where: { token } });

  if (!invitation) {
    return { error: { status: 404, body: { error: "Invitation not found." } } };
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
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * GET /assessments
 * Admin/Recruiter dashboard list. Admins see every assessment, recruiters
 * only see the ones they created. Supports title search + pagination.
 */
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

/**
 * POST /assessments
 * Creates a brand-new assessment along with its questions and each
 * question's test cases in one nested Prisma create. Validates title,
 * duration, and that every question has the required fields + at least
 * one test case before touching the DB.
 */
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

/**
 * DELETE /assessments/:id
 * Hard delete of an assessment and everything under it. Manually cascades
 * in a transaction: CandidateEvents + Submissions (via their invitations),
 * then Invitations, then TestCases + Questions, then the Assessment itself.
 * Owner (recruiter) or Admin only.
 */
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

/**
 * GET /assessments/:id/candidates
 * Recruiter-facing roster for one assessment: every invitation sent out,
 * with a derived `progress` state (not_started / in_progress / completed /
 * expired) plus aggregate pass/fail counts from each candidate's FINAL
 * submissions only (practice "run" attempts don't count).
 *
 * NOTE: keep this one — there is a second "GET /:id/candidates" defined
 * further down in the file (near the submissions route) that is dead code.
 * Express matches routes in registration order, so this first definition
 * always wins and the later one never executes. Delete the duplicate.
 */
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
          totalPassed,
          totalFailed,
        };
      });

      res.json(candidates);
    } catch (error) {
      console.error("List assessment candidates error:", error);
      res.status(500).json({ error: "Failed to fetch candidates" });
    }
  },
);

/**
 * GET /assessments/:id/stats
 * Aggregate scoreboard for one assessment: invite/start/completion counts
 * and rates, plus an average score computed by weighting each final
 * submission's passed/total test ratio against that question's point value.
 */
router.get(
  "/:id/stats",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const assessment = await prisma.assessment.findUnique({
        where: { id },
        select: {
          id: true,
          createdBy: true,
          questions: { select: { id: true, points: true } },
        },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const totalPossiblePoints = assessment.questions.reduce(
        (sum, q) => sum + q.points,
        0,
      );
      const questionPointsMap = new Map(
        assessment.questions.map((q) => [q.id, q.points]),
      );

      const invitations = await prisma.invitation.findMany({
        where: { assessmentId: id },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          expiresAt: true,
        },
      });

      const totalInvited = invitations.length;
      const totalStarted = invitations.filter((i) => i.startedAt).length;
      const totalCompleted = invitations.filter((i) => i.completedAt).length;
      const totalExpiredNotStarted = invitations.filter(
        (i) => !i.startedAt && new Date() > i.expiresAt,
      ).length;

      const completionRate =
        totalInvited > 0 ? (totalCompleted / totalInvited) * 100 : 0;
      const startRate =
        totalInvited > 0 ? (totalStarted / totalInvited) * 100 : 0;

      const finalSubmissions = await prisma.submission.findMany({
        where: {
          assessmentId: id,
          isFinal: true,
        },
        select: {
          invitationId: true,
          questionId: true,
          passed: true,
          failed: true,
        },
      });

      const scoresByInvitation = new Map();
      for (const sub of finalSubmissions) {
        if (!sub.questionId) continue;
        const points = questionPointsMap.get(sub.questionId) || 0;
        const totalTests = (sub.passed || 0) + (sub.failed || 0);
        const earnedPoints =
          totalTests > 0 ? (sub.passed / totalTests) * points : 0;

        const current = scoresByInvitation.get(sub.invitationId) || 0;
        scoresByInvitation.set(sub.invitationId, current + earnedPoints);
      }

      const scores = Array.from(scoresByInvitation.values());
      const avgScore =
        scores.length > 0
          ? scores.reduce((sum, s) => sum + s, 0) / scores.length
          : 0;
      const avgScorePercent =
        totalPossiblePoints > 0 ? (avgScore / totalPossiblePoints) * 100 : 0;

      res.json({
        totalInvited,
        totalStarted,
        totalCompleted,
        totalExpiredNotStarted,
        completionRate: Math.round(completionRate * 10) / 10,
        startRate: Math.round(startRate * 10) / 10,
        totalPossiblePoints,
        avgScore: Math.round(avgScore * 10) / 10,
        avgScorePercent: Math.round(avgScorePercent * 10) / 10,
        candidatesScored: scores.length,
      });
    } catch (error) {
      console.error("Get assessment stats error:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  },
);

/**
 * POST /assessments/:id/questions
 * Appends a single new question (+ its test cases) to an existing
 * assessment. `order` is auto-set to the current question count so it
 * lands at the end of the list.
 */
router.post(
  "/:id/questions",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, description, difficulty, points, testCases } = req.body;

      const assessment = await prisma.assessment.findUnique({
        where: { id },
        select: {
          id: true,
          createdBy: true,
          _count: { select: { questions: true } },
        },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }
      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!title || !description || !difficulty || typeof points !== "number") {
        return res.status(400).json({
          error: "title, description, difficulty and points are required",
        });
      }
      if (!Array.isArray(testCases) || testCases.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one test case is required" });
      }

      const question = await prisma.question.create({
        data: {
          assessmentId: id,
          title,
          description,
          difficulty,
          points,
          order: assessment._count.questions, // append to end
          testCases: {
            create: testCases.map((tc, index) => ({
              input: tc.input,
              expectedOutput: tc.expectedOutput,
              isHidden: tc.isHidden ?? false,
              order: tc.order ?? index,
            })),
          },
        },
        include: { testCases: true },
      });

      res.status(201).json(question);
    } catch (error) {
      console.error("Add question error:", error);
      res.status(500).json({ error: "Failed to add question" });
    }
  },
);

/**
 * PATCH /assessments/:id/questions/reorder
 * Bulk re-sequences a question list given a full array of question ids in
 * the desired order. Must stay registered ABOVE the "/:qId" patch route
 * below, otherwise Express would try to match "reorder" as a :qId value.
 * Rejects the request unless the incoming id set exactly matches the
 * assessment's existing question ids (no adding/removing here).
 */
router.patch(
  "/:id/questions/reorder",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { order } = req.body; // e.g. [{ questionId: "abc" }, { questionId: "def" }]

      const assessment = await prisma.assessment.findUnique({
        where: { id },
        select: {
          id: true,
          createdBy: true,
          questions: { select: { id: true } },
        },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }
      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!Array.isArray(order) || order.length === 0) {
        return res
          .status(400)
          .json({ error: "order must be a non-empty array" });
      }

      const existingIds = assessment.questions.map((q) => q.id).sort();
      const incomingIds = order.map((o) => o.questionId).sort();
      const sameSet =
        existingIds.length === incomingIds.length &&
        existingIds.every((val, i) => val === incomingIds[i]);

      if (!sameSet) {
        return res.status(400).json({
          error:
            "order must include exactly the existing question ids for this assessment",
        });
      }

      await prisma.$transaction(
        order.map((o, index) =>
          prisma.question.update({
            where: { id: o.questionId },
            data: { order: index },
          }),
        ),
      );

      const questions = await prisma.question.findMany({
        where: { assessmentId: id },
        orderBy: { order: "asc" },
        include: { testCases: true },
      });

      res.json(questions);
    } catch (error) {
      console.error("Reorder questions error:", error);
      res.status(500).json({ error: "Failed to reorder questions" });
    }
  },
);

/**
 * PATCH /assessments/:id/questions/:qId
 * Partial update of a single question's own fields (title, description,
 * difficulty, points). Does not touch test cases — use the assessment-level
 * PATCH /:id for nested question+testCase edits, or add a dedicated route
 * if you need to edit test cases independently of the parent question.
 */
router.patch(
  "/:id/questions/:qId",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id, qId } = req.params;
      const { title, description, difficulty, points } = req.body;

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

      const question = await prisma.question.findUnique({ where: { id: qId } });
      if (!question || question.assessmentId !== id) {
        return res
          .status(404)
          .json({ error: "Question not found on this assessment" });
      }

      const data = {};
      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (difficulty !== undefined) data.difficulty = difficulty;
      if (points !== undefined) {
        if (typeof points !== "number") {
          return res.status(400).json({ error: "points must be a number" });
        }
        data.points = points;
      }

      const updated = await prisma.question.update({
        where: { id: qId },
        data,
        include: { testCases: true },
      });

      res.json(updated);
    } catch (error) {
      console.error("Update question error:", error);
      res.status(500).json({ error: "Failed to update question" });
    }
  },
);

/**
 * DELETE /assessments/:id/questions/:qId
 * Removes a single question (and its test cases) from an assessment, then
 * re-normalizes the `order` of whatever's left so there's no gap. Blocks
 * non-admins from deleting a question that already has candidate
 * submissions attached (admins can force it through).
 */
router.delete(
  "/:id/questions/:qId",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const { id, qId } = req.params;

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

      const question = await prisma.question.findUnique({ where: { id: qId } });
      if (!question || question.assessmentId !== id) {
        return res
          .status(404)
          .json({ error: "Question not found on this assessment" });
      }

      const submissionCount = await prisma.submission.count({
        where: { questionId: qId },
      });
      if (submissionCount > 0 && req.user.role !== "ADMIN") {
        return res.status(409).json({
          error: "Cannot delete a question with existing candidate submissions",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.submission.deleteMany({ where: { questionId: qId } });
        await tx.testCase.deleteMany({ where: { questionId: qId } });
        await tx.question.delete({ where: { id: qId } });

        const remaining = await tx.question.findMany({
          where: { assessmentId: id },
          orderBy: { order: "asc" },
        });
        await Promise.all(
          remaining.map((q, index) =>
            tx.question.update({ where: { id: q.id }, data: { order: index } }),
          ),
        );
      });

      res.status(204).send();
    } catch (error) {
      console.error("Delete question error:", error);
      res.status(500).json({ error: "Failed to delete question" });
    }
  },
);

/**
 * PATCH /assessments/:id
 * Full-assessment edit: updates top-level fields (title/description/duration)
 * and, if a `questions` array is supplied, diffs it against what's in the DB
 * — deletes questions/test cases that were dropped, updates ones that kept
 * their id, and creates brand-new ones that arrived without an id. All in
 * one transaction so a partial failure doesn't leave things half-updated.
 */
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

/**
 * GET /assessments/:token
 * Public (no auth) — candidate loads the assessment shell by invitation
 * token before starting. Only returns visible test cases per question.
 *
 * WATCH THIS ONE: the param is named ":token" but it lives at the exact
 * same route shape ("/:something") as an admin "GET /:id" would. Since no
 * admin "GET /:id" route exists elsewhere in this file, there's no
 * collision today — but if you ever add "GET /:id" for admins to fetch a
 * single assessment by id, it will collide with this one (whichever is
 * registered first wins). Worth renaming this path to something like
 * "/public/:token" to avoid future ambiguity.
 */
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

/**
 * DEAD CODE — DELETE THIS ROUTE.
 * Duplicate "GET /:id/candidates" — same method + path as the one defined
 * earlier in the file. Express registers routes in order and matches the
 * first one it finds, so this second definition can never be reached by
 * any request. It also returns a different, less useful shape (just raw
 * candidate records via a distinct-on-submissions query) than the one
 * that's actually live. Safe to remove entirely.
 */
router.get(
  "/:id/candidates",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    try {
      const submissions = await prisma.submission.findMany({
        where: { assessmentId: req.params.id },
        distinct: ["invitationId"],
        include: {
          candidate: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json(submissions.map((submission) => submission.candidate));
    } catch (error) {
      console.error("List assessment candidates error:", error);
      res.status(500).json({ error: "Failed to fetch candidates" });
    }
  },
);

/**
 * POST /assessments/invitations/:token/submissions
 * Public (no auth) — queues a candidate's code for async execution via
 * BullMQ (addSubmissionJob) instead of running it inline. Guards against
 * double-submitting the same question while a prior attempt is still
 * PENDING/RUNNING. NOTE: this doesn't call getValidInvitation(), so it
 * doesn't check REVOKED or already-completed status the way the /take/:token
 * routes do — only expiry is checked here. Worth aligning with
 * getValidInvitation() for consistency.
 */
router.post("/invitations/:token/submissions", async (req, res) => {
  try {
    const { token } = req.params;
    const { questionId, code, language } = req.body;

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
        error: "This assessment has expired.",
      });
    }

    // Prevent duplicate executions
    const existingSubmission = await prisma.submission.findFirst({
      where: {
        invitationId: invitation.id,
        questionId,
        status: {
          in: ["PENDING", "RUNNING"],
        },
      },
    });

    if (existingSubmission) {
      return res.status(409).json({
        error: "Submission already in progress.",
        submissionId: existingSubmission.id,
      });
    }

    // Create submission
    const submission = await prisma.submission.create({
      data: {
        invitationId: invitation.id,
        questionId,
        code,
        language,
        status: "PENDING",
      },
    });

    // Queue execution
    await addSubmissionJob({
      submissionId: submission.id,
      invitationId: invitation.id,
      questionId,
      code,
      language,
    });
    res.status(202).json({
      message: "Submission queued.",
      submissionId: submission.id,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to submit code.",
    });
  }
});

/**
 * GET /assessments/:assessmentId/completion-status?token=...
 * Meant to let a candidate check their own completion + score without
 * logging in — but this route currently requires authMiddleware, which
 * a token-only candidate won't have. Almost certainly a bug: either drop
 * authMiddleware here (matching the other /take/:token routes), or if this
 * really is meant to be an authenticated recruiter-facing check, move the
 * token lookup logic to match that intent. Also uses `logger.error` which
 * isn't imported anywhere in this file — swap for `console.error` or add
 * the logger import.
 */
router.get(
  "/:assessmentId/completion-status",
  authMiddleware,
  async (req, res) => {
    try {
      const { assessmentId } = req.params;
      const { token } = req.query;

      if (!token) {
        return res.status(400).json({
          error: "Invitation token is required",
        });
      }

      // Find invitation
      const invitation = await prisma.invitation.findFirst({
        where: {
          assessmentId,
          token,
        },
      });

      if (!invitation) {
        return res.status(404).json({
          error: "Invitation not found",
        });
      }

      // Count assessment questions
      const totalQuestions = await prisma.question.count({
        where: {
          assessmentId,
        },
      });

      // Get final submissions
      const submissions = await prisma.submission.findMany({
        where: {
          assessmentId,
          invitationId: invitation.id,
          isFinal: true,
        },
      });

      const submittedQuestions = new Set(submissions.map((s) => s.questionId))
        .size;

      const totalScore = submissions.reduce(
        (sum, submission) => sum + (submission.passed ?? 0),
        0,
      );

      res.json({
        isCompleted: submittedQuestions === totalQuestions,
        totalQuestions,
        submittedQuestions,
        totalScore,
      });
    } catch (error) {
      console.error("Completion status error:", error); // was logger.error — logger was never imported

      res.status(500).json({
        error: "Failed to check completion status",
        message:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  },
);

/**
 * POST /assessments/:id/invitations
 * Bulk-invites a list of candidate emails to one assessment. Skips anyone
 * who already has a PENDING or STARTED invitation for this assessment
 * (reported back as "already_invited" rather than erroring the whole batch).
 * Fires off an invitation email per new candidate via EmailService.
 */
router.post(
  "/:id/invitations",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const { id: assessmentId } = req.params;
    const { emails } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        error: "Please provide at least one email.",
      });
    }

    try {
      const assessment = await prisma.assessment.findUnique({
        where: { id: assessmentId },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found." });
      }

      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized." });
      }

      const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const results = [];

      for (const email of emails) {
        const existingInvitation = await prisma.invitation.findFirst({
          where: {
            assessmentId,
            email,
            status: { in: ["PENDING", "STARTED"] },
          },
        });

        if (existingInvitation) {
          results.push({ email, status: "already_invited" });
          continue;
        }

        const token = crypto.randomBytes(32).toString("hex");

        await prisma.invitation.create({
          data: {
            assessmentId,
            email,
            token,
            status: "PENDING",
            expiresAt,
          },
        });

        await EmailService.sendInvitation(
          email,
          token,
          assessment.title,
          assessmentId,
        );

        results.push({ email, status: "sent" });
      }

      return res.status(201).json({
        message: "Invitations processed successfully.",
        results,
      });
    } catch (err) {
      console.error("Create invitations error:", err);
      return res.status(500).json({ error: "Failed to send invitations." });
    }
  },
);

/**
 * GET /assessments/:id/invitations
 * Recruiter view of every invitation sent for one assessment, with a
 * submission count per invitation but no scoring detail (use /:id/stats
 * or /:id/candidates for that).
 */
router.get(
  "/:id/invitations",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const { id: assessmentId } = req.params;

    try {
      const assessment = await prisma.assessment.findUnique({
        where: { id: assessmentId },
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found." });
      }

      if (req.user.role !== "ADMIN" && assessment.createdBy !== req.user.id) {
        return res.status(403).json({ error: "Not authorized." });
      }

      const invitations = await prisma.invitation.findMany({
        where: { assessmentId },
        select: {
          id: true,
          email: true,
          status: true,
          expiresAt: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          _count: { select: { submissions: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json(invitations);
    } catch (err) {
      console.error("List invitations error:", err);
      return res.status(500).json({ error: "Failed to fetch invitations." });
    }
  },
);

/**
 * DELETE /assessments/invitations/:id
 * Soft "delete" — actually just revokes: flips status to REVOKED and
 * expires the link immediately, rather than removing the row. Blocked if
 * the candidate already completed the assessment.
 */
router.delete(
  "/invitations/:id",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const { id } = req.params;

    try {
      const invitation = await prisma.invitation.findUnique({
        where: { id },
        include: { assessment: { select: { createdBy: true } } },
      });

      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found." });
      }

      if (
        req.user.role !== "ADMIN" &&
        invitation.assessment.createdBy !== req.user.id
      ) {
        return res.status(403).json({ error: "Not authorized." });
      }

      if (invitation.completedAt) {
        return res
          .status(409)
          .json({ error: "Cannot revoke a completed invitation." });
      }

      const revoked = await prisma.invitation.update({
        where: { id },
        data: { status: "REVOKED", expiresAt: new Date() },
      });

      return res.json(revoked);
    } catch (err) {
      console.error("Revoke invitation error:", err);
      return res.status(500).json({ error: "Failed to revoke invitation." });
    }
  },
);

/**
 * POST /assessments/invitations/:id/resend
 * Extends an invitation's expiry by another 2 days, resets status back to
 * PENDING, and re-sends the invite email. Blocked for completed or
 * revoked invitations (revoked ones need a brand-new invitation instead).
 */
router.post(
  "/invitations/:id/resend",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const { id } = req.params;

    try {
      const invitation = await prisma.invitation.findUnique({
        where: { id },
        include: { assessment: { select: { createdBy: true, title: true } } },
      });

      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found." });
      }

      if (
        req.user.role !== "ADMIN" &&
        invitation.assessment.createdBy !== req.user.id
      ) {
        return res.status(403).json({ error: "Not authorized." });
      }

      if (invitation.completedAt) {
        return res
          .status(409)
          .json({ error: "Cannot resend a completed invitation." });
      }

      if (invitation.status === "REVOKED") {
        return res.status(409).json({
          error:
            "Cannot resend a revoked invitation. Create a new one instead.",
        });
      }

      const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

      const updated = await prisma.invitation.update({
        where: { id },
        data: { expiresAt, status: "PENDING" },
      });

      await EmailService.sendInvitation(
        invitation.email,
        invitation.token,
        invitation.assessment.title,
        invitation.assessmentId,
      );

      return res.json(updated);
    } catch (err) {
      console.error("Resend invitation error:", err);
      return res.status(500).json({ error: "Failed to resend invitation." });
    }
  },
);

/**
 * GET /assessments/take/:token
 * Public (no auth) — candidate's actual entry point into taking the
 * assessment. Marks the invitation STARTED on first visit (idempotent —
 * won't re-stamp startedAt on refresh), then returns the full assessment
 * with only visible test cases.
 */
router.get("/take/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    if (!invitation.startedAt) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { startedAt: new Date(), status: "STARTED" },
      });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: invitation.assessmentId },
      include: {
        questions: {
          include: {
            testCases: { where: { isHidden: false } },
          },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!assessment) {
      return res.status(404).json({ error: "Assessment not found." });
    }

    res.json({
      assessment,
      invitation: {
        id: invitation.id,
        startedAt: invitation.startedAt || new Date(),
        expiresAt: invitation.expiresAt,
      },
    });
  } catch (err) {
    console.error("Fetch assessment by token error:", err);
    res.status(500).json({ error: "Failed to fetch assessment." });
  }
});

/**
 * POST /assessments/take/:token/events
 * Public (no auth) — candidate-side telemetry/audit log (tab switches,
 * paste events, focus loss, etc — whatever eventType your frontend sends).
 * Just appends a CandidateEvent row tied to the invitation + a client
 * sessionId; no anti-cheat logic lives here, this only records the event.
 */
router.post("/take/:token/events", async (req, res) => {
  const { token } = req.params;
  const { sessionId, eventType, metadata } = req.body;

  if (!sessionId || !eventType) {
    return res
      .status(400)
      .json({ error: "sessionId and eventType are required." });
  }

  try {
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    const event = await prisma.candidateEvent.create({
      data: {
        invitationId: invitation.id,
        sessionId,
        eventType,
        metadata: metadata ?? undefined,
      },
    });

    res.status(201).json(event);
  } catch (err) {
    console.error("Log candidate event error:", err);
    res.status(500).json({ error: "Failed to log event." });
  }
});

/**
 * POST /assessments/take/:token/run
 * Public (no auth) — "Run Code" button. Executes against VISIBLE test
 * cases only and does NOT persist a Submission row — purely a scratch/
 * practice run so candidates can sanity-check before their real submit.
 *
 * BUG: `CodeExecutionService` is referenced but never required/imported
 * anywhere in this file. This route will throw a ReferenceError as soon
 * as it's hit. Add the require at the top once you have that service.
 */

console.log("==== HIT /take/:token/run ====");
router.post("/take/:token/run", async (req, res) => {
  console.log("==== HIT /take/:token/run ====");

  const { token } = req.params;
  const { questionId, code, language } = req.body;

  if (!questionId || !code || !language) {
    return res
      .status(400)
      .json({ error: "questionId, code and language are required." });
  }

  try {
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

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

    // TODO: replace with your real execution service
    const results = await CodeExecutionService.executeCode({
      code,
      language,
      testCases: question.testCases.map((tc) => ({
        id: tc.id,
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      })),
    });

    res.json({ results });
  } catch (err) {
    console.error("Run code error:", err);
    res.status(500).json({ error: "Failed to run code." });
  }
});

/**
 * POST /assessments/take/:token/submit
 * Public (no auth) — the REAL final submission for one question. Runs
 * against ALL test cases (hidden included), persists a Submission row with
 * isFinal: true, and stores the pass/fail counts + raw results.
 *
 * Same missing-import bug as /take/:token/run: `CodeExecutionService` is
 * not required anywhere in this file.
 */
router.post("/take/:token/submit", async (req, res) => {
  const { token } = req.params;
  const { questionId, code, language } = req.body;

  if (!questionId || !code || !language) {
    return res
      .status(400)
      .json({ error: "questionId, code and language are required." });
  }

  try {
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { testCases: { orderBy: { order: "asc" } } }, // all test cases, hidden included
    });

    if (!question || question.assessmentId !== invitation.assessmentId) {
      return res
        .status(404)
        .json({ error: "Question not found on this assessment." });
    }

    // TODO: replace with your real execution service
    const executionResult = await CodeExecutionService.executeCode({
      code,
      language,
      testCases: question.testCases.map((tc) => ({
        id: tc.id,
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      })),
    });

    const passed = executionResult.results.filter((r) => r.passed).length;
    const failed = executionResult.results.length - passed;

    const submission = await prisma.submission.create({
      data: {
        invitationId: invitation.id,
        assessmentId: invitation.assessmentId,
        questionId,
        code,
        language,
        status: executionResult.status ?? "COMPLETED",
        results: executionResult.results,
        passed,
        failed,
        executionTime: executionResult.executionTime ?? null,
        memoryUsed: executionResult.memoryUsed ?? null,
        isFinal: true,
      },
    });

    res.status(201).json(submission);
  } catch (err) {
    console.error("Submit code error:", err);
    res.status(500).json({ error: "Failed to submit code." });
  }
});

/**
 * POST /assessments/take/:token/finish
 * Public (no auth) — candidate clicks "Finish Assessment". Marks the
 * invitation COMPLETED regardless of whether every question was answered,
 * and reports back how many questions were left unanswered so the frontend
 * can show a "you skipped N questions" style confirmation if needed.
 */
router.post("/take/:token/finish", async (req, res) => {
  const { token } = req.params;

  try {
    const { invitation, error } = await getValidInvitation(token);
    if (error) return res.status(error.status).json(error.body);

    const assessment = await prisma.assessment.findUnique({
      where: { id: invitation.assessmentId },
      select: { questions: { select: { id: true } } },
    });

    const finalSubmissions = await prisma.submission.findMany({
      where: { invitationId: invitation.id, isFinal: true },
      select: { questionId: true },
    });

    const answeredQuestionIds = new Set(
      finalSubmissions.map((s) => s.questionId),
    );
    const unanswered = assessment.questions.filter(
      (q) => !answeredQuestionIds.has(q.id),
    );

    const updated = await prisma.invitation.update({
      where: { id: invitation.id },
      data: { completedAt: new Date(), status: "COMPLETED" },
    });

    res.json({
      invitation: updated,
      unansweredQuestions: unanswered.length,
    });
  } catch (err) {
    console.error("Finish assessment error:", err);
    res.status(500).json({ error: "Failed to finish assessment." });
  }
});

/**
 * GET /assessments/take/:token/submissions
 * Public (no auth) — lets a candidate see their own final results,
 * scoped strictly to their invitation. Deliberately skips the expiry/
 * completed checks that getValidInvitation() would normally apply (only
 * checks REVOKED) since a candidate should still be able to view their
 * own past results after the window closes. `results` (the detailed
 * per-test-case output) is intentionally left out of the response.
 */
router.get("/take/:token/submissions", async (req, res) => {
  const { token } = req.params;

  try {
    const invitation = await prisma.invitation.findUnique({ where: { token } });

    if (!invitation) {
      return res.status(403).json({ error: "Invalid invitation token." });
    }
    if (invitation.status === "REVOKED") {
      return res
        .status(410)
        .json({ error: "This assessment link has been revoked." });
    }
    // Intentionally no expiresAt/completedAt check here — unlike the other
    // /take/:token routes, viewing your own past results should still work
    // after the assessment is finished or the link has expired.

    const submissions = await prisma.submission.findMany({
      where: {
        invitationId: invitation.id,
        isFinal: true, // practice "run" attempts never create rows, but be explicit
      },
      select: {
        id: true,
        questionId: true,
        status: true,
        passed: true,
        failed: true,
        executionTime: true,
        createdAt: true,
        // results intentionally omitted — see note below
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(submissions);
  } catch (err) {
    console.error("Fetch candidate submissions error:", err);
    res.status(500).json({ error: "Failed to fetch submissions." });
  }
});

module.exports = router;
