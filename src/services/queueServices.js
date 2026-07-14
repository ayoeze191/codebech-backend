const Bull = require("bull");
const { logger } = require("../config/monitoring");
const submissionService = require("./submissionService");
const prisma = require("../config/database");
const queueEnabled = process.env.NODE_ENV !== "test";

const createTestQueue = () => ({
  async add(name, data) {
    return {
      id: data.submissionId,
      data,
      queuePosition: async () => 0,
      attemptsMade: 0,
      progress: () => 0,
    };
  },
  async getJob() {
    return null;
  },
  process() {},
  on() {},
  async clean() {},
});

const submissionQueue = queueEnabled
  ? new Bull("submission queue", {
      redis: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
        password: process.env.REDIS_PASSWORD,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        timeout: 30000,
        removeOnComplete: true,
        removeOnFail: false,
      },
    })
  : createTestQueue();

// Add job with better error handling
const addSubmissionJob = async (submissionData) => {
  try {
    const job = await submissionQueue.add("execute code", submissionData, {
      jobId: submissionData.submissionId,
      priority: 10,
      attempts: 3,
    });

    logger.info(
      `Job ${job.id} added to queue for submission ${submissionData.submissionId}`,
    );
    return job;
  } catch (error) {
    logger.error("Failed to add job to queue:", error);
    throw error;
  }
};

// Event listeners
submissionQueue.on("completed", (job, result) => {
  logger.info(
    `Job ${job.id} completed for submission ${job.data.submissionId}`,
  );

  // Emit WebSocket update
  try {
    const io = require("../sockets").getIO();
    io.to(`invitation-${result.invitationId}`).emit("submission:result", {
      submissionId: job.data.submissionId,
      passed: result.passed,
      failed: result.failed,
      executionTime: result.executionTime,
      status: "COMPLETED",
    });
  } catch (error) {
    // A dedicated worker has no Socket.IO server. Persisted results remain
    // authoritative and the candidate UI polls them while execution runs.
    logger.debug("Socket notification skipped:", error.message);
  }
});

submissionQueue.on("failed", (job, error) => {
  logger.error(
    `Job ${job.id} failed for submission ${job.data.submissionId}:`,
    error,
  );

  // Update submission status to FAILED
  prisma.submission
    .update({
      where: { id: job.data.submissionId },
      data: {
        status: "FAILED",
        results: { error: error.message },
      },
    })
    .catch((err) => logger.error("Failed to update submission status:", err));
});

submissionQueue.on("stalled", (job) => {
  logger.warn(`Job ${job.id} stalled for submission ${job.data.submissionId}`);
});

// Clean up old jobs periodically
const cleanOldJobs = async () => {
  try {
    await submissionQueue.clean(7 * 24 * 60 * 60 * 1000, "completed"); // 7 days
    await submissionQueue.clean(7 * 24 * 60 * 60 * 1000, "failed");
    logger.info("Cleaned old jobs from queue");
  } catch (error) {
    logger.error("Failed to clean old jobs:", error);
  }
};

// Run cleanup every day
if (queueEnabled) {
  setInterval(cleanOldJobs, 24 * 60 * 60 * 1000);
}

module.exports = { submissionQueue, addSubmissionJob };
