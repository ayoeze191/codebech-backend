// src/routes/submissions.test.js
const request = require("supertest");
const app = require("../app");

describe("Submissions API", () => {
  let authToken;
  let assessmentId;
  let questionId;

  beforeAll(async () => {
    // Get auth token and test data
    const loginRes = await request(app).post("/api/auth/login").send({
      email: "test@example.com",
      password: "password123",
    });
    authToken = loginRes.body.token;

    // Create test assessment
    const assessmentRes = await request(app)
      .post("/api/assessments")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        title: "Test Assessment",
        duration: 30,
        questions: [
          {
            title: "Test Question",
            description: "Write a function that adds two numbers",
            difficulty: "EASY",
            points: 10,
            testCases: [
              { input: { a: 1, b: 2 }, expectedOutput: 3 },
              { input: { a: 5, b: 3 }, expectedOutput: 8 },
            ],
          },
        ],
      });

    assessmentId = assessmentRes.body.id;
    questionId = assessmentRes.body.questions[0].id;
  });

  test("POST /api/submissions - Submit code", async () => {
    const response = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        assessmentId,
        questionId,
        language: "javascript",
        code: "function add(a, b) { return a + b; }",
      });

    expect(response.status).toBe(202);
    expect(response.body).toHaveProperty("submissionId");
    expect(response.body).toHaveProperty("status", "PENDING");
  });

  test("GET /api/submissions/:submissionId/status - Get submission status", async () => {
    // First create a submission
    const createRes = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        assessmentId,
        questionId,
        language: "javascript",
        code: "function add(a, b) { return a + b; }",
      });

    const submissionId = createRes.body.submissionId;

    const response = await request(app)
      .get(`/api/submissions/${submissionId}/status`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("id", submissionId);
    expect(response.body).toHaveProperty("status");
  });

  test("POST /api/submissions/test - Test code without submitting", async () => {
    const response = await request(app)
      .post("/api/submissions/test")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        language: "javascript",
        code: "function add(a, b) { return a + b; }",
        testCases: [{ input: { a: 1, b: 2 }, expectedOutput: 3 }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("results");
    expect(response.body.summary.passed).toBe(1);
  });

  test("GET /api/submissions/assessment/:assessmentId/leaderboard - Get leaderboard", async () => {
    const response = await request(app)
      .get(`/api/submissions/assessment/${assessmentId}/leaderboard`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("leaderboard");
    expect(Array.isArray(response.body.leaderboard)).toBe(true);
  });

  test("POST /api/submissions - Reject duplicate submission", async () => {
    // First submission
    await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        assessmentId,
        questionId,
        language: "javascript",
        code: "function add(a, b) { return a + b; }",
      });

    // Second submission (should be rejected)
    const response = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        assessmentId,
        questionId,
        language: "javascript",
        code: "function add(a, b) { return a + b + 1; }",
      });

    expect(response.status).toBe(409);
    expect(response.body).toHaveProperty("error");
  });

  test("POST /api/submissions - Reject oversized code", async () => {
    const largeCode = "a".repeat(2 * 1024 * 1024); // 2MB

    const response = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        assessmentId,
        questionId,
        language: "javascript",
        code: largeCode,
      });

    expect(response.status).toBe(413);
    expect(response.body).toHaveProperty("error");
  });
});
