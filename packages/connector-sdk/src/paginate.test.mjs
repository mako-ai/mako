import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate, pick } from "./paginate.js";

const drain = async generator => {
  const pages = [];
  for await (const page of generator) pages.push(page);
  return pages;
};

test("pick walks a dotted path and tolerates absence", () => {
  assert.equal(pick({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(pick({ a: {} }, "a.b.c"), undefined);
});

test("cursor pagination stops when the API stops sending a cursor", async () => {
  const responses = [
    { items: [1, 2], next: "c1" },
    { items: [3], next: null },
  ];
  let call = 0;
  const pages = await drain(
    paginate({
      fetchPage: () => Promise.resolve(responses[call++]),
      recordsPath: "items",
      cursorPath: "next",
    }),
  );
  assert.deepEqual(
    pages.map(p => p.records),
    [[1, 2], [3]],
  );
  assert.deepEqual(pages.map(p => p.hasMore), [true, false]);
});

test("a repeated cursor throws instead of looping forever", async () => {
  await assert.rejects(
    drain(
      paginate({
        fetchPage: () => Promise.resolve({ items: [1], next: "same" }),
        recordsPath: "items",
        cursorPath: "next",
      }),
    ),
    /returned a cursor it had already returned/,
  );
});

test("page style stops on a short page", async () => {
  const pages = await drain(
    paginate({
      style: "page",
      pageSize: 2,
      fetchPage: ({ page }) => Promise.resolve(page === 1 ? [1, 2] : [3]),
    }),
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0].cursor, 2);
  assert.equal(pages[0].hasMore, true);
  assert.equal(pages[1].cursor, undefined);
  assert.equal(pages[1].hasMore, false);
});

test("offset style advances by what it actually received", async () => {
  const pages = await drain(
    paginate({
      style: "offset",
      pageSize: 2,
      fetchPage: ({ offset }) => Promise.resolve(offset === 0 ? [1, 2] : []),
    }),
  );
  assert.deepEqual(pages.map(p => p.cursor), [2, undefined]);
  assert.deepEqual(pages.map(p => p.hasMore), [true, false]);
});
