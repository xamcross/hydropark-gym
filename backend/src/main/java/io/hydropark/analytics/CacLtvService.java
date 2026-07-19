package io.hydropark.analytics;

import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * P1-25.4 - CAC, CAC-payback, and LTV by channel with <b>organic-only attribution</b> (SPEC §27.2).
 * There is no paid ad spend, cold or warm; a channel's cost is its content/production/organic cost, so
 * "CAC" is measurement, not ad budget. Channels whose LTV:CAC falls below the target are flagged to be
 * killed.
 *
 * <pre>
 *   CAC (per install)  = channel cost / installs
 *   LTV (per install)  = net revenue attributed to the channel / installs
 *   LTV:CAC            = net revenue / channel cost
 *   CAC-payback factor = LTV-per-install / CAC-per-install  (≥1 ⇒ first-order revenue covers CAC)
 *   kill               = channel HAS cost AND LTV:CAC < target
 * </pre>
 *
 * <p>A pure-organic channel with <b>zero</b> attributable cost has an undefined (infinite) LTV:CAC; it
 * is reported as {@code null} rather than {@code Infinity} (so the JSON is well-formed) and is never
 * killed - a free channel that produces any revenue cannot fail a cost-efficiency target.
 *
 * <p><b>Pure by construction:</b> {@link #evaluateChannel}/{@link #evaluate} are total functions over
 * pre-fetched per-channel counts; no datastore.
 */
@Service
public class CacLtvService {

  /**
   * A channel's measured inputs for the period. {@code channelCostMinor} is content/production/organic
   * cost (never paid acquisition), minor units.
   */
  public record ChannelInputs(
      String channel, long installs, long payers, long netRevenueMinor, long channelCostMinor) {}

  public record ChannelEconomics(
      String channel,
      long installs,
      long payers,
      long netRevenueMinor,
      long channelCostMinor,
      double cacPerInstallMinor,
      double ltvPerInstallMinor,
      double ltvPerPayerMinor,
      Double ltvToCacRatio,
      Double cacPaybackFactor,
      boolean killChannel) {}

  public record CacLtvReport(
      List<ChannelEconomics> channels, ChannelEconomics blended, double ltvToCacTarget) {}

  public ChannelEconomics evaluateChannel(ChannelInputs in, double ltvToCacTarget) {
    double cac = in.installs() == 0 ? 0.0 : (double) in.channelCostMinor() / in.installs();
    double ltvPerInstall = in.installs() == 0 ? 0.0 : (double) in.netRevenueMinor() / in.installs();
    double ltvPerPayer = in.payers() == 0 ? 0.0 : (double) in.netRevenueMinor() / in.payers();

    // Undefined (null), not Infinity, when there is no attributable cost - keeps the JSON well-formed
    // and marks a pure-organic channel as "cost-free" rather than fabricating a ratio.
    Double ltvToCac =
        in.channelCostMinor() <= 0 ? null : (double) in.netRevenueMinor() / in.channelCostMinor();
    Double payback = cac <= 0.0 ? null : ltvPerInstall / cac;

    // Kill only a channel that HAS cost and fails the target. Compared as net < target × cost to avoid
    // any division; a zero-cost channel is never killed.
    boolean kill =
        in.channelCostMinor() > 0
            && (double) in.netRevenueMinor() < ltvToCacTarget * in.channelCostMinor();

    return new ChannelEconomics(
        in.channel(),
        in.installs(),
        in.payers(),
        in.netRevenueMinor(),
        in.channelCostMinor(),
        cac,
        ltvPerInstall,
        ltvPerPayer,
        ltvToCac,
        payback,
        kill);
  }

  /** Evaluate each channel and a {@code "blended"} roll-up across all of them. */
  public CacLtvReport evaluate(List<ChannelInputs> channels, double ltvToCacTarget) {
    List<ChannelInputs> src = channels == null ? List.of() : channels;
    List<ChannelEconomics> out = new ArrayList<>(src.size());
    long installs = 0, payers = 0, net = 0, cost = 0;
    for (ChannelInputs c : src) {
      out.add(evaluateChannel(c, ltvToCacTarget));
      installs += c.installs();
      payers += c.payers();
      net += c.netRevenueMinor();
      cost += c.channelCostMinor();
    }
    ChannelEconomics blended =
        evaluateChannel(new ChannelInputs("blended", installs, payers, net, cost), ltvToCacTarget);
    return new CacLtvReport(List.copyOf(out), blended, ltvToCacTarget);
  }
}
