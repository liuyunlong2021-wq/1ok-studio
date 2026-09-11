import { describe, expect, it } from "vitest";
import {
  DEFAULT_JIUCAIHEZI_CONFIG,
  hasJiucaiheziKey,
  normalizeJiucaiheziConfig,
  toJiucaiheziPayload,
} from "@/lib/jiucaiheziConfig";

describe("Jiucaihezi-only configuration", () => {
  it("requires the Jiucaihezi API key", () => {
    expect(hasJiucaiheziKey(DEFAULT_JIUCAIHEZI_CONFIG)).toBe(false);
    expect(hasJiucaiheziKey({ JIUCAIHEZI_API_KEY: "  jc-test  " })).toBe(true);
  });

  it("normalizes a missing endpoint map", () => {
    expect(normalizeJiucaiheziConfig({ JIUCAIHEZI_API_KEY: "jc-test" })).toEqual({
      JIUCAIHEZI_API_KEY: "jc-test",
      endpoint_overrides: {},
    });
  });

  it("submits the key without a user-configurable endpoint", () => {
    expect(toJiucaiheziPayload({
      JIUCAIHEZI_API_KEY: "jc-test",
      endpoint_overrides: {
        JIUCAIHEZI_BASE_URL: "https://jiucai.example.com",
        DASHSCOPE_BASE_URL: "https://ignored.example.com",
      },
    })).toEqual({
      JIUCAIHEZI_API_KEY: "jc-test",
      endpoint_overrides: {},
    });
  });
});
