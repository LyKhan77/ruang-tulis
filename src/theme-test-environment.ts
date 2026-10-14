import { vi } from 'vitest';

export interface ThemeTestEnvironment {
  media: MediaQueryList;
  listenerCount: () => number;
  setSystemDark: (value: boolean) => void;
  restore: () => void;
}

// jsdom has no OS theme. Keep the media event lifecycle real and inspectable.
export function installThemeTestEnvironment(initialDark = false): ThemeTestEnvironment {
  const storage = Object.entries(localStorage);
  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');
  const previousStyle = root.getAttribute('style');
  const previousMeta = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const metaCopies = previousMeta.map((meta) => meta.cloneNode(true));
  previousMeta.forEach((meta) => meta.remove());
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  localStorage.clear();
  root.removeAttribute('data-theme');
  root.style.removeProperty('color-scheme');

  let dark = initialDark;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const media = {
    media: '(prefers-color-scheme: dark)',
    get matches() { return dark; },
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.delete(listener); },
    addListener: (listener: EventListenerOrEventListenerObject) => { listeners.add(listener); },
    removeListener: (listener: EventListenerOrEventListenerObject) => { listeners.delete(listener); },
    dispatchEvent: () => true,
  } as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => {
      if (query !== '(prefers-color-scheme: dark)') throw new Error(`Unexpected media query: ${query}`);
      return media;
    }),
  });

  return {
    media,
    listenerCount: () => listeners.size,
    setSystemDark(value: boolean) {
      dark = value;
      const event = new Event('change');
      Object.defineProperties(event, { matches: { value }, media: { value: media.media } });
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
    restore() {
      localStorage.clear();
      for (const [key, value] of storage) localStorage.setItem(key, value);
      if (previousTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previousTheme);
      if (previousStyle === null) root.removeAttribute('style');
      else root.setAttribute('style', previousStyle);
      document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
      metaCopies.forEach((meta) => document.head.append(meta));
      if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
      else Reflect.deleteProperty(window, 'matchMedia');
    },
  };
}
