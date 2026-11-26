import { useEffect, useRef, useState } from "react";
import { challengeOrigins, getCfConfig, verifyChallenge } from "@/services/cfTransport";

type Turnstile = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widget: string) => void;
  reset: (widget: string) => void;
};
let loading: Promise<Turnstile> | undefined;

function loadWidget() {
  const browser = window as Window & { turnstile?: Turnstile };
  if (browser.turnstile) return Promise.resolve(browser.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => browser.turnstile ? resolve(browser.turnstile) : reject(new Error("验证组件不可用"));
    script.onerror = () => reject(new Error("验证组件加载失败"));
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

export function TurnstileGate({ onVerified }: { onVerified: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const origin = challengeOrigins()[0];
  useEffect(() => {
    const element = root.current;
    if (!element || !origin) return;
    let active = true;
    let widget: string | undefined;
    let api: Turnstile | undefined;
    async function mount() {
      const [config, turnstile] = await Promise.all([getCfConfig(origin, true), loadWidget()]);
      if (!active) return;
      if (!config.turnstile_site_key) throw new Error("站点未提供验证密钥");
      api = turnstile;
      widget = api.render(element!, {
        sitekey: config.turnstile_site_key,
        callback: async (token: string) => {
          try {
            await verifyChallenge(origin, token);
            onVerified();
          } catch (failure) {
            if (!active) return;
            setError(failure instanceof Error ? failure.message : "验证失败");
            if (widget !== undefined) api?.reset(widget);
          }
        },
        "expired-callback": () => { if (widget !== undefined) api?.reset(widget); },
        "error-callback": () => setError("验证组件无法连接，请重试。"),
      });
    }
    void mount().catch(failure => { if (active) setError(String(failure.message ?? failure)); });
    return () => {
      active = false;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [origin, attempt, onVerified]);
  return (
    <section className="flex min-h-[55vh] flex-col items-center justify-center gap-4 text-center" aria-label="访客验证">
      <h1 className="text-xl font-semibold">完成访客验证</h1>
      <p>通过 Cloudflare Turnstile 后即可查看监控数据。</p>
      <div ref={root} />
      {error && <><p role="alert">{error}</p><button className="control-button px-4 py-2" onClick={() => { setError(""); retry(value => value + 1); }}>重新加载</button></>}
    </section>
  );
}
