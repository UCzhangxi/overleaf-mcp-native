import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { saveStored } from "../../src/auth/cookieStore.js";
import { clearIdentity } from "../../src/session/identity.js";
import { ensureSocketForProject, applyOtUpdate, disconnectActive } from "../../src/api/socket.js";
import { ensureDocLoaded, clearDocCache } from "../../src/session/docCache.js";

test("lost OT acknowledgement never replays; the next read reconciles server state", async () => {
  const state = await mkdtemp(path.join(process.cwd(), ".lost-ack-"));
  const previous = { root: process.env.XDG_CONFIG_HOME, base: process.env.OL_BASE_URL };
  let mutations = 0;
  const server = createServer((req, res) => {
    res.end(req.url?.startsWith("/socket.io/") ? "fixture:60:60:websocket" :
      '<meta name="ol-user_id" content="fixture"><meta name="ol-csrfToken" content="fixture">');
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", ws => {
    ws.send('5:::{"name":"joinProjectResponse","args":[{"project":{"_id":"fixture-project"}}]}');
    ws.on("message", bytes => {
      const match = bytes.toString().match(/^5:(\d+)\+::(.*)$/);
      if (!match) return;
      const event = JSON.parse(match[2]);
      if (event.name === "applyOtUpdate") {
        mutations++;
        if (mutations === 1) ws.close(); // Applied, acknowledgement lost.
        else ws.send(`6:::${match[1]}+[]`);
      } else if (event.name === "joinDoc") {
        ws.send(`6:::${match[1]}+${JSON.stringify([null, [mutations ? "after" : "before"], mutations, [], {}])}`);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  process.env.OL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.XDG_CONFIG_HOME = state;
  try {
    await saveStored(process.env.OL_BASE_URL, "overleaf_session2=fixture");
    await ensureSocketForProject("fixture-project");
    assert.equal((await ensureDocLoaded("doc")).text, "before");
    await assert.rejects(applyOtUpdate("doc", { doc: "doc", v: 0, op: [{ p: 0, i: "after" }] }), /uncertain/);
    assert.equal(mutations, 1);
    assert.equal((await ensureDocLoaded("doc")).text, "after");
    assert.equal(mutations, 1);
  } finally {
    disconnectActive(); clearIdentity(); clearDocCache();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous.root === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.root;
    if (previous.base === undefined) delete process.env.OL_BASE_URL;
    else process.env.OL_BASE_URL = previous.base;
    await rm(state, { recursive: true });
  }
});
