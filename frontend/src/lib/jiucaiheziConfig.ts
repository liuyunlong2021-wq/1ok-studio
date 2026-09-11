import type { EnvConfigPayload } from "@/lib/api";

export type JiucaiheziConfig = EnvConfigPayload & {
  JIUCAIHEZI_API_KEY: string;
  endpoint_overrides: Record<string, string>;
};

export const DEFAULT_JIUCAIHEZI_CONFIG: JiucaiheziConfig = {
  JIUCAIHEZI_API_KEY: "",
  endpoint_overrides: {},
};

export const normalizeJiucaiheziConfig = (data?: EnvConfigPayload): JiucaiheziConfig => ({
  ...DEFAULT_JIUCAIHEZI_CONFIG,
  ...data,
  endpoint_overrides: data?.endpoint_overrides ?? {},
});

export const hasJiucaiheziKey = (config: Pick<JiucaiheziConfig, "JIUCAIHEZI_API_KEY">) =>
  Boolean(config.JIUCAIHEZI_API_KEY?.trim());

export const toJiucaiheziPayload = (config: JiucaiheziConfig): EnvConfigPayload => ({
  JIUCAIHEZI_API_KEY: config.JIUCAIHEZI_API_KEY,
  endpoint_overrides: {},
});
