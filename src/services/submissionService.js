// src/services/submissionService.js
const prisma = require("../config/database");
const { logger } = require("../config/monitoring");

class SubmissionService {
  async processSubmission(submissionId) {
    try {
      const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: {
          question: {
            include: {
              testCases: true,
            },
          },
        },
      });

      if (!submission) {
        throw new Error("Submission not found");
      }

      // Update status
      await prisma.submission.update({
        where: { id: submissionId },
        data: { status: "RUNNING" },
      });

      // Execute code
      const execution = await this.executeCode(submission);
      const results = Array.isArray(execution) ? execution : execution.results || [];

      // Calculate statistics
      const passed = results.filter((r) => r.passed).length;
      const failed = results.filter((r) => !r.passed).length;
      const total = passed + failed;

      // Update submission with results
      const updated = await prisma.submission.update({
        where: { id: submissionId },
        data: {
          status: "COMPLETED",
          results,
          passed,
          failed,
          executionTime: results.reduce(
            (sum, r) => sum + (r.executionTime || 0),
            0,
          ),
          memoryUsed: results.reduce((sum, r) => sum + (r.memoryUsed || 0), 0),
        },
        include: {
          assessment: true,
          invitation: true,
        },
      });

      // Check if all questions are answered
      await this.checkAssessmentCompletion(
        submission.assessmentId,
        submission.invitationId,
      );

      // Send notifications
      await this.sendCompletionNotifications(updated);

      return updated;
    } catch (error) {
      logger.error("Process submission error:", error);

      await prisma.submission.update({
        where: { id: submissionId },
        data: { status: "FAILED" },
      });

      throw error;
    }
  }

  async executeCode(submission) {
    // Use the code execution service
    const codeExecutionService = require("./executionService");
    return await codeExecutionService.executeCode({
      code: submission.code,
      language: submission.language,
      testCases: submission.question.testCases.map((tc) => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        isHidden: tc.isHidden,
      })),
    });
  }

  async checkAssessmentCompletion(assessmentId, invitationId) {
    const totalQuestions = await prisma.question.count({
      where: { assessmentId },
    });

    const completedSubmissions = await prisma.submission.findMany({
      where: {
        assessmentId,
        invitationId,
        status: "COMPLETED",
      },
      distinct: ["questionId"],
    });

    const isComplete = completedSubmissions.length === totalQuestions;

    if (isComplete) {
      // Calculate final score
      const allSubmissions = await prisma.submission.findMany({
        where: {
          assessmentId,
          invitationId,
          status: "COMPLETED",
        },
      });

      const totalPassed = allSubmissions.reduce(
        (sum, s) => sum + (s.passed || 0),
        0,
      );
      const totalFailed = allSubmissions.reduce(
        (sum, s) => sum + (s.failed || 0),
        0,
      );
      const totalQuestionsAll = totalPassed + totalFailed;
      const finalScore =
        totalQuestionsAll > 0 ? (totalPassed / totalQuestionsAll) * 100 : 0;

      // Update assessment completion
      await prisma.assessment.update({
        where: { id: assessmentId },
        data: {
          submissions: {
            updateMany: {
              where: { invitationId },
              data: { isFinal: true },
            },
          },
        },
      });

      // Emit completion event
      const io = require("../sockets").getIO();
      io.to(`assessment-${assessmentId}`).emit("assessment:completed", {
        invitationId,
        score: Math.round(finalScore * 100) / 100,
        totalPassed,
        totalFailed,
      });
    }
  }

  async sendCompletionNotifications(submission) {
    // Send email notification
    const emailService = require("./emailService");
    if (submission.invitation && submission.assessment) {
      const total = (submission.passed || 0) + (submission.failed || 0);
      await emailService.sendSubmissionConfirmation(
        submission.invitation.email,
        submission.assessment.title,
        total > 0 ? ((submission.passed || 0) / total) * 100 : 0,
      );
    }

    // WebSocket notification
    const io = require("../sockets").getIO();
    io.to(`candidate-${submission.invitationId}`).emit("submission:complete", {
      submissionId: submission.id,
      passed: submission.passed,
      failed: submission.failed,
      executionTime: submission.executionTime,
    });
  }
}

module.exports = new SubmissionService();
