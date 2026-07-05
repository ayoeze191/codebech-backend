const { submissionQueue } = require("../services/queueServices");
const dockerSandbox = require("../services/dockerService");
const prisma = require("../config/database");
const { getIO } = require("../sockets");

async function executeCode(job) {
  const { submissionId, code, language, questionId } = job.data;

  try {
    const testCases = await prisma.testCase.findMany({
      where: { questionId },
      orderBy: {
        order: "asc",
      },
    });

    await prisma.submission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: "RUNNING",
      },
    });

    const results = await dockerSandbox.executeCode({
      code,
      language,
      testCases,
    });

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const score = (passed / results.length) * 100;

    const submission = await prisma.submission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: "COMPLETED",
        passed,
        failed,
        results,
        executionTime: results.reduce((sum, r) => sum + r.executionTime, 0),
        memoryUsed: results.reduce((sum, r) => sum + r.memoryUsed, 0),
      },
    });

    getIO()
      .to(`candidate-${submission.invitationId}`)
      .emit("submission:result", {
        submissionId,
        score,
        passed,
        failed,
        results,
      });

    return {
      submissionId,
      score,
    };
  } catch (err) {
    await prisma.submission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: "FAILED",
      },
    });

    throw err;
  }
}

submissionQueue.process("execute code", 5, executeCode);

console.log("Code Execution Worker Started...");

module.exports = {
  executeCode,
};
