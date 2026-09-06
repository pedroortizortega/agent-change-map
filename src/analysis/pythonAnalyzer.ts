import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { analysisGraphSchema, analyzeRequestSchema, type AnalysisGraph, type AnalyzeRequest } from "../protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface AnalyzerProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function analyzePython(request: AnalyzeRequest, extensionRoot: string, options: AnalyzerProcessOptions = {}): Promise<AnalysisGraph> {
  if (!isAbsolute(extensionRoot)) {
    throw new Error("Python analyzer requires an absolute extension root");
  }
  const validatedRequest = analyzeRequestSchema.parse(request);
  const analyzerPath = resolve(extensionRoot, "python", "analyzer.py");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const child = spawn("python3", [analyzerPath], { shell: false, stdio: ["pipe", "pipe", "pipe"] });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    stdoutLength += chunk.length;
    if (stdoutLength > maxOutputBytes) fail(new Error(`Python analyzer stdout exceeded ${maxOutputBytes} bytes`));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrLength += chunk.length;
    if (stderrLength > maxOutputBytes) fail(new Error(`Python analyzer stderr exceeded ${maxOutputBytes} bytes`));
  });

  const completion = new Promise<void>((complete, reject) => {
    const timer = setTimeout(() => fail(new Error(`Python analyzer timed out after ${timeoutMs}ms`)), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) complete();
      else reject(new Error(`Python analyzer exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`));
    });
  });

  child.stdin.on("error", () => { /* Process completion reports the authoritative failure. */ });
  child.stdin.end(`${JSON.stringify(validatedRequest)}\n`);
  await completion;

  const lines = Buffer.concat(stdoutChunks).toString("utf8").trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`Python analyzer returned ${lines.length} JSON-lines responses`);
  const response: unknown = JSON.parse(lines[0]);
  if (typeof response === "object" && response !== null && "error" in response) throw new Error(`Python analyzer error: ${JSON.stringify(response)}`);
  return analysisGraphSchema.parse(response);
}
