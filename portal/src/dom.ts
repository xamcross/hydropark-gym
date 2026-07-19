// Tiny typed DOM helpers — the whole "framework". `el` returns the precise element type for the
// given tag (so `el("input", ...)` yields an HTMLInputElement with a typed `.value`), which keeps
// views free of casts.

type EventHandlers = Partial<{
  [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void;
}>;

export interface ElOptions {
  class?: string;
  text?: string;
  /** Static, trusted HTML only (e.g. inline icons). Never pass user-controlled strings here. */
  html?: string;
  attrs?: Record<string, string>;
  on?: EventHandlers;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: ReadonlyArray<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class !== undefined) {
    node.className = opts.class;
  }
  if (opts.text !== undefined) {
    node.textContent = opts.text;
  }
  if (opts.html !== undefined) {
    node.innerHTML = opts.html;
  }
  if (opts.attrs !== undefined) {
    for (const [name, value] of Object.entries(opts.attrs)) {
      node.setAttribute(name, value);
    }
  }
  if (opts.on !== undefined) {
    for (const [type, handler] of Object.entries(opts.on)) {
      if (handler !== undefined) {
        node.addEventListener(type, handler as unknown as EventListener);
      }
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

/** Look up a required element by id, throwing (rather than returning null) if it is missing. */
export function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`Expected element #${id} to exist`);
  }
  return node as T;
}

export function clearChildren(node: HTMLElement): void {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
}

/** Replace all children of `parent` with `nodes`. */
export function replaceChildren(parent: HTMLElement, ...nodes: ReadonlyArray<Node | string>): void {
  clearChildren(parent);
  for (const node of nodes) {
    parent.append(node);
  }
}
