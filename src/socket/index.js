const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const prisma = require("../config/database");
let io;
const assessmentRoom = (id) => `assessment-${id}`;
const invitationRoom = (id) => `invitation-${id}`;
const RECRUITER_ROLES = ["RECRUITER", "ADMIN"];

const suspiciousEvents = new Set([
  "TAB_SWITCH",
  "WINDOW_BLUR",
  "COPY",
  "PASTE",
]);
const MAX_METADATA_BYTES = 5000;

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL,
      methods: ["GET", "POST"],
    },
  });

  io.use(async (socket, next) => {
    try {
      const { token, invitationToken } = socket.handshake.auth;

      // Recruiter / Admin
      if (token) {
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        socket.role = payload.role;
        socket.userId = payload.userId;

        return next();
      }

      // Candidate
      if (invitationToken) {
        const invitation = await prisma.invitation.findUnique({
          where: { token: invitationToken },
        });

        if (!invitation) {
          return next(new Error("Invalid invitation."));
        }
        if (invitation.status === "REVOKED") {
          return next(new Error("Invitation revoked."));
        }
        if (new Date() > invitation.expiresAt) {
          return next(new Error("Invitation expired."));
        }

        socket.role = "CANDIDATE";
        socket.invitationId = invitation.id;
        socket.assessmentId = invitation.assessmentId;
        socket.candidateEmail = invitation.email;

        return next();
      }

      return next(new Error("Authentication required."));
    } catch (err) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    console.log(
      `[CONNECTED] ${socket.role} ${
        socket.role === "CANDIDATE" ? socket.invitationId : socket.userId
      }`,
    );

    /**
     * Candidate joins assessment
     */
    socket.on("candidate:join", () => {
      if (socket.role !== "CANDIDATE") return;
      socket.join(assessmentRoom(socket.assessmentId));
      socket.join(invitationRoom(socket.invitationId));

      io.to(assessmentRoom(socket.assessmentId)).emit("candidate:connected", {
        invitationId: socket.invitationId,
        assessmentId: socket.assessmentId,
        email: socket.candidateEmail,
        timestamp: new Date(),
      });
    });

    /**
     * Recruiter/Admin joins monitor room — ownership-checked
     */
    socket.on("recruiter:join", async ({ assessmentId }) => {
      if (!RECRUITER_ROLES.includes(socket.role)) return;
      if (!assessmentId) return;

      try {
        const assessment = await prisma.assessment.findUnique({
          where: { id: assessmentId },
          select: { createdBy: true },
        });

        if (!assessment) return;
        if (socket.role !== "ADMIN" && assessment.createdBy !== socket.userId) {
          return; // silently refuse — don't leak whether the assessment exists
        }

        socket.join(assessmentRoom(assessmentId));
        console.log(`[RECRUITER] ${socket.userId} joined ${assessmentId}`);
      } catch (err) {
        console.error("recruiter:join error:", err);
      }
    });

    /**
     * Browser events
     */
    socket.on("candidate:event", async (event) => {
      if (socket.role !== "CANDIDATE") return;
      if (!event || typeof event.type !== "string") return;

      try {
        let eventType = "UNKNOWN";

        switch (event.type) {
          case "visibilitychange":
            eventType = event.hidden ? "TAB_SWITCH" : "TAB_RETURN";
            break;
          case "blur":
            eventType = "WINDOW_BLUR";
            break;
          case "focus":
            eventType = "WINDOW_FOCUS";
            break;
          case "copy":
            eventType = "COPY";
            break;
          case "paste":
            eventType = "PASTE";
            break;
          case "fullscreen_exit":
            eventType = "FULLSCREEN_EXIT";
            break;
          default:
            eventType = event.type;
        }

        const metadataStr = JSON.stringify(event);
        if (Buffer.byteLength(metadataStr, "utf8") > MAX_METADATA_BYTES) {
          return; // drop oversized payloads rather than storing them
        }

        await prisma.candidateEvent.create({
          data: {
            invitationId: socket.invitationId,
            sessionId: socket.id,
            eventType,
            metadata: event,
          },
        });

        if (suspiciousEvents.has(eventType)) {
          io.to(assessmentRoom(socket.assessmentId)).emit(
            "candidate:suspicious",
            {
              invitationId: socket.invitationId,
              eventType,
              metadata: event,
              timestamp: new Date(),
            },
          );
        }
      } catch (err) {
        console.error("candidate:event error:", err);
      }
    });

    /**
     * Typing indicator
     */
    socket.on("candidate:typing", ({ questionId } = {}) => {
      if (socket.role !== "CANDIDATE") return;

      socket.to(assessmentRoom(socket.assessmentId)).emit("candidate:typing", {
        invitationId: socket.invitationId,
        questionId,
        timestamp: new Date(),
      });
    });

    /**
     * Live code updates
     */
    socket.on("candidate:codeChange", ({ questionId, code } = {}) => {
      if (socket.role !== "CANDIDATE") return;

      socket
        .to(assessmentRoom(socket.assessmentId))
        .emit("candidate:codeChange", {
          invitationId: socket.invitationId,
          questionId,
          code,
          timestamp: new Date(),
        });
    });

    /**
     * Candidate submitted
     */
    socket.on("candidate:submitted", ({ questionId } = {}) => {
      if (socket.role !== "CANDIDATE") return;

      io.to(assessmentRoom(socket.assessmentId)).emit("candidate:submitted", {
        invitationId: socket.invitationId,
        questionId,
        timestamp: new Date(),
      });
    });

    /**
     * Disconnect
     */
    socket.on("disconnect", () => {
      if (socket.role !== "CANDIDATE") return;

      io.to(assessmentRoom(socket.assessmentId)).emit(
        "candidate:disconnected",
        {
          invitationId: socket.invitationId,
          assessmentId: socket.assessmentId,
          timestamp: new Date(),
        },
      );
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
};

module.exports = {
  initializeSocket,
  getIO,
};
