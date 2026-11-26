import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemeSettings } from "@/types/komari";

export function HomepagePreview({ settings }: { settings: ThemeSettings }) {
  const [status, setStatus] = useState<"closed" | "loading" | "ready" | "blocked">("closed");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const preview = useRef<Window | null>(null);
  const send = useCallback(() => {
    preview.current?.postMessage({ type: "blackwhite:preview-settings", settings }, window.location.origin);
  }, [settings]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== preview.current) return;
      if (event.data?.type === "blackwhite:preview-ready") send();
      if (event.data?.type === "blackwhite:preview-applied") setStatus("ready");
    };
    window.addEventListener("message", receive);
    send();
    return () => window.removeEventListener("message", receive);
  }, [send]);

  useEffect(() => {
    if (status !== "loading" && status !== "ready") return;
    const timer = window.setInterval(() => {
      if (preview.current?.closed) setStatus("closed");
      else if (status === "loading") send();
    }, 350);
    return () => window.clearInterval(timer);
  }, [send, status]);

  useEffect(() => () => preview.current?.close(), []);

  function open() {
    preview.current?.close();
    const url = new URL(window.location.href);
    url.searchParams.set("blackwhite-preview", "1");
    url.hash = "/";
    const width = device === "desktop" ? 1280 : 390;
    preview.current = window.open(url, "blackwhite-home-preview", `popup,width=${width},height=800`);
    setStatus(preview.current ? "loading" : "blocked");
  }

  return (
    <section className="studio-home-preview">
      <header>
        <div><h3>首页实时预览</h3><p>预览窗口会实时接收草稿，关闭后草稿仍留在工作室。</p></div>
        <button type="button" className="studio-button" onClick={open}>打开首页预览</button>
      </header>
      <div className="studio-background-segments" role="group" aria-label="首页预览设备">
        {(["desktop", "mobile"] as const).map(value =>
          <button type="button" key={value} aria-pressed={device === value} onClick={() => setDevice(value)}>
            {value === "desktop" ? "桌面" : "移动端"}
          </button>,
        )}
      </div>
      {status !== "closed" && <div className="studio-preview-status">
        <p role="status">
          {status === "ready" ? "草稿已同步到预览。" : status === "blocked" ? "浏览器阻止了预览窗口，请允许弹出窗口后重试。" : "正在准备首页预览…"}
        </p>
        {(status === "ready" || status === "loading") && <button type="button" className="studio-button" onClick={() => {
          preview.current?.close();
          setStatus("closed");
        }}>关闭预览</button>}
      </div>}
    </section>
  );
}
