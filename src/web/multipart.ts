import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../services/errors.js";

export type SavedUpload = {
  /** The filename from the part, which may contain slashes for a folder upload. Not used as a disk path. */
  filename: string;
  contentType: string;
  size: number;
  tempPath: string;
};

export type MultipartResult = { fields: Record<string, string>; files: SavedUpload[] };

const MAX_HEADER = 16 * 1024;
const MAX_FIELD = 1024 * 1024;

function boundaryOf(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!boundary || /[\r\n]/.test(boundary) || boundary.length > 200) {
    throw new ValidationError("The upload is missing a valid multipart boundary.");
  }
  return boundary;
}

function disposition(header: string): { name: string; filename?: string; type: string } {
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(header)?.[1] ?? /(?:^|;)\s*name=([^;\s]+)/i.exec(header)?.[1] ?? "";
  const star = /filename\*=(?:UTF-8''|utf-8'')([^;\r\n]+)/i.exec(header);
  let filename = star ? safeDecode(star[1].trim()) : undefined;
  if (!filename) {
    const plain = /filename="([^"]*)"/i.exec(header)?.[1] ?? /filename=([^;\s]+)/i.exec(header)?.[1];
    if (plain) filename = plain;
  }
  const type = /^content-type:\s*([^\r\n;]+)/im.exec(header)?.[1]?.trim() || "application/octet-stream";
  return { name, filename, type };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a multipart body, writing each file to `dir` under a generated name.
 * `maxFileBytes` and `maxTotalBytes` are enforced while the bytes are still arriving.
 */
export async function readMultipart(
  source: ReadableStream<Uint8Array>,
  contentType: string,
  opts: { dir: string; maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Promise<MultipartResult> {
  const boundary = boundaryOf(contentType);
  const dashBoundary = Buffer.from(`--${boundary}`);
  const delim = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  const reader = source.getReader();
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let mode: string = "preamble";
  const fields: Record<string, string> = {};
  const files: SavedUpload[] = [];
  let total = 0;
  let fileHandle: FileHandle | null = null;
  let fileSize = 0;
  let filePath = "";
  let fieldChunks: Buffer[] = [];
  let fieldSize = 0;
  let partIsFile = false;
  let partName = "";
  let partFilename = "";
  let partType = "application/octet-stream";

  const fail = async (message: string): Promise<never> => {
    await fileHandle?.close().catch(() => {});
    throw new ValidationError(message);
  };

  const writeBody = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    total += chunk.length;
    if (total > opts.maxTotalBytes) await fail("The upload is too large. Use git or nsit to push it.");
    if (partIsFile) {
      fileSize += chunk.length;
      if (fileSize > opts.maxFileBytes) await fail("That file is too large. Use git or nsit to push it.");
      await fileHandle!.write(new Uint8Array(chunk));
    } else {
      fieldSize += chunk.length;
      if (fieldSize > MAX_FIELD) await fail("A form field in the upload is too large.");
      fieldChunks.push(chunk);
    }
  };

  const finishPart = async () => {
    if (partIsFile) {
      await fileHandle?.close();
      fileHandle = null;
      files.push({ filename: partFilename, contentType: partType, size: fileSize, tempPath: filePath });
    } else if (partName && partName !== "_csrf") {
      fields[partName] = Buffer.concat(fieldChunks).toString("utf8");
    }
    fieldChunks = [];
    fieldSize = 0;
    fileSize = 0;
  };

  const startPart = async (headerText: string) => {
    const part = disposition(headerText);
    partName = part.name;
    partType = /^[\w.+-]+\/[\w.+-]+$/.test(part.type) ? part.type : "application/octet-stream";
    partIsFile = part.filename !== undefined;
    partFilename = part.filename ?? "";
    if (partIsFile) {
      if (files.length >= opts.maxFiles) await fail(`Upload at most ${opts.maxFiles} files at once.`);
      filePath = join(opts.dir, `file-${files.length}`);
      fileHandle = await open(filePath, "w");
    }
  };

  const pump = async (chunk: Buffer | null) => {
    if (chunk && chunk.length) buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (mode !== "done") {
      if (mode === "preamble") {
        const at = buf.indexOf(dashBoundary);
        if (at === -1) {
          if (buf.length > dashBoundary.length) buf = buf.subarray(buf.length - dashBoundary.length);
          return;
        }
        buf = buf.subarray(at + dashBoundary.length);
        mode = "after";
      }
      if (mode === "after") {
        if (buf.length < 2) return;
        if (buf[0] === 45 && buf[1] === 45) {
          mode = "done";
          return;
        }
        if (buf[0] !== 13 || buf[1] !== 10) await fail("The upload was not a valid multipart body.");
        buf = buf.subarray(2);
        mode = "headers";
      }
      if (mode === "headers") {
        const at = buf.indexOf(headerEnd);
        if (at === -1) {
          if (buf.length > MAX_HEADER) await fail("A part header in the upload is too large.");
          return;
        }
        await startPart(buf.subarray(0, at).toString("utf8"));
        buf = buf.subarray(at + 4);
        mode = "data";
      }
      if (mode === "data") {
        const at = buf.indexOf(delim);
        if (at === -1) {
          const keep = delim.length - 1;
          if (buf.length > keep) {
            await writeBody(buf.subarray(0, buf.length - keep));
            buf = buf.subarray(buf.length - keep);
          }
          return;
        }
        await writeBody(buf.subarray(0, at));
        await finishPart();
        buf = buf.subarray(at + delim.length);
        mode = "after";
      }
    }
  };

  try {
    while (mode !== "done") {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await pump(Buffer.from(value));
    }
    if (mode === "data") await fail("The upload ended before the file was complete.");
    if (mode !== "done" && files.length === 0 && Object.keys(fields).length === 0) {
      await fail("The upload did not contain any files.");
    }
  } finally {
    reader.releaseLock();
    const openHandle = fileHandle as FileHandle | null;
    if (openHandle) await openHandle.close().catch(() => {});
  }
  return { fields, files };
}

/** Writes a raw request body to `dest`, stopping once `maxBytes` is passed. Returns the size. */
export async function saveRawBody(source: ReadableStream<Uint8Array> | null, dest: string, maxBytes: number): Promise<number> {
  if (!source) throw new ValidationError("The upload was empty.");
  const handle = await open(dest, "w");
  const reader = source.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new ValidationError("That file is larger than 2 GB.");
      await handle.write(value);
    }
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
  await handle.close();
  return size;
}
