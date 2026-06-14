// topKBySimilarity ordering + bounds. cosineNormalized itself is exercised
// through these (and through tool-filter.test.ts, which ranks via the same
// helper).

import { assertEquals } from "@std/assert";
import { cosineNormalized, topKBySimilarity } from "./relevance.ts";

function vec(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

Deno.test("cosineNormalized: dot product over the shared prefix", () => {
  assertEquals(cosineNormalized(vec(1, 0), vec(1, 0)), 1);
  assertEquals(cosineNormalized(vec(1, 0), vec(0, 1)), 0);
  // Mismatched lengths use the shorter vector.
  assertEquals(cosineNormalized(vec(1, 1, 1), vec(1)), 1);
});

Deno.test("topKBySimilarity: ranks by descending cosine and caps at topK", () => {
  const query = vec(1, 0);
  const items = [
    { item: "orthogonal", vector: vec(0, 1) },
    { item: "exact", vector: vec(1, 0) },
    { item: "close", vector: vec(0.9, 0.1) },
  ];
  const top2 = topKBySimilarity(query, items, 2);
  assertEquals(
    top2.map((s) => s.item),
    ["exact", "close"],
  );
  assertEquals(top2[0].score, 1);

  assertEquals(topKBySimilarity(query, items, 10).length, 3);
  assertEquals(topKBySimilarity(query, items, 0), []);
  assertEquals(topKBySimilarity(query, [], 5), []);
});
