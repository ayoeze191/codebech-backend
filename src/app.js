require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const http = require("http");
const { logger, performanceMonitor } = require("./config/monitoring");
// const { limiter } = require("./middleware/rateLimiter");
const { initializeSocket } = require("./socket/index");

const app = express();
const server = http.createServer(app);

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for WebSocket
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(compression());
app.use(
  cors({
    // `credentials: true` cannot be combined with a wildcard origin in browsers.
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
      : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(performanceMonitor);

// Health check endpoint (for Render)
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    pid: process.pid,
  });
});

// Rate limiting
// app.use("/api", limiter);

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/assessments", require("./routes/assessments"));
app.use("/api/submissions", require("./routes/submissions"));
app.use("/api/candidates", require("./routes/candidates"));
app.use("/api/invitations", require("./routes/invitations"));

// Bull Board for queue monitoring (optional)
if (process.env.NODE_ENV === "production") {
  try {
    const { createBullBoard } = require("@bull-board/api");
    const { BullAdapter } = require("@bull-board/api/bullAdapter");
    const { ExpressAdapter } = require("@bull-board/express");

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");

    const { submissionQueue } = require("./services/queueServices");
    createBullBoard({
      queues: [new BullAdapter(submissionQueue)],
      serverAdapter,
    });
    app.use("/admin/queues", serverAdapter.getRouter());
  } catch (error) {
    logger.warn("Bull Board disabled:", error.message);
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// Initialize WebSocket
initializeSocket(server);

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, process.env.HOST || "0.0.0.0", () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV}`);
    logger.info(`PID: ${process.pid}`);
  });
}

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

module.exports = app;
module.exports.app = app;
module.exports.server = server;
