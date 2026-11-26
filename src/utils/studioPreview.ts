import type { ThemeSettings } from '@/types/komari';
import { normalizeThemeSettings } from './themeSettings';
import { pickManagedThemeSettings } from './settingsStudioModel';

let draft: ThemeSettings | null = null;
const listeners = new Set<() => void>();
const opener = typeof window === "undefined" ? null : (window.opener as Window | null) ?? (window.parent !== window ? window.parent : null);
export const isStudioPreview = Boolean(opener) && new URLSearchParams(window.location.search).get("blackwhite-preview") === "1";
if (isStudioPreview) {
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== opener || event.data?.type !== 'blackwhite:preview-settings') return;
    if (!event.data.settings || typeof event.data.settings !== 'object' || Array.isArray(event.data.settings)) return;
    const next = pickManagedThemeSettings(normalizeThemeSettings(event.data.settings));
    if (JSON.stringify(next) !== JSON.stringify(draft)) {
      draft = next;
      for (const listener of listeners) listener();
    }
    opener?.postMessage({ type: 'blackwhite:preview-applied' }, window.location.origin);
  });
  opener?.postMessage({ type: "blackwhite:preview-ready" }, window.location.origin);
}
export function subscribeStudioPreview(listener: () => void) {
  if (!isStudioPreview) return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getStudioPreview() { return draft; }
