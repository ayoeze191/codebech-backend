const fs = require("fs").promises;

async function main() {
  const input = JSON.parse(await fs.readFile("/app/input.json", "utf8"));

  const { language, code, testCases, assessment } = input;

  let results;

  switch (language) {
    case "javascript":
      results = await require("./executors/javascript").run(
        code,
        testCases,
        assessment,
      );
      break;

    case "python":
      results = await require("./executors/python").run(
        code,
        testCases,
        assessment,
      );
      break;

    default:
      throw new Error("Unsupported language");
  }

  console.log(JSON.stringify(results));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      error: err.message,
    }),
  );
  process.exit(1);
});
