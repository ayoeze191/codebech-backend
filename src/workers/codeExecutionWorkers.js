const { submissionQueue } = require("../services/queueServices");
const dockerSandbox = require("../services/dockerService");
const prisma = require("../config/database");

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

    const execution = await dockerSandbox.executeCode({
      code,
      language,
      testCases,
    });
    if (!Array.isArray(execution) && execution.status === "ERROR") {
      throw new Error(execution.error || "Code execution failed");
    }
    const results = Array.isArray(execution) ? execution : execution.results || [];

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const score = results.length ? (passed / results.length) * 100 : 0;

    const submission = await prisma.submission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: "COMPLETED",
        passed,
        failed,
        results,
        executionTime: execution.executionTime || results.reduce((sum, r) => sum + (r.executionTime || 0), 0),
        memoryUsed: execution.memoryUsed || results.reduce((sum, r) => sum + (r.memoryUsed || 0), 0),
      },
    });

    return {
      submissionId,
      invitationId: submission.invitationId,
      passed,
      failed,
      executionTime: submission.executionTime,
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
