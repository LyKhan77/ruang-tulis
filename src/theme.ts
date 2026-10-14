import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  sessionOnly: boolean;
}

const themeKey = 'ruang-tulis:theme';
const themeColors: Record<ResolvedTheme, string> = { light: '#f5f5f1', dark: '#171c19' };

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function systemMedia(): MediaQueryList | undefined {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)'); }
  catch { return undefined; }
}

function readTheme(): ThemeSnapshot {
  let preference: ThemePreference = 'system';
  let sessionOnly = false;
  try { preference = normalizeThemePreference(window.localStorage.getItem(themeKey)); }
  catch { sessionOnly = true; }
  return {
    preference,
    resolved: preference === 'system' ? (systemMedia()?.matches ? 'dark' : 'light') : preference,
    sessionOnly,
  };
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = themeColors[resolved];
}

// The entry point calls this before React renders. It owns no listeners and never
// writes a default or normalized value back to storage.
export function initializeTheme(): ThemeSnapshot {
  const snapshot = readTheme();
  applyTheme(snapshot.resolved);
  return snapshot;
}

export function useTheme() {
  const [snapshot, setSnapshot] = useState(readTheme);
  const preferenceRef = useRef(snapshot.preference);
  const mediaRef = useRef<MediaQueryList | undefined>(undefined);

  useLayoutEffect(() => {
    const media = systemMedia();
    mediaRef.current = media;
    const publish = (preference: ThemePreference, sessionOnly: boolean) => {
      preferenceRef.current = preference;
      const resolved = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
      applyTheme(resolved);
      setSnapshot({ preference, resolved, sessionOnly });
    };
    // Also initialize when App is mounted directly, outside main.tsx.
    publish(preferenceRef.current, snapshot.sessionOnly);
    const onMediaChange = () => {
      if (preferenceRef.current !== 'system') return;
      const resolved = media?.matches ? 'dark' : 'light';
      applyTheme(resolved);
      setSnapshot((current) => ({ ...current, resolved }));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== themeKey && event.key !== null) return;
      if (event.storageArea !== null) {
        try { if (event.storageArea !== window.localStorage) return; }
        catch { return; }
      }
      publish(normalizeThemePreference(event.key === null ? null : event.newValue), false);
    };
    if (media?.addEventListener) media.addEventListener('change', onMediaChange);
    else media?.addListener?.(onMediaChange);
    window.addEventListener('storage', onStorage);
    return () => {
      if (media?.removeEventListener) media.removeEventListener('change', onMediaChange);
      else media?.removeListener?.(onMediaChange);
      window.removeEventListener('storage', onStorage);
      mediaRef.current = undefined;
    };
    // Listeners read the current preference through the ref, not a stale render.
    // The initial session flag is read only when subscribing.
  }, []);

  const setPreference = useCallback((value: unknown) => {
    const preference = normalizeThemePreference(value);
    preferenceRef.current = preference;
    let sessionOnly = false;
    try { window.localStorage.setItem(themeKey, preference); }
    catch { sessionOnly = true; }
    const resolved = preference === 'system' ? (mediaRef.current?.matches ? 'dark' : 'light') : preference;
    applyTheme(resolved);
    setSnapshot({ preference, resolved, sessionOnly });
  }, []);

  return { ...snapshot, setPreference };
}
