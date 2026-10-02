// Durable, lease-generation-scoped launch intent. No work starts before its ticket exists.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const active = new Set();

function executionDir(slotDir, owner) {
  return path.join(slotDir, `.execution-${owner.token}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function executionBusy(slotDir, owner) {
  const dir = executionDir(slotDir, owner);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (error) {
    return error.code !== 'ENOENT';
  }
  for (const entry of entries) {
    if (entry === 'released') continue;
    try {
      const ticket = readJson(path.join(dir, entry));
      // Pending/partial writes, foreign platforms and permission errors fail closed.
      if (ticket.token !== owner.token || ticket.platform === 'win32'
        || !Number.isInteger(ticket.pgid) || ticket.pgid <= 0) return true;
      try { process.kill(-ticket.pgid, 0); return true; } catch (error) {
        if (error.code !== 'ESRCH') return true;
      }
    } catch (_) { return true; }
  }
  // A live Node descendant can register a detached child just before its own
  // group exits. Do not accept a directory snapshot taken before that registration.
  try { return JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify(entries.sort()); }
  catch (_) { return true; }
}

function wasReleased(slotDir, owner) {
  if (owner.version !== 1 || owner.hostname !== os.hostname()
    || typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner.token)) return false;
  try {
    return fs.readFileSync(path.join(executionDir(slotDir, owner), 'released'), 'utf8') === owner.token;
  } catch (_) { return false; }
}

function registerExecutionSlot(slotDir, owner) {
  const entry = { slotDir, owner };
  active.add(entry);
  return {
    stop() { active.delete(entry); },
    deferRelease() {
      const dir = executionDir(slotDir, owner);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'released'), owner.token);
    },
  };
}

function createTickets(contexts) {
  return contexts.map(({ dir, token, id }) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ token, platform: process.platform }), { flag: 'wx' });
    return file;
  });
}

function recordGroup(files, pgid) {
  for (const file of files) {
    const ticket = readJson(file);
    // A torn write also fails closed; work never precedes creation of the intent.
    fs.writeFileSync(file, JSON.stringify({ ...ticket, pgid }));
  }
}

function managedInvocation(command, args, options = {}) {
  if (!active.size) return { command, args, options };
  const contexts = [...active].map(({ slotDir, owner }) => ({
    dir: executionDir(slotDir, owner), token: owner.token, id: randomUUID(), pid: owner.pid,
  }));
  const tickets = createTickets(contexts);
  return {
    command: process.execPath,
    args: [require.resolve('./heavy-worker'), JSON.stringify({ tickets, contexts }), command, ...args],
    options: { ...options, detached: process.platform !== 'win32' },
    launchError() {
      try {
        const error = readJson(tickets[0]).launchError;
        return error ? Object.assign(new Error(error.message), { code: error.code }) : null;
      } catch (_) { return null; }
    },
    complete(success) {
      // Windows has no kill(-pgid, 0). Only ordinary successful completion observed
      // by the original live orchestrator can clear this invocation's tickets.
      if (process.platform !== 'win32' || !success) return;
      for (const context of contexts) {
        if (context.pid !== process.pid) continue;
        for (const entry of fs.readdirSync(context.dir)) {
          if (entry.startsWith(`${context.id}-`)) fs.unlinkSync(path.join(context.dir, entry));
        }
      }
    },
  };
}

module.exports = { executionBusy, wasReleased, registerExecutionSlot, managedInvocation, createTickets, recordGroup };
