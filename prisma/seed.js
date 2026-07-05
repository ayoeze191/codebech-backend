require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});
async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const recruiter = await prisma.user.upsert({
    where: { email: "recruiter@codebench.test" },
    update: {},
    create: {
      email: "recruiter@codebench.test",
      password: passwordHash,
      name: "Test Recruiter",
      role: "RECRUITER",
    },
  });

  const assessment = await prisma.assessment.create({
    data: {
      title: "Backend Engineer Screen",
      description:
        "Two short exercises covering array manipulation and basic algorithmic thinking.",
      duration: 45,
      createdBy: recruiter.id,
      questions: {
        create: [
          {
            title: "Sum Two Numbers",
            description:
              "Write a function that takes two numbers, a and b, and returns their sum.",
            difficulty: "EASY",
            points: 10,
            order: 0,
            testCases: {
              create: [
                {
                  input: { a: 1, b: 2 },
                  expectedOutput: 3,
                  isHidden: false,
                  order: 0,
                },
                {
                  input: { a: -5, b: 5 },
                  expectedOutput: 0,
                  isHidden: false,
                  order: 1,
                },
                {
                  input: { a: 100, b: 250 },
                  expectedOutput: 350,
                  isHidden: true,
                  order: 2,
                },
                {
                  input: { a: 0, b: 0 },
                  expectedOutput: 0,
                  isHidden: true,
                  order: 3,
                },
              ],
            },
          },
          {
            title: "Find the Maximum",
            description:
              "Write a function that takes an array of integers and returns the largest value in the array.",
            difficulty: "MEDIUM",
            points: 20,
            order: 1,
            testCases: {
              create: [
                {
                  input: { nums: [1, 5, 3] },
                  expectedOutput: 5,
                  isHidden: false,
                  order: 0,
                },
                {
                  input: { nums: [-10, -3, -7] },
                  expectedOutput: -3,
                  isHidden: false,
                  order: 1,
                },
                {
                  input: { nums: [42] },
                  expectedOutput: 42,
                  isHidden: true,
                  order: 2,
                },
                {
                  input: { nums: [8, 8, 2, 8, -1] },
                  expectedOutput: 8,
                  isHidden: true,
                  order: 3,
                },
              ],
            },
          },
        ],
      },
    },
    include: { questions: { include: { testCases: true } } },
  });
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
