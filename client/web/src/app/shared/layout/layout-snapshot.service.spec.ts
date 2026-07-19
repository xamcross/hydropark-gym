import { TestBed } from '@angular/core/testing';
import { LayoutSnapshotService } from './layout-snapshot.service';
import { PanelOverride } from './layout.model';

const OVERRIDES_A: PanelOverride[] = [{ key: 'a', collapsed: true, pinned: false, order: null, size: null }];
const OVERRIDES_B: PanelOverride[] = [{ key: 'b', collapsed: false, pinned: true, order: 1, size: 240 }];

describe('LayoutSnapshotService (Task 11b, post-review fix)', () => {
  let svc: LayoutSnapshotService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(LayoutSnapshotService);
  });

  it('restore() with a live bridge applies immediately and returns a token', () => {
    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    const token = svc.restore(OVERRIDES_A);

    expect(restoreSpy).toHaveBeenCalledOnceWith(OVERRIDES_A);
    expect(token).not.toBeNull();
  });

  it('restore() with a malformed (non-array) payload is a no-op and returns null', () => {
    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    const token = svc.restore({ not: 'an array' });

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(token).toBeNull();
  });

  // --- (a) buffer with no bridge, then register() replays it once ----------

  it('restore() with NO bridge buffers, and the next register() applies it exactly once', () => {
    const token = svc.restore(OVERRIDES_A);
    expect(token).not.toBeNull();

    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    expect(restoreSpy).toHaveBeenCalledOnceWith(OVERRIDES_A);

    // A SECOND register() (e.g. a later, unrelated dock mount) must not replay
    // an already-consumed buffer.
    const restoreSpy2 = jasmine.createSpy('restore2');
    svc.register({ capture: () => [], restore: restoreSpy2 });
    expect(restoreSpy2).not.toHaveBeenCalled();
  });

  // --- (b) a stale/superseded buffered restore does not apply --------------

  it('invalidate(token) drops the buffered restore it matches — a later register() does not apply it', () => {
    const token = svc.restore(OVERRIDES_A);
    expect(token).not.toBeNull();

    svc.invalidate(token!);

    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('a STALE invalidate() (superseded by a newer restore()) is a safe no-op — the newer buffered restore still applies', () => {
    const staleToken = svc.restore(OVERRIDES_A);
    const currentToken = svc.restore(OVERRIDES_B); // supersedes — only one pending slot exists
    expect(staleToken).not.toBeNull();
    expect(currentToken).not.toBeNull();
    expect(staleToken).not.toBe(currentToken);

    // A late-arriving invalidate for the ALREADY-superseded token must not
    // cancel the current, still-relevant one.
    svc.invalidate(staleToken!);

    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    expect(restoreSpy).toHaveBeenCalledOnceWith(OVERRIDES_B);
  });

  it('invalidate() on a token that already applied immediately (bridge was live) is a harmless no-op', () => {
    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });
    const token = svc.restore(OVERRIDES_A);
    restoreSpy.calls.reset();

    svc.invalidate(token!); // nothing pending to drop — must not throw or affect anything

    // Registering again (a fresh, unrelated mount) still sees no leftover buffer.
    const restoreSpy2 = jasmine.createSpy('restore2');
    svc.clear();
    svc.register({ capture: () => [], restore: restoreSpy2 });
    expect(restoreSpy2).not.toHaveBeenCalled();
  });

  // --- (c) clear() drops a pending restore ----------------------------------

  it('clear() drops a still-buffered restore — a later register() does not apply it', () => {
    svc.restore(OVERRIDES_A);

    svc.clear();

    const restoreSpy = jasmine.createSpy('restore');
    svc.register({ capture: () => [], restore: restoreSpy });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('clear() also drops the live bridge — snapshot() falls back to [] afterwards', () => {
    svc.register({ capture: () => [{ key: 'x', collapsed: true, pinned: false, order: null, size: null }], restore: () => undefined });
    expect(svc.snapshot().length).toBe(1);

    svc.clear();

    expect(svc.snapshot()).toEqual([]);
  });

  it('snapshot() returns [] when no bridge is (yet) registered', () => {
    expect(svc.snapshot()).toEqual([]);
  });
});
