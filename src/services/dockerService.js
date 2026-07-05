const Docker = require("dockerode");
const docker = new Docker();
const path = require("path");
const tar = require("tar-stream");
const { PassThrough } = require("stream");

class DockerSandbox {
  constructor() {
    this.imageName = "code-runner-sandbox";
    this.timeout = 10000; // 10 seconds
    this.memoryLimit = 256 * 1024 * 1024; // 256MB
  }

  async buildSandboxImage() {
    const dockerfilePath = path.join(__dirname, "../../docker/sandbox");
    const stream = await docker.buildImage(
      { context: dockerfilePath, src: ["Dockerfile"] },
      { t: this.imageName },
    );
    return new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, res) => {
        err ? reject(err) : resolve(res);
      });
    });
  }

  async executeCode({ code, language, testCases, assessment }) {
    const pack = tar.pack();
    console.log("Creating container");
    const container = await docker.createContainer({
      Image: this.imageName,
      Cmd: ["node", "runner.js"],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Memory: this.memoryLimit,
        PidsLimit: 64, // Limit the number of processes
        MemorySwap: this.memoryLimit,
        CpuPeriod: 100000,
        CpuQuota: 50000, // 0.5 CPU
        NetworkMode: "none", // No network access
        SecurityOpt: ["no-new-privileges:true"],
      },
      WorkingDir: "/app",
      Env: [`LANGUAGE=${language}`, `TIMEOUT=${this.timeout}`],
    });
    console.log("Container created");

    // Copy code and test cases into container
    pack.entry(
      { name: "input.json" },
      JSON.stringify({
        code,
        language,
        testCases,
        assessment,
      }),
    );
    pack.finalize();

    await container.putArchive(pack, {
      path: "/app",
    });

    try {
      return await this.waitForContainer(container);
    } finally {
      try {
        await container.remove({ force: true });
      } catch {}
    }
  }

  /**
   * Streams the container's live stats (docker stats-style JSON objects,
   * newline-delimited) and keeps the highest memory_stats.usage value seen.
   * The stats stream ends on its own once the container exits, so this
   * just resolves with whatever peak it tracked — no manual stop() needed.
   * Resolves 0 instead of rejecting on any stats error, since a missing
   * memory reading should never fail the whole submission.
   */
  async trackPeakMemory(container) {
    let peak = 0;
    let buffer = "";

    try {
      const stream = await container.stats({ stream: true });

      return new Promise((resolve) => {
        stream.on("data", (chunk) => {
          buffer += chunk.toString();
          let boundary;
          while ((boundary = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);
            if (!line) continue;
            try {
              const stat = JSON.parse(line);
              const usage = stat?.memory_stats?.usage;
              if (typeof usage === "number" && usage > peak) {
                peak = usage;
              }
            } catch {
              // ignore a malformed stats line, keep reading
            }
          }
        });
        stream.on("end", () => resolve(peak));
        stream.on("error", () => resolve(peak));
      });
    } catch {
      return 0;
    }
  }

  async waitForContainer(container) {
    const startedAt = Date.now();

    return new Promise(async (resolve, reject) => {
      const timeoutHandle = setTimeout(async () => {
        try {
          await container.kill();
          reject(new Error("Execution timeout"));
        } catch (err) {
          reject(err);
        }
      }, this.timeout);

      try {
        const stream = await container.attach({
          stream: true,
          stdout: true,
          stderr: true,
        });

        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        let stdout = "";
        let stderr = "";

        stdoutStream.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        stderrStream.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        docker.modem.demuxStream(stream, stdoutStream, stderrStream);
        console.log("Starting container");
        await container.start();
        console.log("Container started");

        // Start tracking memory only once the container is actually
        // running — kick this off but don't await it yet, it resolves
        // on its own when the container exits.
        console.log("Starting memory tracking");
        // const memoryPromise = this.trackPeakMemory(container);

        console.log("Waiting for container");
        await container.wait();

        console.log("Container exited");

        clearTimeout(timeoutHandle);

        const executionTime = Date.now() - startedAt;
        // const memoryUsed = await memoryPromise;
        // console.log("Memory finished");

        let parsed;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch (err) {
          reject(new Error(`Invalid JSON:\n${stdout}\n\nstderr:\n${stderr}`));
          return;
        }

        // Normalize whatever the runner/executor produced into the shape
        // routes/assessments.js expects: { results, status, executionTime,
        // memoryUsed }. Executors may return a bare array of test-case
        // verdicts, or already return { results, ... } — handle both so a
        // shape change in one file doesn't silently break the other.
        if (parsed && parsed.error) {
          resolve({
            results: [],
            status: "ERROR",
            error: parsed.error,
            // executionTime,
            // memoryUsed,
          });
          return;
        }

        const results = Array.isArray(parsed) ? parsed : parsed.results;

        if (!Array.isArray(results)) {
          reject(
            new Error(`Runner output missing a results array. Got:\n${stdout}`),
          );
          return;
        }

        resolve({
          results,
          status: parsed.status ?? "COMPLETED",
          executionTime: parsed.executionTime ?? executionTime,
          // memoryUsed: parsed.memoryUsed ?? memoryUsed,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        reject(err);
      }
    });
  }
}

module.exports = new DockerSandbox();
