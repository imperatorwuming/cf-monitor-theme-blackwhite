import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
async function setup(embedded = true, popup = false) {
  let receive: ((event: unknown) => void) | undefined;
  const parent = { postMessage: vi.fn() };
  const windowMock = { opener: popup ? parent : null, parent: parent as unknown, location: { origin: 'https://blackwhite.test', search: '?blackwhite-preview=1' }, addEventListener: vi.fn((_name, listener) => { receive = listener; }) };
  if (!embedded || popup) windowMock.parent = windowMock;
  vi.stubGlobal('window', windowMock);
  const preview = await import('../studioPreview');
  const send = (patch: Record<string, unknown> = {}) => receive?.({ origin: windowMock.location.origin, source: parent, data: { type: 'blackwhite:preview-settings', settings: { defaultAppearance: 'crystal-dark' } }, ...patch });
  return { preview, parent, windowMock, send };
}

describe('isolated studio preview messages', () => {
  it('does not install a message listener in a standalone page', async () => {
    const { preview, windowMock, send } = await setup(false);
    send();
    expect(windowMock.addEventListener).not.toHaveBeenCalled();
    expect(preview.getStudioPreview()).toBeNull();
  });
  it('requires both the preview owner and matching origin', async () => {
    const { preview, parent, send } = await setup();
    send({ origin: 'https://other.test' });
    send({ source: {} });
    expect(preview.getStudioPreview()).toBeNull();
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "blackwhite:preview-ready" }, "https://blackwhite.test");
  });
  it('rejects malformed settings and unrelated messages', async () => {
    const { preview, send } = await setup();
    for (const settings of [null, [], 'crystal-dark']) send({ data: { type: 'blackwhite:preview-settings', settings } });
    send({ data: { type: 'other', settings: {} } });
    expect(preview.getStudioPreview()).toBeNull();
  });
  it('acknowledges valid drafts without notifying twice for identical content', async () => {
    const { preview, parent, send } = await setup(true, true);
    const notify = vi.fn();
    const stop = preview.subscribeStudioPreview(notify);
    send();
    const first = preview.getStudioPreview();
    send();
    expect(first?.defaultAppearance).toBe('crystal-dark');
    expect(preview.getStudioPreview()).toBe(first);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(parent.postMessage.mock.calls.filter(([value]) => value.type === "blackwhite:preview-applied")).toHaveLength(2);
    stop();
    send({ data: { type: 'blackwhite:preview-settings', settings: { defaultAppearance: 'light', enableAdminButton: false } } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(preview.getStudioPreview()?.enableAdminButton).toBeUndefined();
  });
});
