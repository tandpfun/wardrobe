import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const HOST = hostname();
const WAIT_LIMIT_MS = 10000;

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try { await rename(temporary, file); }
    catch (error) {
      // Windows can refuse to replace a file another process has open.
      if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) throw error;
      await copyFile(temporary, file);
    }
  } finally { await rm(temporary, { force: true }); }
}

async function readOwner(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsDead(owner) {
  if (owner?.hostname !== HOST || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.owner !== "string") return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function releaseOwnedLock(file, owner) {
  const current = await readOwner(file);
  if (current?.owner === owner.owner && current.pid === owner.pid && current.hostname === owner.hostname) {
    await rm(file, { force: true });
  }
}

async function createLock(file) {
  const handle = await open(file, "wx");
  const owner = { pid: process.pid, owner: randomUUID(), hostname: HOST, createdAt: new Date().toISOString() };
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); }
  catch (error) { await handle.close(); await rm(file, { force: true }); throw error; }
  return { handle, owner };
}

async function recoverDeadLock(file, deadline, depth = 0) {
  if (Date.now() >= deadline || depth >= 16) return;
  const abandoned = await readOwner(file);
  if (!processIsDead(abandoned)) return;
  // One recovery at a time prevents another recovering process from deleting a
  // newly acquired live lock after it inspected the old abandoned owner.
  const recoveryFile = `${file}.recovery`;
  let recovery;
  try { recovery = await createLock(recoveryFile); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A recovery process can itself terminate. Reclaim its dead claim under
    // another exclusive claim using the same ownership/liveness checks.
    await recoverDeadLock(recoveryFile, deadline, depth + 1);
    return;
  }
  try {
    const current = await readOwner(file);
    if (current?.owner === abandoned.owner && current.pid === abandoned.pid && processIsDead(current)) {
      await rm(file, { force: true });
    }
  } finally {
    await recovery.handle.close();
    await releaseOwnedLock(recoveryFile, recovery.owner);
  }
}

// Share this lock between the web API and the deterministic agent importer.
// Unknown, remote-host and live-process locks are deliberately never removed.
export async function withLibraryLock(libraryFile, operation) {
  const directory = path.dirname(path.resolve(libraryFile));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".library.lock");
  const deadline = Date.now() + WAIT_LIMIT_MS;
  let lock;
  while (!lock) {
    try { lock = await createLock(file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await recoverDeadLock(file, deadline);
      if (Date.now() >= deadline) throw Object.assign(new Error("The wardrobe is being updated. Please try again."), { status: 409 });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); }
  finally { await lock.handle.close(); await releaseOwnedLock(file, lock.owner); }
}
