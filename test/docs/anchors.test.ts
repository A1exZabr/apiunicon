import { describe, expect, it } from "vitest";

import { anchorHrefs } from "../../src/docs/anchors.js";

describe("anchorHrefs", () => {
  it("returns the href of each anchor in document order", () => {
    expect(anchorHrefs(`<a href="one.yaml">a</a> text <a class="x" HREF='two.json'>b</a>`)).toEqual([
      "one.yaml",
      "two.json",
    ]);
  });

  it("reads only the first href of a tag, as browsers do", () => {
    expect(anchorHrefs(`<a href="first.yaml" href="second.yaml">x</a>`)).toEqual(["first.yaml"]);
  });

  it("finds the href of a tag whose opening is repeated before it closes", () => {
    expect(anchorHrefs(`<a <a href="inner.yaml">x</a>`)).toEqual(["inner.yaml"]);
  });

  it("ignores attributes that only end in href", () => {
    expect(anchorHrefs(`<a xhref="no.yaml">x</a>`)).toEqual([]);
  });

  it("reads an unterminated tag at the end of the document", () => {
    expect(anchorHrefs(`<a href="tail.yaml"`)).toEqual(["tail.yaml"]);
  });
});
