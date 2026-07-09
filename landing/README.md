# Hydropark — cold-cohort landing page

The standalone landing page for the **H3 willingness-to-pay smoke test**
(PHASE0-PLAN.md §4c). Its only job is to take cold, largely non-enthusiast
traffic and convert it on one real SKU: **Cooking Assistant, $5, one-time**.

Three static files, no build step, no dependencies. Drop them on any static
host. Fonts come from Google Fonts; everything else is inline.

```
index.html    markup + copy
styles.css    the whole design system
app.js        scroll state machine, timer, unit toggle, funnel events
```

## Before it goes live

1. **Set the checkout URL.** `app.js`, top of the file:

   ```js
   var CHECKOUT_URL = 'https://buy.stripe.com/REPLACE_ME';
   ```

   While it still says `REPLACE_ME` the buttons fire the analytics event, log a
   console warning, and *do not navigate* — so a misconfigured deploy cannot
   silently swallow a click. Phase 0 uses a Stripe payment link; production
   swaps in the merchant-of-record checkout and nothing else changes.

2. **Point the footer links** at real `/privacy` and `/terms` pages. The terms
   must carry the business-continuity commitment (SPEC §28.2) — the FAQ
   promises it by name.

3. **Set the support address.** `hello@hydropark.app` appears in the footer.

## Measuring the cohort

`track()` in `app.js` pushes to `window.dataLayer` and forwards to
`window.plausible` / `window.gtag` if either is present. Add your analytics
snippet to `<head>` and the events flow automatically.

| Event | Fires when |
|---|---|
| `lp_view` | page load |
| `scroll_depth_25/50/75/100` | once each, on page progress |
| `transform_complete` | visitor scrolls the demonstration to its final stage |
| `metric_toggled` | US ↔ Metric switch used (`{system}`) |
| `timer_interacted` | a timer is started, paused or reset |
| `wifi_toggled` | the offline kill switch is flipped |
| `checkout_click` | any buy button (`{location}`: masthead / hero / price / closer) |
| `transform_replay` | the ↻ Replay button |

`checkout_click` by `location` is what tells you which argument sold. The
deciding metric is still **completed real captures ÷ unique visitors**, counted
at the payment provider — not `checkout_click` (SPEC §25.1).

Report the **install-friction drop-off** (paid → downloaded → redeemed) beside
the conversion rate. The page discloses the ~2 GB model download in three
places on purpose; a low number must not be misread as low demand.

## Design notes

A printed kitchen manual: paper stock, letterpress ink, one stove-flame accent
(`--flame`), hairline rules, drafting registration marks. Fraunces (display),
Newsreader (body), DM Mono (labels and numerals).

The centrepiece is a scroll-pinned mock of the app that scrubs through four
stages — base agent → install sheet → panels arriving → two skills sharing one
ingredient list. It is driven by a `data-stage` attribute on `#pin`; all
choreography lives in CSS, so it is cheap and interruptible.

Two things in it are real rather than depicted, which is the point of the page:

- the **pasta timer** counts down (it arrives with 14 seconds left), fires an
  alarm, and posts a system line into the transcript — the `to_chat` widget
  event contract from SPEC §9.3;
- the **US ↔ Metric toggle** re-renders every quantity on the page, including
  the ones in the ingredient panel further down.

Details are drawn from the spec, not invented: the permission ticket (§8.5),
the capacity meter (§8.3.5), the deterministic allergen chip (§28.1), the
offline matrix (§14), and the carbonara worked example (§17). If the product
changes, these should change with it.

### Accessibility

WCAG-AA contrast in both the paper and night sections; full keyboard operation
(the segmented control is a real radiogroup with arrow keys); `prefers-reduced-motion`
disables the reveals and the alarm flash. Without JavaScript the demonstration
renders statically in its transformed state rather than showing an empty frame.

Below 700px the side dock becomes a bottom drawer — the same move the real app
makes (SPEC §9.5), because a 164px side column clips its own panels.
