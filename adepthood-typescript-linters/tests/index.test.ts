/**
 * Tests for adepthood-typescript-linters main entry point
 */

describe("main", () => {
  it("should run without error", () => {
    // Import main to ensure it executes
    expect(() => {
      require("../src/index");
    }).not.toThrow();
  });
});
