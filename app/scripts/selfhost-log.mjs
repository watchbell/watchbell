// The quiet start of the npm package (bin/watchbell.mjs, 1.2.2): loaded with `node --import` in front of the
// standalone server.js, it sends everything the server prints (the Next.js banner, the collector's step lines, the
// scheduler's notes) to <WATCHBELL_HOME>/logs/watchbell.log instead of the terminal. Past LOG_MAX_BYTES the file
// becomes watchbell.log.1 (the older .1 goes) and a new one starts, so the folder holds at most about two files of
// 5 MB. While the CLI's menu is attached (an IPC channel), the first line of each message on stderr goes to it too, so
// an error still reaches the screen as one line. Node built-ins only; nothing happens on import without
// WATCHBELL_LOG_FILE, so the tests can import it.
import fs from "node:fs";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Moves `file` to `file.1` (replacing an older one) when it is `maxBytes` or more. Never throws. */
export function rotateLog(file, { maxBytes = LOG_MAX_BYTES, fsImpl = fs } = {}) {
  try {
    if (fsImpl.statSync(file).size < maxBytes) return false;
    fsImpl.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // no file yet, or it can't be moved: the writer keeps appending
  }
}

/**
 * An append-only writer for `file` that rotates before a write would take it past `maxBytes`. A failed write (full
 * disk, a folder that went away) is dropped: the log must never stop the server.
 */
export function rotatingWriter(file, { maxBytes = LOG_MAX_BYTES, fsImpl = fs } = {}) {
  let fd = null;
  let size = 0;
  const open = () => {
    fd = fsImpl.openSync(file, "a", 0o600);
    size = fsImpl.fstatSync(fd).size;
  };
  const close = () => {
    if (fd === null) return;
    try {
      fsImpl.closeSync(fd);
    } catch {
      // already gone
    }
    fd = null;
  };
  const write = (buf) => {
    try {
      if (fd === null) open();
      if (size > 0 && size + buf.length > maxBytes) {
        close();
        // The CLI writes a few lines of its own into the same file, so the size is checked again on disk.
        if (!rotateLog(file, { maxBytes: 0, fsImpl })) fsImpl.truncateSync(file, 0);
        open();
      }
      fsImpl.writeSync(fd, buf);
      size += buf.length;
    } catch {
      close();
    }
  };
  write.close = close;
  return write;
}

/** The first non-empty line of a chunk written to stderr, at most 300 characters; null for an empty chunk. */
export function firstLine(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line ? line.slice(0, 300) : null;
}

/**
 * Sends process.stdout and process.stderr to the rotating log. `proc` is the process (tests pass a stand-in with
 * stdout, stderr, send and connected). Returns a function that puts the streams back.
 */
export function installLogFile({ file, maxBytes = LOG_MAX_BYTES, proc = process, fsImpl = fs }) {
  const write = rotatingWriter(file, { maxBytes, fsImpl });
  const toCli = (text) => {
    // Only while the CLI's menu listens: after "Keep running in the background" the channel is gone.
    if (typeof proc.send !== "function" || !proc.connected) return;
    const line = firstLine(text);
    if (!line) return;
    try {
      proc.send({ watchbell: "error", line }, () => {}); // with a callback: a closed channel is no 'error' event
    } catch {
      // the CLI went away mid-send
    }
  };
  const restore = [];
  for (const [stream, isErr] of [
    [proc.stdout, false],
    [proc.stderr, true],
  ]) {
    if (!stream) continue;
    const original = stream.write;
    stream.write = (chunk, encoding, cb) => {
      const done = typeof encoding === "function" ? encoding : cb;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk);
      write(buf);
      if (isErr) toCli(buf.toString("utf8"));
      if (typeof done === "function") process.nextTick(done);
      return true;
    };
    restore.push(() => {
      stream.write = original;
    });
  }
  return () => {
    for (const r of restore.splice(0)) r();
    write.close();
  };
}

// Only in front of the server: the CLI imports this file too (rotateLog), and its own output must stay on the screen.
const file = process.env.WATCHBELL_LOG_FILE?.trim();
const inFrontOfServer = /(^|[\\/])server\.js$/.test(process.argv[1] ?? "");
if (file && inFrontOfServer) installLogFile({ file, maxBytes: Number(process.env.WATCHBELL_LOG_MAX_BYTES) || LOG_MAX_BYTES });
