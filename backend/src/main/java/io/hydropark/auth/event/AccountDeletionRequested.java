package io.hydropark.auth.event;

/**
 * Published by {@code auth} when a user requests GDPR deletion (§8, P1-12.6). The {@code auth}
 * package anonymises its own collections in place, but user-referenced data owned by other packages -
 * {@code devices}, {@code wallet}, {@code grants}, {@code orders}, download watermark buyer-tokens -
 * is <b>not</b> ours to delete. Those packages listen for this event (e.g. with
 * {@code @TransactionalEventListener}) and cascade their own cleanup.
 *
 * <p>Published as a plain payload via {@code ApplicationEventPublisher} (Spring wraps it in a
 * {@code PayloadApplicationEvent}); listeners subscribe with {@code @EventListener}.
 */
public record AccountDeletionRequested(String userId) {}
