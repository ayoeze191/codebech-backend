const fs = require("fs").promises;
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

exports.run = async (code, testCases) => {
  await fs.writeFile("/app/solution.py", code);

  // Python execution logic goes here

  return [];
};
