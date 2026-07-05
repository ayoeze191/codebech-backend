const express = require("express");
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const EmailService = require("./../services/emailService");
const crypto = require("crypto");
const router = express.Router();

router.get("/me", authMiddleware, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
  });
});

router.get(
  "/",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const candidates = await prisma.user.findMany({
      where: { role: "CANDIDATE" },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(candidates);
  },
);

router.get(
  "/:id/events",
  authMiddleware,
  roleMiddleware(["ADMIN", "RECRUITER"]),
  async (req, res) => {
    const events = await prisma.candidateEvent.findMany({
      where: { invitationId: req.params.invitationId },
      orderBy: { timestamp: "desc" },
      take: 100,
    });

    res.json(events);
  },
);

router.get("/test", (req, res) => {
  res.send("Candidates router is working");
});
module.exports = router;
