import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/* =============================================================================
   media_note widget (P1-06.4 · SPEC 9.4 / 9.1)
   -----------------------------------------------------------------------------
   A passive REFERENCE CARD: a short text note and/or a vetted, sanitised SVG
   (technique diagram, tip, labelled illustration). It is the read-only end of
   the library — NO editor, NO slot-mutating buttons, and (by default) NO bus
   events. When bound to a scalar<string> slot it is ALWAYS a live read-only
   projection: it renders every update and never writes the slot (contract §5).

   SECURITY (SPEC 9.1 — no code / no remote content / no inline styles):
     • TEXT renders through Angular's own interpolation ({{ }}) — auto-escaped,
       never innerHTML. Markdown is tokenised in TS into typed inline runs and
       rendered with template control-flow, so no HTML string is ever built and
       there is NO sanitiser surface for text. Images and link targets are
       stripped/flattened per the schema.
     • SVG is the ONLY thing rendered via [innerHTML]. The authoritative control
       is INSTALL-TIME sanitisation of media.asset (script, style, on*-handlers,
       foreignObject, external-href stripped — schema $defs/assetRef); the renderer hands this
       component the already-vetted inline SVG STRING. As defence-in-depth the
       component re-scrubs that string (scrubSvg) and only then calls
       bypassSecurityTrustHtml — the single, documented bypass, justified because
       the input is package-bundled (never remote) and twice-sanitised.
   ============================================================================= */

/** Closed, token-mapped style-variant vocabulary (base contract §7). */
export type StyleTone = 'default' | 'neutral' | 'accent' | 'positive' | 'caution' | 'danger';
export type StyleDensity = 'comfortable' | 'compact';

export type MediaNotePhase = 'loading' | 'ready' | 'empty' | 'error' | 'read_only' | 'placeholder';
export type NoteFormat = 'plain' | 'markdown';

/** Overridable lifecycle copy (§6 — copy only, never behaviour). */
export interface MediaNoteCopy {
  loading: string;
  empty: string;
  errorFallback: string;
  placeholder: string;
}

/** One inline run of the safe markdown renderer — carries ONLY formatting flags,
    never HTML; the template renders each `text` through interpolation. */
export interface InlineRun {
  text: string;
  strong?: boolean;
  em?: boolean;
  code?: boolean;
}

/** A parsed markdown block (paragraph / bullet list / ordered list). Flat (optional
    `runs`/`items`) rather than a discriminated union so template property access does
    not depend on Angular `@switch` type-narrowing under strictTemplates. */
export interface Block {
  kind: 'p' | 'ul' | 'ol';
  runs?: InlineRun[]; // for 'p'
  items?: InlineRun[][]; // for 'ul' | 'ol'
}

/** Module-scoped counter → per-instance DOM id prefix (aria-controls uniqueness). */
let mediaNoteSeq = 0;

@Component({
  selector: 'app-media-note',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-note.component.html',
  styleUrl: './media-note.component.css',
})
export class MediaNoteComponent {
  private readonly sanitizer = inject(DomSanitizer);

  /** Unique per-instance id prefix so aria-controls stays valid with many cards on one page. */
  readonly uid = `mn-${++mediaNoteSeq}`;

  // --- props (authored) ---
  readonly noteTitle = input<string | null>(null); // envelope `title` / accessible name
  readonly body = input<string | null>(null); // props.body (fallback text)
  readonly format = input<NoteFormat>('plain');
  readonly caption = input<string | null>(null);
  readonly collapsible = input<boolean>(false);
  readonly initiallyCollapsed = input<boolean>(false);
  readonly maxLines = input<number | null>(null);

  // --- media: the vetted, install-sanitised inline SVG STRING (never a path/URL) ---
  readonly svg = input<string | null>(null);
  readonly alt = input<string | null>(null);
  readonly decorative = input<boolean>(false);
  /** Small leading semantic SVG (aria-hidden) — a11y pairing so a toned card is never colour-only. */
  readonly icon = input<string | null>(null);

  // --- style variants (base contract §7) ---
  readonly tone = input<StyleTone>('default');
  readonly density = input<StyleDensity>('comfortable');

  // --- runtime / binding projection ---
  readonly phase = input<MediaNotePhase>('ready');
  readonly bound = input<boolean>(false); // binds_state present → live read-only steady state
  readonly boundText = input<string | null>(null); // live slot value (null while loading / empty)
  readonly writer = input<string | null>(null); // writer-of-record when another skill owns the slot
  readonly error = input<{ message: string } | null>(null);
  readonly states = input<Partial<MediaNoteCopy>>({});

  // --- outputs: LOCAL UI only (media_note emits NOTHING to chat / the bus, §3) ---
  /** Disclosure open/closed — session-scoped local UI state (SPEC 9.9), not a bus event. */
  readonly expandedChange = output<boolean>();
  /** Local recovery request in the error phase (e.g. re-resolve the asset); not a chat event. */
  readonly retry = output<void>();

  private readonly userExpanded = signal<boolean | null>(null); // null → follow initiallyCollapsed

  private readonly defaultCopy: MediaNoteCopy = {
    loading: 'Loading note…',
    empty: 'Nothing to show yet.',
    errorFallback: "This note couldn't be shown.",
    placeholder: 'This panel needs a newer version of the app.',
  };
  readonly copy = computed<MediaNoteCopy>(() => ({ ...this.defaultCopy, ...this.states() }));

  /** Resolved body: the live slot value when bound (with props.body as the pre-resolve fallback),
      else props.body. null → the empty state (§6). */
  readonly text = computed<string | null>(() => {
    const t = this.bound() ? (this.boundText() ?? this.body()) : this.body();
    return t ?? null;
  });

  /** Effective lifecycle phase — honours explicit loading/error/placeholder/empty, else derives
      empty (nothing to show) vs read_only (bound) vs ready. */
  readonly effectivePhase = computed<MediaNotePhase>(() => {
    const p = this.phase();
    if (p === 'loading' || p === 'error' || p === 'placeholder' || p === 'empty') return p;
    if (!this.text() && !this.svg()) return 'empty';
    return this.bound() ? 'read_only' : 'ready';
  });

  readonly expanded = computed<boolean>(() => {
    if (!this.collapsible()) return true;
    const u = this.userExpanded();
    return u !== null ? u : !this.initiallyCollapsed();
  });

  /** Line-clamp is active for a fixed max_lines when not (collapsibly) expanded. */
  readonly clamped = computed<boolean>(() => {
    const n = this.maxLines();
    if (!n || n <= 0) return false;
    return this.collapsible() ? !this.expanded() : true;
  });

  readonly clampVar = computed<string | null>(() => {
    const n = this.maxLines();
    return n && n > 0 ? String(n) : null;
  });

  /** DEFENCE-IN-DEPTH scrub + the single documented bypass for the vetted media SVG. */
  readonly safeSvg = computed<SafeHtml | null>(() => this.trustSvg(this.svg()));
  /** Same treatment for the small leading semantic icon (rendered aria-hidden). */
  readonly safeIcon = computed<SafeHtml | null>(() => this.trustSvg(this.icon()));

  /** Parsed markdown blocks (only when format=markdown); rendered via interpolation, never innerHTML. */
  readonly blocks = computed<Block[]>(() => {
    if (this.format() !== 'markdown') return [];
    const t = this.text();
    return t ? parseMarkdown(t) : [];
  });

  toggle(): void {
    if (!this.collapsible()) return;
    const next = !this.expanded();
    this.userExpanded.set(next);
    this.expandedChange.emit(next);
  }

  onRetry(): void {
    this.retry.emit();
  }

  private trustSvg(raw: string | null): SafeHtml | null {
    if (!raw) return null;
    const scrubbed = scrubSvg(raw);
    if (!scrubbed) return null;
    // Justified bypass: the string is a package-bundled asset, install-time sanitised
    // (schema $defs/assetRef) AND re-scrubbed above. Angular's own sanitiser would
    // strip legitimate SVG features from a vetted diagram, so we render it faithfully.
    return this.sanitizer.bypassSecurityTrustHtml(scrubbed);
  }
}

/**
 * Conservative, defence-in-depth re-sanitisation of the ALREADY install-sanitised
 * inline SVG string (the authoritative control is the asset pipeline — SPEC 9.1 /
 * schema $defs/assetRef). Strips the exact dangerous constructs the pipeline removes
 * so the component never blindly trusts its input before bypassSecurityTrustHtml.
 * Returns null if the string is not a plain inline <svg> root.
 */
export function scrubSvg(raw: string): string | null {
  const s = raw.trim();
  if (!/^<svg[\s>]/i.test(s)) return null; // must be an inline <svg> root, not arbitrary markup
  let out = s;
  out = out.replace(/<!--[\s\S]*?-->/g, ''); // comments
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, ''); // scripts
  out = out.replace(/<style[\s\S]*?<\/style\s*>/gi, ''); // embedded stylesheets (no skill CSS, §7)
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, ''); // HTML escape hatch
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, ''); // event handlers "…"
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, ''); // event handlers '…'
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, ''); // unquoted event handlers
  out = out.replace(/\sstyle\s*=\s*"[^"]*"/gi, ''); // inline styles
  out = out.replace(/\sstyle\s*=\s*'[^']*'/gi, '');
  // external / script-scheme references in href / xlink:href / src (keep local #id refs)
  out = out.replace(
    /\s(?:xlink:href|href|src)\s*=\s*"\s*(?:https?:|\/\/|data:|javascript:|blob:)[^"]*"/gi,
    ''
  );
  out = out.replace(
    /\s(?:xlink:href|href|src)\s*=\s*'\s*(?:https?:|\/\/|data:|javascript:|blob:)[^']*'/gi,
    ''
  );
  // external url(...) in presentation attributes (e.g. fill="url(http…)")
  out = out.replace(/url\(\s*['"]?\s*(?:https?:|\/\/|data:|javascript:)[^)]*\)/gi, 'none');
  return out;
}

/** Minimal, SAFE markdown → typed blocks. Produces NO HTML — every character of user
    input is rendered later through Angular interpolation. Supports paragraphs, blank-line
    breaks, bullet/ordered lists, and inline strong/em/code. Images are stripped and links
    are flattened to their text (schema: remote content stripped). */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', runs: parseInline(para.join('\n')) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map(parseInline);
      blocks.push(list.ordered ? { kind: 'ol', items } : { kind: 'ul', items });
      list = null;
    }
  };

  for (const line of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

/** Tokenise a line into inline runs: `code`, **strong**, *em* / _em_. Strips images and
    flattens links to their visible text. Returns plain runs otherwise. */
export function parseInline(src: string): InlineRun[] {
  let s = src.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // images stripped (no remote content)
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // link → its text (target not rendered live)
  const runs: InlineRun[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[1]) runs.push({ text: m[1].slice(1, -1), code: true });
    else if (m[2]) runs.push({ text: m[2].slice(2, -2), strong: true });
    else if (m[3]) runs.push({ text: m[3].slice(1, -1), em: true });
    else if (m[4]) runs.push({ text: m[4].slice(1, -1), em: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: s }];
}
