const dockerSandbox = require("./dockerService");

class ExecutionService {
  async executeCode({
    code,
    language = "javascript",
    testCases = [],
    assessment,
  }) {
    if (!code) {
      throw new Error("Code is required");
    }

    if (!Array.isArray(testCases)) {
      throw new Error("Test cases must be an array");
    }

    return dockerSandbox.executeCode({
      code,
      language,
      testCases,
      assessment,
    });
  }
}

module.exports = new ExecutionService();
