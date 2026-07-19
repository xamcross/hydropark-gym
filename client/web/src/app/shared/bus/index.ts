/* =============================================================================
   HYDROPARK — EVENT + STATE BUS, PUBLIC SURFACE  (P1-06.2 · SPEC §9.3)
   -----------------------------------------------------------------------------
   The one import point for the per-agent event + state bus. Consumers import
   from `shared/bus`; the file split (contract / routing / store / service) is an
   internal concern.
   ============================================================================= */

export * from './bus.contract';
export * from './bus.routing';
export { SharedStateStore } from './bus.store';
export type { ApplyResult } from './bus.store';
export { BusService } from './bus.service';
