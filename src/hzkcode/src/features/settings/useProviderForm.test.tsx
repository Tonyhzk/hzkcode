import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/i18n";
import type { ProviderFormValue } from "./ProviderDialog";
import { useProviderForm, type ProviderForm } from "./useProviderForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ProviderForm;

function Harness({ initial }: { initial?: ProviderFormValue }) {
  latest = useProviderForm({ engine: "claude", initial, onSubmit: () => {} });
  return null;
}

function channelForm(settingsJson: string): ProviderFormValue {
  return {
    name: "relay",
    remark: "",
    baseUrl: "https://relay.example",
    apiKey: "sk-x",
    model: "",
    customModels: [],
    settingsJson,
  };
}

const envOf = () =>
  (JSON.parse(latest.value.settingsJson) as { env: Record<string, unknown> }).env;

describe("useProviderForm legacy migration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("打开旧渠道即迁移：JSON 与控件都剥后缀并落实 1M 窗口", () => {
    act(() => {
      root.render(
        <Harness
          initial={channelForm(
            JSON.stringify({
              env: {
                HZKCODE_MODEL: "sonnet",
                HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
              },
            }),
          )}
        />,
      );
    });
    const env = envOf();
    expect(env.HZKCODE_DEFAULT_HIGH_MODEL).toBe("deepseek-v4-pro");
    expect(env.HZKCODE_MAX_CONTEXT_TOKENS).toBe("1000000");
    expect(latest.envValues.HZKCODE_MODEL).toBe("mid");
    expect(latest.envValues.HZKCODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  });

  it("迁移后修改模型字段保存，1M 窗口仍在配置里", () => {
    act(() => {
      root.render(
        <Harness
          initial={channelForm(
            JSON.stringify({
              env: { HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]" },
            }),
          )}
        />,
      );
    });
    act(() => latest.setEnvValue("HZKCODE_DEFAULT_HIGH_MODEL", "deepseek-v5"));
    const env = envOf();
    expect(env.HZKCODE_DEFAULT_HIGH_MODEL).toBe("deepseek-v5");
    expect(env.HZKCODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  });

  it("显式窗口不被迁移覆盖", () => {
    act(() => {
      root.render(
        <Harness
          initial={channelForm(
            JSON.stringify({
              env: {
                HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
                HZKCODE_MAX_CONTEXT_TOKENS: 500000,
              },
            }),
          )}
        />,
      );
    });
    expect(envOf().HZKCODE_MAX_CONTEXT_TOKENS).toBe(500000);
  });
});
