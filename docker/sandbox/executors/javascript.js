const fs = require("fs").promises;

exports.run = async (code, testCases) => {
  // Save candidate's solution
  await fs.writeFile("/app/solution.js", code);

  // Clear require cache
  delete require.cache[require.resolve("/app/solution.js")];

  // Load candidate's module
  const exported = require("/app/solution.js");
  let candidate;
  if (typeof exported === "function") {
    candidate = exported;
  } else if (typeof exported.solve === "function") {
    candidate = exported.solve;
  } else if (typeof exported.default === "function") {
    candidate = exported.default;
  } else {
    throw new Error(
      "No function exported. Please export your solution using module.exports.",
    );
  }

  const results = [];
  for (const [index, testCase] of testCases.entries()) {
    const start = Date.now();
    try {
      let output;
      if (Array.isArray(testCase.input)) {
        output = await candidate(...testCase.input);
      } else if (testCase.input && typeof testCase.input === "object") {
        output = await candidate(...Object.values(testCase.input));
      } else {
        output = await candidate(testCase.input);
      }
      results.push({
        id: testCase.id,
        testCase: index + 1,
        passed:
          JSON.stringify(output) === JSON.stringify(testCase.expectedOutput),
        output,
        expected: testCase.expectedOutput,
        executionTime: Date.now() - start,
      });
    } catch (err) {
      results.push({
        id: testCase.id,
        testCase: index + 1,
        passed: false,
        error: err.message,
        executionTime: Date.now() - start,
      });
    }
  }
  return results;
};
