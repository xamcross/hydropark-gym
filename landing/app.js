/* ============================================================================
   HYDROPARK — landing page behaviour
   No dependencies. Everything degrades: without JS the page shows the
   transformed app statically (see styles.css §18).
   ========================================================================= */
(function () {
  'use strict';

  /* -- Configuration ------------------------------------------------------ */

  // The live hosted checkout. Phase 0 uses a Stripe payment link; production
  // swaps this for the merchant-of-record checkout without touching anything else.
  var CHECKOUT_URL = 'https://buy.stripe.com/REPLACE_ME';

  var doc = document;
  var root = doc.documentElement;
  root.classList.add('js');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var clamp = function (n, a, b) { return n < a ? a : n > b ? b : n; };

  /* -- Analytics ----------------------------------------------------------
     The cold-cohort conversion number is the whole point of this page, so the
     funnel is instrumented explicitly rather than inferred from pageviews.   */

  function track(name, props) {
    var payload = props || {};
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: name }, payload));
    if (typeof window.plausible === 'function') window.plausible(name, { props: payload });
    if (typeof window.gtag === 'function') window.gtag('event', name, payload);
  }

  var fired = Object.create(null);
  function once(name, props) {
    if (fired[name]) return;
    fired[name] = true;
    track(name, props);
  }

  track('lp_view', { path: location.pathname });

  /* -- Checkout ------------------------------------------------------------ */

  $$('[data-checkout]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      track('checkout_click', { location: btn.getAttribute('data-loc') || 'unknown' });

      if (CHECKOUT_URL.indexOf('REPLACE_ME') !== -1) {
        console.warn('[hydropark] CHECKOUT_URL is still a placeholder — set it in app.js.');
        btn.setAttribute('data-armed', 'no');
        return;
      }
      window.location.href = CHECKOUT_URL;
    });
  });

  /* -- Unit system --------------------------------------------------------
     The segmented toggle inside the mock drives every quantity on the page —
     including the ones in the ingredient panel. It is the product feature,
     working, rather than a screenshot of the product feature.               */

  var units = 'us';

  function setUnits(next) {
    if (next === units) return;
    units = next;

    var seg = $('.seg');
    if (seg) {
      seg.setAttribute('data-on', units);
      $$('.seg__opt', seg).forEach(function (opt) {
        var on = opt.getAttribute('data-units') === units;
        opt.classList.toggle('is-on', on);
        opt.setAttribute('aria-checked', String(on));
      });
    }

    $$('.qty[data-us]').forEach(function (el) {
      var value = el.getAttribute(units === 'us' ? 'data-us' : 'data-si');
      if (!value || el.textContent === value) return;
      el.textContent = value;
      if (reduced) return;
      el.classList.remove('is-flip');
      void el.offsetWidth;                  // restart the animation
      el.classList.add('is-flip');
    });

    track('metric_toggled', { system: units });
  }

  var segOpts = $$('.seg__opt');
  segOpts.forEach(function (opt, i) {
    opt.addEventListener('click', function () { setUnits(opt.getAttribute('data-units')); });
    opt.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = segOpts[(i + (e.key === 'ArrowRight' ? 1 : segOpts.length - 1)) % segOpts.length];
      next.focus();
      setUnits(next.getAttribute('data-units'));
    });
  });

  /* -- Timers -------------------------------------------------------------
     A genuine countdown. The pasta timer arrives with 14 seconds left, so a
     visitor who stops to read the panel gets the alarm, the ring turning, and
     the system line posted into the transcript — the §9.3 event contract.   */

  var RING = 2 * Math.PI * 19;

  function Timer(el) {
    this.el = el;
    this.total = Number(el.getAttribute('data-total'));
    this.left = Number(el.getAttribute('data-left'));
    this.time = $('.timer__time', el);
    this.ring = $('.timer__ring-fg', el);
    this.act = $('.timer__act', el);
    this.name = $('.timer__name', el).textContent.trim();
    this.running = false;
    this.tick = null;

    this.act.addEventListener('click', this.onAct.bind(this));
    this.render();
  }

  Timer.prototype.fmt = function () {
    var m = Math.floor(this.left / 60), s = this.left % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  Timer.prototype.render = function () {
    this.time.textContent = this.fmt();
    this.ring.style.strokeDasharray = RING;
    this.ring.style.strokeDashoffset = RING * (1 - this.left / this.total);
    var done = this.left === 0;
    this.el.classList.toggle('is-done', done);
    this.el.classList.toggle('is-idle', !this.running && !done);
    this.act.textContent = done ? '↺' : this.running ? '❚❚' : '▶';
    this.act.setAttribute('aria-label',
      (done ? 'Reset ' : this.running ? 'Pause ' : 'Start ') + this.name + ' timer');
  };

  Timer.prototype.start = function () {
    if (this.running || this.left === 0) return;
    this.running = true;
    this.time.setAttribute('aria-live', 'off');
    var self = this;
    this.tick = setInterval(function () {
      self.left = Math.max(0, self.left - 1);
      self.render();
      if (self.left === 0) self.finish();
    }, 1000);
    this.render();
  };

  Timer.prototype.pause = function () {
    this.running = false;
    clearInterval(this.tick);
    this.render();
  };

  Timer.prototype.finish = function () {
    this.pause();
    this.time.setAttribute('aria-live', 'polite');
    postToChat('⏱ ' + this.name + ' timer finished');
    once('timer_finished', { timer: this.name });
  };

  Timer.prototype.onAct = function () {
    once('timer_interacted');
    if (this.left === 0) { this.left = this.total; this.render(); return; }
    this.running ? this.pause() : this.start();
  };

  var timers = $$('.timer').map(function (el) { return new Timer(el); });
  var pasta = timers[0];

  /* A widget event with to_chat: it appends to the transcript. It does not
     wake the model — that only happens on the next user turn (§9.3). */
  function postToChat(text) {
    var anchor = $('#chatAnchor');
    if (!anchor) return;
    var line = doc.createElement('p');
    line.className = 'msg msg--sys is-alarm';
    line.textContent = text;
    anchor.parentNode.insertBefore(line, anchor);
  }

  /* -- The scroll state machine -------------------------------------------
     Four stages scrubbed against a pinned window. Stage is an attribute; all
     of the choreography lives in CSS so it stays cheap and interruptible.   */

  var track$ = $('#track');
  var pin = $('#pin');
  var railSteps = $$('.rail__step');
  var installFill = $('.sheet__fill');
  var installPct = $('#installPct');
  var progressBar = $('#progressBar');

  var STAGES = [
    { at: 0.00 },   // 0 — base agent
    { at: 0.16 },   // 1 — installing
    { at: 0.42 },   // 2 — cooking tool
    { at: 0.72 }    // 3 — two skills, one list
  ];

  var stage = -1;

  function setStage(next) {
    if (next === stage) return;
    stage = next;
    pin.setAttribute('data-stage', String(stage));
    railSteps.forEach(function (s) {
      s.classList.toggle('is-on', Number(s.getAttribute('data-for')) === stage);
    });
    if (stage >= 2 && pasta && !pasta.running && pasta.left > 0) pasta.start();

    // The nutrition panel lands below the fold of a full dock; bring it into
    // view so the second skill's arrival is actually witnessed.
    var dock = $('.dock');
    if (dock) {
      dock.scrollTo({
        top: stage === 3 ? dock.scrollHeight : 0,
        behavior: reduced ? 'auto' : 'smooth'
      });
    }

    if (stage === 3) once('transform_complete');
  }

  function onTransformScroll() {
    if (!track$ || !pin) return;

    var rect = track$.getBoundingClientRect();
    var span = track$.offsetHeight - window.innerHeight;
    var p = clamp(-rect.top / (span || 1), 0, 1);

    var next = 0;
    for (var i = STAGES.length - 1; i >= 0; i--) {
      if (p >= STAGES[i].at) { next = i; break; }
    }
    setStage(next);

    // Install progress: fills across band 1, pinned at 100% once past it.
    var band = (p - STAGES[1].at) / (STAGES[2].at - STAGES[1].at);
    var installed = Math.round(clamp(band, 0, 1) * 100);
    if (installFill) installFill.style.width = installed + '%';
    if (installPct) installPct.textContent = String(installed);
  }

  /* -- Page scroll progress + depth ---------------------------------------- */

  var depths = [25, 50, 75, 100];

  function onPageScroll() {
    var h = doc.documentElement.scrollHeight - window.innerHeight;
    var p = clamp(window.scrollY / (h || 1), 0, 1);
    if (progressBar) progressBar.style.height = (p * 100) + '%';

    var pct = Math.round(p * 100);
    depths.forEach(function (d) {
      if (pct >= d) once('scroll_depth_' + d, { depth: d });
    });
  }

  var queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      onTransformScroll();
      onPageScroll();
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  /* -- Replay -------------------------------------------------------------- */

  var replay = $('#replay');
  if (replay && track$) {
    replay.addEventListener('click', function () {
      track('transform_replay');
      window.scrollTo({
        top: track$.getBoundingClientRect().top + window.scrollY + 2,
        behavior: reduced ? 'auto' : 'smooth'
      });
    });
  }

  /* -- Wi-Fi kill switch ---------------------------------------------------- */

  var wifi = $('#wifi');
  var wifiSay = $('#wifiSay');
  if (wifi && wifiSay) {
    wifi.addEventListener('click', function () {
      var on = wifi.getAttribute('aria-checked') === 'true';
      wifi.setAttribute('aria-checked', String(!on));
      wifiSay.classList.toggle('is-off', on);
      wifiSay.textContent = on
        ? 'Disconnected. Everything above still works.'
        : 'Connected. Not that it matters much.';
      track('wifi_toggled', { connected: !on });
    });
  }

  /* -- Reveal on scroll ----------------------------------------------------- */

  if ('IntersectionObserver' in window && !reduced) {
    var targets = $$([
      '.pull', '.thesis__cols', '.card', '.honest',
      '.hw__lede', '.ledger', '.matrix', '.killswitch',
      '.offline .h2', '.lede--night',
      '.price__fig', '.price__h', '.price__body',
      '.faq details', '.closer > *'
    ].join(','));

    targets.forEach(function (el) { el.classList.add('reveal'); });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    targets.forEach(function (el) { io.observe(el); });
  }
})();
