const { createLogger, format, transports } = require("winston");
const { combine, timestamp, json, colorize } = format;

const logger = createLogger({
  level: "info",
  format: combine(timestamp(), json()),
  transports: [
    new transports.File({ filename: "error.log", level: "error" }),
    new transports.File({ filename: "combined.log" }),
    new transports.Console({
      format: combine(colorize(), format.simple()),
    }),
  ],
});

// Performance monitoring
const performanceMonitor = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      ip: req.ip,
    });
  });
  next();
};

module.exports = { logger, performanceMonitor };
