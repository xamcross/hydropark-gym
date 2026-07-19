import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KeyValuePanelComponent } from './key-value-panel.component';
import { BoundState } from '../widget-contract';

/* -----------------------------------------------------------------------------
 * key_value_panel — bound-state wiring (F08 · contract §5 · P1-06.1).
 *
 * Proves TWO things, and nothing more:
 *   1. REACTIVITY: bound to the shared `ingredients` list, the panel renders a
 *      live, HONEST readout (a tracked count + one row per item's own name) and
 *      re-renders when the bound slot's value changes — the B2 demo beat.
 *   2. HONESTY: no row is ever a fabricated nutrition figure (calorie/macro/
 *      health number) — every value is a literal count or a literal name/field
 *      echoed straight from the slot, per SPEC §28.1.
 *
 * Unbound (self-sourcing) behaviour is asserted unchanged.
 * -------------------------------------------------------------------------- */

function listBound(
  value: unknown[] | undefined,
  overrides: Partial<BoundState<unknown[]>> = {}
): BoundState<unknown[]> {
  return {
    slot: 'ingredients',
    kind: 'list',
    value,
    version: 1,
    readonly: false,
    writerId: 'cooking-assistant',
    writer: 'Cooking Assistant',
    ...overrides,
  };
}

describe('KeyValuePanelComponent — bound state (F08)', () => {
  let fixture: ComponentFixture<KeyValuePanelComponent>;
  let component: KeyValuePanelComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [KeyValuePanelComponent] });
    fixture = TestBed.createComponent(KeyValuePanelComponent);
    component = fixture.componentInstance;
  });

  it('renders honest derived rows when bound to a populated list slot', () => {
    fixture.componentRef.setInput(
      'bound',
      listBound([
        { id: '1', name: 'Flour' },
        { id: '2', name: 'Eggs' },
      ])
    );
    fixture.detectChanges();

    expect(component.resolved).toBe('populated');
    expect(component.rows.length).toBe(3); // count row + 2 item rows
    expect(component.rows[0].label).toBe('Ingredients tracked');
    expect(component.rows[0].display).toBe('2');
    expect(component.rows[1].display).toBe('Flour');
    expect(component.rows[2].display).toBe('Eggs');
  });

  it('re-renders with the new derived value when the bound list changes (reactivity proof)', () => {
    fixture.componentRef.setInput('bound', listBound([{ id: '1', name: 'Flour' }]));
    fixture.detectChanges();
    expect(component.rows[0].display).toBe('1');

    fixture.componentRef.setInput(
      'bound',
      listBound(
        [
          { id: '1', name: 'Flour' },
          { id: '2', name: 'Eggs' },
          { id: '3', name: 'Milk' },
        ],
        { version: 2 }
      )
    );
    fixture.detectChanges();

    expect(component.rows[0].display).toBe('3');
    expect(component.rows.map((r) => r.display)).toContain('Milk');

    // The DOM actually reflects the update, not just the component model.
    const values = fixture.nativeElement.querySelectorAll('.kv-value');
    expect(values[0].textContent?.trim()).toBe('3');
  });

  it('renders the empty state (naming the slot) when bound to an empty list', () => {
    fixture.componentRef.setInput('bound', listBound([]));
    fixture.detectChanges();

    expect(component.resolved).toBe('empty');
    const empty = fixture.nativeElement.querySelector('.empty');
    expect(empty?.textContent).toContain('No ingredients yet');
  });

  it('renders the loading state while the bound slot has not populated yet', () => {
    fixture.componentRef.setInput('bound', listBound(undefined));
    fixture.detectChanges();

    expect(component.resolved).toBe('loading');
    expect(fixture.nativeElement.querySelector('.kv-loading')).toBeTruthy();
  });

  it('surfaces read-only + writer attribution from the bound state (contract §5)', () => {
    fixture.componentRef.setInput(
      'bound',
      listBound([{ id: '1', name: 'Flour' }], { readonly: true, writer: 'Cooking Assistant' })
    );
    fixture.detectChanges();

    expect(component.readonly).toBe(true);
    expect(component.writer).toBe('Cooking Assistant');
    const provenance = fixture.nativeElement.querySelector('.kv-provenance');
    expect(provenance?.textContent).toContain('Cooking Assistant');
  });

  it('echoes a bound record slot\'s own fields verbatim (no fabrication)', () => {
    fixture.componentRef.setInput('bound', {
      slot: 'trip_summary',
      kind: 'record',
      value: { nights: 5, climate: 'Warm' },
      version: 1,
      readonly: false,
      writerId: 'travel-planner',
      writer: 'Travel Planner',
    } as BoundState<Record<string, unknown>>);
    fixture.detectChanges();

    expect(component.resolved).toBe('populated');
    expect(component.rows.length).toBe(2);
    expect(component.rows.find((r) => r.key === 'nights')?.display).toBe('5');
    expect(component.rows.find((r) => r.key === 'climate')?.display).toBe('Warm');
  });

  it("echoes a bound scalar slot's own value verbatim", () => {
    component.title = 'Status';
    fixture.componentRef.setInput('bound', {
      slot: 'status',
      kind: 'scalar',
      value: 'Simmering',
      version: 1,
      readonly: false,
      writerId: null,
      writer: null,
    } as BoundState<string>);
    fixture.detectChanges();

    expect(component.rows.length).toBe(1);
    expect(component.rows[0].display).toBe('Simmering');
  });

  it('renders declared static props unchanged when NOT bound (self-sourcing)', () => {
    fixture.componentRef.setInput('fields', [{ key: 'nights', label: 'Nights' }]);
    fixture.componentRef.setInput('values', { nights: { raw: 5, present: true } });
    fixture.detectChanges();

    expect(component.resolved).toBe('populated');
    expect(component.rows.length).toBe(1);
    expect(component.rows[0].label).toBe('Nights');
    expect(component.rows[0].display).toBe('5');
  });

  it('shows the generic empty state when unbound and no fields are declared', () => {
    fixture.detectChanges();

    expect(component.resolved).toBe('empty');
    const empty = fixture.nativeElement.querySelector('.empty');
    expect(empty?.textContent).toContain('No data');
  });

  it('never fabricates a numeric nutrition value — bound rows are count/name only', () => {
    fixture.componentRef.setInput(
      'bound',
      listBound([
        { id: '1', name: 'Chicken breast' },
        { id: '2', name: 'Rice' },
      ])
    );
    fixture.detectChanges();

    const forbidden = ['calorie', 'kcal', 'protein', 'carb', 'fat', 'mg', 'gram'];
    const text = component.rows
      .map((r) => `${r.label} ${r.display}`)
      .join(' ')
      .toLowerCase();
    for (const term of forbidden) {
      expect(text).not.toContain(term);
    }
    // Only the honest, derivable values appear: the live count, then each item's own name.
    expect(component.rows.map((r) => r.display)).toEqual(['2', 'Chicken breast', 'Rice']);
  });
});
