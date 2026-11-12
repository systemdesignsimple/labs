// tenant-context.mjs · run: node labs/multi-tenancy/tenant-context.mjs
// Two tenant requests overlap across await points; each must still name only its own resources.
// A third call runs with no tenant in context and must fail closed.
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const tenantCtx = new AsyncLocalStorage();

function key(kind, name) {
  const id = tenantCtx.getStore()?.tenantId;
  if (!id) throw new Error("no tenant in context"); // fail closed, never a shared name
  return kind === "table" ? `${id}_${name}` : `${id}/${name}`;
}

const log = [];
async function handle(label, delays) {
  for (const [step, ms] of delays.entries()) {
    await sleep(ms); // yield, so the other request runs in between
    log.push(`${String(Date.now() - t0).padStart(3)} ms  ${label} step ${step + 1}  ${key("table", "orders")}  ${key("cache", "menu")}`);
  }
}

const t0 = Date.now();
await Promise.all([
  tenantCtx.run({ tenantId: "brand-a" }, () => handle("request A", [5, 20, 5])),
  tenantCtx.run({ tenantId: "brand-b" }, () => handle("request B", [10, 5, 20])),
]);
console.log(log.join("\n"));

const leaks = log.filter((l) => (l.includes("request A") && l.includes("brand-b")) || (l.includes("request B") && l.includes("brand-a")));
console.log(`\ncross-tenant names: ${leaks.length} of ${log.length * 2}`);

try {
  key("table", "orders"); // called outside any tenantCtx.run(...)
  console.log("missing context: built a name (BUG)");
} catch (e) {
  console.log(`missing context: threw "${e.message}"`);
}
