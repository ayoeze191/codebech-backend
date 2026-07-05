const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../config/database");
const router = express.Router();

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}
const JWT_SECRET = process.env.JWT_SECRET || "development-secret";

const SELF_REGISTERABLE_ROLES = ["RECRUITER"];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

const DUMMY_HASH =
  "$2a$10$CwTycUXWue0Thq9StjUM0uJ8Q4wZeK5A6UM/ZgXtb9qzS9r/9d7Iq";

const signToken = (user) =>
  jwt.sign(
    { userId: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});

router.post("/logout", (req, res) => {
  res.status(200).json({ message: "Logged out successfully" });
});

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, role = "RECRUITER" } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    if (!SELF_REGISTERABLE_ROLES.includes(role)) {
      return res.status(403).json({
        error: `Cannot self-register with role '${role}'`,
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        password: passwordHash,
        name: name?.trim() || null,
        role,
      },
    });

    res.status(201).json({ user: publicUser(user), token: signToken(user) });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("Register error:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    const passwordToCheck = user ? user.password : DUMMY_HASH;
    const passwordValid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !passwordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({ user: publicUser(user), token: signToken(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Failed to login" });
  }
});

module.exports = router;
