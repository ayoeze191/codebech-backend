const express = require("express");
const router = express.Router();
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");
const { addSubmissionJob } = require("../services/queueServices");
const EmailService = require("../services/emailService");
const CodeExecutionService = require("../services/executionService");
const crypto = require("crypto");

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

module.exports = router;

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

router.post(
  "/:id/resend",
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
