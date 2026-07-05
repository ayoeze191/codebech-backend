const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redis = require("../config/redis");

const useRedisStore = process.env.NODE_ENV !== "test";

const createStore = () =>
  useRedisStore
    ? new RedisStore({
        sendCommand: (...args) => redis.sendCommand(args),
      })
    : undefined;
// General API rate limiter
const limiter = rateLimit({
  store: createStore(),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: "Too many requests from this IP, please try again later",
});

// Submission rate limiter
const submissionLimiter = rateLimit({
  store: createStore(),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: "Submission limit exceeded. Please wait before submitting again.",
  handler: (req, res) => {
    console.log("Submission limiter fired!");
    return res.status(429).json({
      error: "Submission limit exceeded",
    });
  },
});

module.exports = { limiter, submissionLimiter };
