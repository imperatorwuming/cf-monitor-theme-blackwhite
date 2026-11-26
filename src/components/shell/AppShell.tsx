import { Outlet, useLocation } from "react-router-dom";
import { BackgroundLayer } from "./BackgroundLayer";
import { FloatingControls } from "./FloatingControls";
import { useSiteMetadata } from "@/hooks/useSiteMetadata";
import { lazy, Suspense, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useAuth } from "@/hooks/useAuth";
import { adminUrl, challengePending, subscribeChallenge } from "@/services/cfTransport";
import { isLivePaused, reconcileMonitorRoute, refreshMonitorSession, resumeMonitor, subscribeLivePause } from "@/services/wsStore";
import { queryClient } from "@/services/queryClient";
import { TurnstileGate } from "./TurnstileGate";
const CupertinoShell = lazy(() => import("./CupertinoShell"));

export function AppShell() {
  useSiteMetadata();
  const { pathname } = useLocation();
  const { data: config } = usePublicConfig();
  const { data: me } = useAuth();
  const session = useRef<boolean | undefined>(undefined);
  const challenge = useSyncExternalStore(subscribeChallenge, challengePending, () => false);
  const paused = useSyncExternalStore(subscribeLivePause, isLivePaused, () => false);
  useEffect(() => { reconcileMonitorRoute(); }, [pathname]);
  useEffect(() => {
    if (!me) return;
    if (session.current !== undefined && session.current !== me.logged_in) {
      refreshMonitorSession();
      void queryClient.invalidateQueries({ predicate: query => query.queryKey[0] !== "me" });
    }
    session.current = me.logged_in;
  }, [me]);
  const onVerified = useCallback(() => {
    refreshMonitorSession();
    void queryClient.invalidateQueries();
  }, []);

  return (
    <div className="app-shell relative flex min-h-screen flex-col">
      <BackgroundLayer />
      {!challenge && <><Suspense fallback={null}><CupertinoShell /></Suspense><FloatingControls /></>}
      {/* max-[720px]:pt-16 给右上角固定的浮动控件留出空间，避免窄屏下展开的控件行盖住首张卡片的头部 */}
      <main className="app-main flex-1 px-3 pb-8 pt-5 max-[720px]:pt-16 sm:px-5 md:px-6 lg:px-8 lg:pt-6">
        <div className="mx-auto w-full max-w-[1720px]">
          {paused && !challenge && <div role="status" className="mb-3 flex items-center justify-center gap-3">
            实时连接已达到站点设置的时限。
            <button className="control-button px-3 py-1" onClick={resumeMonitor}>继续实时连接</button>
          </div>}
          {challenge ? <TurnstileGate onVerified={onVerified} /> :
            config?.private_site && me?.logged_in !== true ? (
              <section className="flex min-h-[55vh] flex-col items-center justify-center gap-4 text-center">
                <h1 className="text-xl font-semibold">站点已设为私有</h1>
                <p>登录后即可查看节点数据。</p>
                <a className="control-button px-4 py-2" href={adminUrl()} target="_blank" rel="noopener noreferrer">前往登录</a>
              </section>
            ) : <Outlet />}
        </div>
      </main>
      <footer className="px-4 py-4 text-center text-xs text-[var(--text-secondary)]">
        <a href="https://github.com/huilang-me/CF-Server-Monitor/" title={config?.version} target="_blank" rel="noreferrer">Powered by CF-Server-Monitor</a>
      </footer>
    </div>
  );
}
