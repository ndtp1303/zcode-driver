import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class RunLog {
  constructor(dir, { append = false } = {}) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, "run.jsonl");
    this.errPath = join(dir, "run.err");
    this.finalPath = join(dir, "final.txt");
    this.metaPath = join(dir, "meta.json");
    if (!append) {
      writeFileSync(this.jsonlPath, "");
      writeFileSync(this.errPath, "");
      writeFileSync(this.finalPath, "");
    }
  }

  event(record) {
    appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`);
  }

  err(line) {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    appendFileSync(this.errPath, text);
  }

  final(text) {
    const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
    writeFileSync(this.finalPath, body);
  }

  meta(record) {
    writeFileSync(this.metaPath, `${JSON.stringify(record)}\n`);
  }

  prompt(text) {
    writeFileSync(join(this.dir, "prompt.txt"), text.endsWith("\n") ? text : `${text}\n`);
  }
}

export function redact(value, secrets) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  return text;
}

export function summarizeFrame(text, limit = 32_000) {
  const truncated = text.length > limit;
  const slice = truncated ? text.slice(0, limit) : text;
  if (!truncated) {
    try {
      return { message: JSON.parse(text), truncated: false };
    } catch {
      // keep the raw text below
    }
  }
  return { text: slice, truncated };
}
