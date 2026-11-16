// The synthetic workflow of the load test: the shape of a short agent run
// (five steps, one after the other, each mostly waiting on I/O) with nothing
// real behind it. A step waits `stepMs` on an HTTP call to the stand-in Mako.
import { hatchet } from "../hatchet";

type Input = { stepMs?: number };

const burst = hatchet.workflow<Input>({ name: "burst" });

const base = (process.env.MAKO_URL ?? "http://mako:8080").replace(/\/+$/, "");

async function work(input: Input): Promise<{ at: number }> {
  const res = await fetch(`${base}/work?ms=${input.stepMs ?? 5000}`);
  if (!res.ok) throw new Error(`work answered ${res.status}`);
  return { at: Date.now() };
}

const read = burst.task({ name: "read", retries: 2, fn: work });
const investigate = burst.task({
  name: "investigate",
  retries: 2,
  parents: [read],
  fn: work,
});
const propose = burst.task({
  name: "propose",
  retries: 2,
  parents: [investigate],
  fn: work,
});
const act = burst.task({
  name: "act",
  retries: 2,
  parents: [propose],
  fn: work,
});
burst.task({ name: "evals", retries: 2, parents: [act], fn: work });

export default burst;
