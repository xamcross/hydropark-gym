import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

/**
 * Light/dark theming (P1-01.4). The theme is expressed as a `data-theme`
 * attribute on the document root, which selects one of the two fully-defined
 * token sets in styles/tokens.css.
 *
 * The default signal is the OS `prefers-color-scheme`: when the user has made
 * no explicit choice we leave `data-theme` *absent*, so the CSS media query in
 * tokens.css §4 supplies the dark set on a dark OS and the light `:root`
 * default otherwise. An explicit choice writes the attribute (and persists it),
 * which always wins over the OS preference.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly storageKey = 'hp-theme';

  /** Explicit user choice, or null to defer to the OS (`prefers-color-scheme`). */
  readonly preference = signal<Theme | null>(this.readStored());

  constructor() {
    this.apply();
  }

  /** The theme actually rendered right now (resolves null → OS preference). */
  resolved(): Theme {
    const chosen = this.preference();
    if (chosen) return chosen;
    return this.prefersDark() ? 'dark' : 'light';
  }

  /** Flip between light and dark, pinning an explicit choice. */
  toggle(): void {
    this.set(this.resolved() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.preference.set(theme);
    try {
      localStorage.setItem(this.storageKey, theme);
    } catch {
      /* storage may be unavailable (private mode) — theme still applies in-session */
    }
    this.apply();
  }

  /** Forget the explicit choice and follow the OS again. */
  clear(): void {
    this.preference.set(null);
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
    this.apply();
  }

  private apply(): void {
    const root = document.documentElement;
    const chosen = this.preference();
    if (chosen) {
      root.setAttribute('data-theme', chosen);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  private prefersDark(): boolean {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  }

  private readStored(): Theme | null {
    try {
      const value = localStorage.getItem(this.storageKey);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  }
}
