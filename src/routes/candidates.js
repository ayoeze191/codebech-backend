const express = require("express");
const { authMiddleware, roleMiddleware } = require("../middleware/auth");
const prisma = require("../config/database");

const router = express.Router();

router.get("/:invitationId/events", authMiddleware, roleMiddleware(["RECRUITER", "ADMIN"]), async (req, res) => {
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: req.params.invitationId },
      include: { assessment: { select: { createdBy: true } } },
    });
    if (!invitation) return res.status(404).json({ error: "Candidate invitation not found." });
    if (req.user.role !== "ADMIN" && invitation.assessment.createdBy !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    const events = await prisma.candidateEvent.findMany({ where: { invitationId: invitation.id }, orderBy: { timestamp: "desc" } });
    res.json(events);
  } catch (error) {
    console.error("List candidate events error:", error);
    res.status(500).json({ error: "Failed to fetch candidate events." });
  }
});

module.exports = router;
