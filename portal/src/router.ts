// Minimal hash router. Routes render into a single outlet element; each may declare an auth guard
// and whether it appears in the primary nav.

export type ViewRender = (outlet: HTMLElement) => void;

export interface RouteDef {
  path: string;
  label: string;
  render: ViewRender;
  requiresAuth: boolean;
  showInNav: boolean;
}

export interface ParsedHash {
  path: string;
  params: URLSearchParams;
}

/** Split `#/path?a=b` into its path and query params. */
export function parseHash(): ParsedHash {
  const raw = location.hash.replace(/^#/, "");
  const queryIndex = raw.indexOf("?");
  const path = (queryIndex >= 0 ? raw.slice(0, queryIndex) : raw) || "/";
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : "";
  return { path, params: new URLSearchParams(query) };
}

export function navigate(path: string): void {
  if (parseHash().path === path && ("#" + path) === location.hash) {
    // Same route with no query change — force a re-render.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = path;
  }
}
