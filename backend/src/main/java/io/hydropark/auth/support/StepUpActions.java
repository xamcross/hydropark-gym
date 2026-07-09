package io.hydropark.auth.support;

import io.hydropark.port.Ports;

/**
 * Canonical step-up action names. A step-up proof is bound to exactly one of these (§8, SF11), so a
 * challenge obtained for one perpetual effect cannot be replayed against another.
 *
 * <p>{@link #DEVICE_REGISTER} is special: it is the only action to which trust-on-first-use applies
 * (the genuinely first device an account ever binds). Every other action always requires a valid
 * out-of-band proof.
 *
 * <p>The values are re-exported from {@link Ports.StepUpActions}, which is the single definition.
 * They were once declared independently here and drifted from what {@code devices} and
 * {@code licensing} actually sent - a mismatch no compiler could catch, because the contract is a
 * String. Do not reintroduce literals in this file.
 */
public final class StepUpActions {

  private StepUpActions() {}

  /** Binding a device (§4.6). TOFU-eligible for the first device an account ever binds. */
  public static final String DEVICE_REGISTER = Ports.StepUpActions.DEVICE_REGISTER;

  /** Minting a perpetual license (§4.4). Always requires a proof. */
  public static final String LICENSE_ISSUE = Ports.StepUpActions.LICENSE_ISSUE;

  /** Deauthorising the last active device (§4.6). Always requires a proof. */
  public static final String DEVICE_DEAUTHORIZE_LAST = Ports.StepUpActions.DEVICE_DEAUTHORIZE_LAST;
}
