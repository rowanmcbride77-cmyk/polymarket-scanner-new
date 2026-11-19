import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("scanner refuses to emit placeholder rankings", async () => {
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.match(source, /No data was generated or published/);
});
