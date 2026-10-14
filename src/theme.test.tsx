// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTheme, useTheme } from './theme';
import { installThemeTestEnvironment, type ThemeTestEnvironment } from './theme-test-environment';

let environment: ThemeTestEnvironment;
let container: HTMLDivElement;
let root: Root | undefined;

function Probe() {
  const { preference, resolved, sessionOnly, setPreference } = useTheme();
  return <><select aria-label="Theme preference" value={preference} onChange={(event) => setPreference(event.target.value)}>
    <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
  </select><output>{resolved}{sessionOnly ? ':session' : ''}</output></>;
}

beforeEach(() => {
  environment = installThemeTestEnvironment();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  environment.restore();
  vi.unstubAllGlobals();
});

async function mount(strict = false) {
  root = createRoot(container);
  await act(async () => { root?.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />); });
}

async function choose(value: string) {
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function remote(key: string | null, newValue: string | null, storageArea: Storage | null = localStorage) {
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea })); });
}

describe('theme initialization', () => {
  it.each([null, '', 'DARK', ' dark ', 'automatic', 'null', 'light', 'dark', 'system'])('strictly normalizes stored %s without writing it back', (value) => {
    if (value !== null) localStorage.setItem('ruang-tulis:theme', value);
    environment.setSystemDark(true);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const snapshot = initializeTheme();
    expect(snapshot.preference).toBe(value === 'light' || value === 'dark' ? value : 'system');
    expect(snapshot.resolved).toBe(value === 'light' ? 'light' : 'dark');
    expect(document.documentElement.dataset.theme).toBe(value === 'light' ? 'light' : 'dark');
    expect(document.documentElement.style.colorScheme).toBe(value === 'light' ? 'light' : 'dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(value === 'light' ? '#f5f5f1' : '#171c19');
    expect(writes).not.toHaveBeenCalled();
    expect(environment.listenerCount()).toBe(0);
  });

  it('updates existing metadata without creating duplicates', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.append(meta);
    initializeTheme();
    environment.setSystemDark(true);
    initializeTheme();
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(meta.content).toBe('#171c19');
  });

  it('falls back safely when media detection and storage access are missing', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    expect(initializeTheme()).toMatchObject({ preference: 'system', resolved: 'light', sessionOnly: true });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('honors an explicit choice without matchMedia', () => {
    localStorage.setItem('ruang-tulis:theme', 'dark');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    expect(initializeTheme()).toMatchObject({ preference: 'dark', resolved: 'dark' });
  });
});

describe('mounted theme lifecycle', () => {
  it('tracks OS changes in system mode and makes explicit modes override the OS', async () => {
    await mount();
    expect(container.querySelector('select')?.value).toBe('system');
    await act(async () => { environment.setSystemDark(true); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await choose('light');
    await act(async () => { environment.setSystemDark(false); environment.setSystemDark(true); });
    expect(document.documentElement.dataset.theme).toBe('light');
    await choose('dark');
    await act(async () => { environment.setSystemDark(false); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await choose('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('ruang-tulis:theme')).toBe('system');
  });

  it('persists only local changes and restores the choice on a remount', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    await mount();
    expect(writes).not.toHaveBeenCalled();
    await choose('dark');
    expect(localStorage.getItem('ruang-tulis:theme')).toBe('dark');
    expect(writes).toHaveBeenCalledTimes(1);
    await act(async () => { root?.unmount(); });
    root = undefined;
    await mount();
    expect(container.querySelector('select')?.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('retains a failed save for this session and clears the scoped warning after a successful save', async () => {
    await mount();
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    await choose('dark');
    expect(container.querySelector('select')?.value).toBe('dark');
    expect(container.querySelector('output')?.textContent).toBe('dark:session');
    expect(document.documentElement.dataset.theme).toBe('dark');
    writes.mockRestore();
    await choose('light');
    expect(container.querySelector('output')?.textContent).toBe('light');
    expect(localStorage.getItem('ruang-tulis:theme')).toBe('light');
  });

  it('keeps the mounted preference usable when storage is blocked and media detection throws', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => { throw new Error('Media unavailable'); },
    });
    await mount();
    expect(container.querySelector('output')?.textContent).toBe('light:session');
    await choose('dark');
    expect(container.querySelector('select')?.value).toBe('dark');
    expect(container.querySelector('output')?.textContent).toBe('dark:session');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await choose('system');
    expect(container.querySelector('output')?.textContent).toBe('light:session');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('handles remote changes, invalid values, removal and storage clear without echo writes', async () => {
    await mount();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    await remote('ruang-tulis:theme', 'dark');
    expect(container.querySelector('select')?.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await remote('ruang-tulis:selected-document', 'light');
    await remote('ruang-tulis:theme', 'light', sessionStorage);
    expect(container.querySelector('select')?.value).toBe('dark');
    await act(async () => { environment.setSystemDark(true); });
    await remote('ruang-tulis:theme', 'invalid');
    expect(container.querySelector('select')?.value).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await remote('ruang-tulis:theme', 'light');
    await remote('ruang-tulis:theme', null);
    expect(container.querySelector('select')?.value).toBe('system');
    await remote('ruang-tulis:theme', 'light');
    await remote(null, null);
    expect(container.querySelector('select')?.value).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(writes).not.toHaveBeenCalled();
  });

  it('removes listeners on unmount without duplicates under StrictMode', async () => {
    await mount(true);
    expect(environment.listenerCount()).toBe(1);
    await choose('dark');
    await choose('light');
    expect(environment.listenerCount()).toBe(1);
    await act(async () => { root?.unmount(); });
    root = undefined;
    expect(environment.listenerCount()).toBe(0);
    environment.setSystemDark(true);
    window.dispatchEvent(new StorageEvent('storage', { key: 'ruang-tulis:theme', newValue: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('supports legacy media listeners and removes them on unmount', async () => {
    Object.defineProperties(environment.media, {
      addEventListener: { value: undefined }, removeEventListener: { value: undefined },
    });
    await mount();
    expect(environment.listenerCount()).toBe(1);
    await act(async () => { environment.setSystemDark(true); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => { root?.unmount(); });
    root = undefined;
    expect(environment.listenerCount()).toBe(0);
  });
});
