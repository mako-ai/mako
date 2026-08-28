import { Sandbox } from "e2b";
const paginator = Sandbox.list({ limit: 20 });
let id = "";
for (const s of await paginator.nextItems()) {
  if ((s.metadata as Record<string,string>)?.makoAppsV2SessionKey?.includes("5qy86lr2ntycr2r")) { id = s.sandboxId; break; }
}
if (!id) { console.log("no box"); process.exit(0); }
const sbx = await Sandbox.connect(id);
const r = await sbx.commands.run("ls /tmp/mako-term-*.sock 2>/dev/null; echo ---; ps aux | grep -c '[m]ako-dev-live'", { timeoutMs: 20000 }).catch(e => ({ stdout: String(e) }) as any);
console.log("box", id, "\n" + (r.stdout || "").trim());
