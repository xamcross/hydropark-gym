/* ============================================================================
   HYDROPARK — the agent gym
   The loadout planner runs the app's own merge algorithm: one skill leads and
   spends its full prompt, the rest contribute a line plus their tools and
   panels; tools and panels are unioned and deduplicated; the capacity meter
   blocks on context overflow and warns on speed. Numbers are the app's
   estimates, not marketing figures.
   ========================================================================= */
(function () {
  'use strict';

  /* -- Configuration -------------------------------------------------------- */

  /* Launch GATES. While either still contains `REPLACE_ME`, its button fires the
     analytics event, logs a console warning, and deliberately DOES NOT navigate,
     so a bad deploy cannot silently eat clicks (see the handlers at the bottom).

     CHECKOUT_URL is the payment-provider seam (P1-24.1). The buy button hands the
     basket to a single hosted-checkout URL; the provider is a Merchant-of-Record
     (MoR) hosted checkout that is the seller of record and derives the final,
     tax-inclusive price from (target skills, region) server-side — the page only
     passes which skills. Swapping providers is a ONE-LINE change here; nothing
     downstream depends on the provider. The live MoR merchant account is a launch
     gate: do NOT point this at a test link (that is exactly what P1-24.1 removes).
     Keep the `REPLACE_ME` sentinel until the real MoR checkout base URL exists. */
  var DOWNLOAD_URL = 'https://hydropark.app/download/REPLACE_ME';
  var CHECKOUT_URL = 'https://hydropark.app/checkout/REPLACE_ME';   // MoR hosted-checkout seam — GATE

  // Prompt accounting, matching the app's capacity meter.
  var PREAMBLE = 150;      // base safety/formatting preamble, always present
  var BASE_PERSONA = 210;  // the base agent's own persona, used when no skill may lead
  var TOOL_COST = 140;     // one tool's JSON schema + description
  var SLUGGISH = 4.5;      // tokens/sec below which we warn

  var TIERS = {
    minimum:     { budget: 1500, tokps: 6.5,  label: '8 GB, no graphics card' },
    recommended: { budget: 2600, tokps: 13,   label: '16 GB, modern processor' },
    enhanced:    { budget: 3800, tokps: 32,   label: 'discrete or integrated GPU' }
  };

  // Bundle pricing (spec §26.1): 3 for $12, 5 for $18, else $5 each.
  function priceFor(n) {
    if (n >= 5) return 18 + (n - 5) * 5;
    if (n >= 3) return 12 + (n - 3) * 5;
    return n * 5;
  }

  var doc = document;
  var root = doc.documentElement;
  root.classList.add('js');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var clamp = function (n, a, b) { return n < a ? a : n > b ? b : n; };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  function track(name, props) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: name }, props || {}));
    if (typeof window.plausible === 'function') window.plausible(name, { props: props || {} });
  }

  /* -- Read the catalogue out of the DOM ------------------------------------ */

  var list = function (el, name) {
    var v = el.getAttribute('data-' + name);
    return v ? v.split(',') : [];
  };

  var SKILLS = $$('.plate').map(function (el) {
    return {
      el: el,
      id: el.getAttribute('data-id'),
      name: el.getAttribute('data-name'),
      price: Number(el.getAttribute('data-price')),
      role: el.getAttribute('data-role'),
      priority: Number(el.getAttribute('data-priority')),
      prompt: Number(el.getAttribute('data-prompt')),
      fewshot: Number(el.getAttribute('data-fewshot')),
      compressed: Number(el.getAttribute('data-compressed')),
      tools: list(el, 'tools'),
      panels: list(el, 'panels'),
      writes: list(el, 'writes'),
      reads: list(el, 'reads'),
      conflicts: list(el, 'conflicts'),
      snippet: el.getAttribute('data-snippet') || '',
      persona: el.getAttribute('data-persona') || ''
    };
  });

  var byId = {};
  SKILLS.forEach(function (s) { byId[s.id] = s; });

  /* -- Cost provenance (P1-24.3) -------------------------------------------- */
  /* Plate costs must trace to the SHIPPED catalog's certified `cost_estimate`,
     never a hand-tuned figure (README §Tuning; SPEC §8.5/§11.2). Each plate
     declares `data-certified` and `data-cost-source`:
       · certified="true"  — the plate's lead figure (`data-prompt` + `data-fewshot`)
         equals the manifest's `cost_estimate.prompt_tokens`, mirrored in
         `data-cost-estimate`. Today that is kitchen-timer (190) and
         cooking-assistant (380), sourced from contracts/examples/*.manifest.json.
       · certified="false" — a DESIGN ESTIMATE, shown so the planner still reads as
         a full rack, but its skill is not yet authored/certified under
         contracts/catalog/ (blocked on P1-22). Not presented as a real cost.
     This block asserts the trace at load and logs any drift, so a future catalog
     edit that forgets to update a plate is caught in the console rather than
     shipping a page that lies about the meter (README invariant).

     KNOWN DIVERGENCE (flagged for the P1-24.3 follow-up, not fixed here): the
     shipped capacity gate (client/src-tauri/src/capacity.rs) charges EVERY enabled
     skill its full `cost_estimate.prompt_tokens + tools*8 + panels*16` against a
     fixed model context window with a working reserve — it does NOT discount
     secondaries to a compressed line, does NOT union/dedupe tools for costing, and
     does NOT vary the budget by hardware tier (hardware changes speed, not what
     fits). This page still models §8.3.1 prompt-ASSEMBLY (lead-heavy) for the bar
     and the assembled-prompt panel. Reconciling the METER's arithmetic with
     capacity.rs is tracked work and needs the full certified catalog to land. */
  (function verifyCostProvenance() {
    SKILLS.forEach(function (s) {
      var certified = s.el.getAttribute('data-certified') === 'true';
      var est = Number(s.el.getAttribute('data-cost-estimate'));
      var src = s.el.getAttribute('data-cost-source') || '(no data-cost-source)';
      if (certified) {
        if (!(est > 0) || (s.prompt + s.fewshot) !== est) {
          console.warn('[hydropark] plate "' + s.id + '" is marked certified but its lead cost ' +
            (s.prompt + s.fewshot) + ' does not equal cost_estimate.prompt_tokens ' + est +
            ' — reconcile with ' + src);
        }
      } else {
        console.info('[hydropark] plate "' + s.id + '" cost is a design estimate pending certification: ' + src);
      }
    });
  })();

  /* -- State ---------------------------------------------------------------- */

  var selected = [];          // array of skill ids, insertion order
  var tier = 'recommended';
  var leadOverride = null;

  var els = {
    bench: $('.bench'),
    bar: $('#barGroup'),
    barSvg: $('#barSvg'),
    lead: $('#leadLine'),
    alert: $('#alert'),
    tokUsed: $('#tokUsed'),
    tokBudget: $('#tokBudget'),
    tokFill: $('#tokFill'),
    verdict: $('#verdict'),
    tokps: $('#tokps'),
    nSkills: $('#nSkills'),
    nTools: $('#nTools'),
    nPanels: $('#nPanels'),
    wires: $('#wires'),
    wiresList: $('#wiresList'),
    panelWrap: $('#panelWrap'),
    panelList: $('#panelList'),
    dupeNote: $('#dupeNote'),
    assembled: $('#assembled'),
    basketPrice: $('#basketPrice'),
    basketNote: $('#basketNote'),
    buyBtn: $('#buyBtn'),
    copyBtn: $('#copyBtn')
  };

  /* -- The merge algorithm (spec §8.3) -------------------------------------- */

  function pickLead(skills) {
    var eligible = skills.filter(function (s) { return s.role === 'primary_eligible'; });
    if (!eligible.length) return null;
    if (leadOverride && byId[leadOverride] && eligible.indexOf(byId[leadOverride]) !== -1) {
      return byId[leadOverride];
    }
    return eligible.slice().sort(function (a, b) {
      return (b.priority - a.priority) || (a.id < b.id ? -1 : 1);
    })[0];
  }

  function compute(ids) {
    var skills = ids.map(function (id) { return byId[id]; });
    var lead = pickLead(skills);
    var secondaries = skills.filter(function (s) { return s !== lead; });

    var tools = {}, panels = {}, panelCount = 0;
    skills.forEach(function (s) {
      s.tools.forEach(function (t) { tools[t] = true; });
      s.panels.forEach(function (p) { panels[p] = true; panelCount++; });
    });
    var toolList = Object.keys(tools);
    var panelList = Object.keys(panels);

    var tokens = PREAMBLE
      + (lead ? lead.prompt + lead.fewshot : BASE_PERSONA)
      + secondaries.reduce(function (n, s) { return n + s.compressed; }, 0)
      + toolList.length * TOOL_COST;

    var budget = TIERS[tier].budget;
    var load = tokens / budget;
    var tokps = TIERS[tier].tokps * (1 - 0.35 * Math.min(load, 1));

    var verdict = 'ready';
    if (tokens > budget) verdict = 'blocked';
    else if (tokps < SLUGGISH) verdict = 'sluggish';

    return {
      skills: skills, lead: lead, secondaries: secondaries,
      tools: toolList, panels: panelList, dupes: panelCount - panelList.length,
      tokens: tokens, budget: budget, load: load, tokps: tokps, verdict: verdict
    };
  }

  /* -- Guards: conflicts and capacity --------------------------------------- */

  function conflictWith(id, ids) {
    var s = byId[id];
    var hit = ids.filter(function (o) {
      return s.conflicts.indexOf(o) !== -1 || byId[o].conflicts.indexOf(id) !== -1;
    });
    return hit.length ? byId[hit[0]] : null;
  }

  /** The heaviest secondary is what the app suggests dropping. `exceptId` keeps it
      from suggesting you drop the very plate you just tried to add. */
  function heaviestSecondary(state, exceptId) {
    var pool = state.secondaries.filter(function (s) { return s.id !== exceptId; });
    if (!pool.length) return null;
    return pool.slice().sort(function (a, b) { return b.compressed - a.compressed; })[0];
  }

  /* A refusal is the user's answer to a thing they just tried, so it outranks the
     meter's own commentary until they act again. `sticky` protects it from render(). */
  var sticky = false;

  function say(msg, kind) {
    els.alert.textContent = msg || '';
    if (kind) els.alert.setAttribute('data-kind', kind);
    else els.alert.removeAttribute('data-kind');
  }

  function clearAlert() { sticky = false; say(''); }

  function refuse(skill, msg) {
    sticky = true;
    say(msg, 'error');

    if (!reduced) {
      skill.el.classList.remove('is-refused');
      void skill.el.offsetWidth;
      skill.el.classList.add('is-refused');
    }

    // On a narrow screen the bar sits below the whole plate list, so a refusal
    // would read as "the tap did nothing". Bring the explanation to them.
    if (window.innerWidth <= 1000) {
      els.alert.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    }
  }

  /* -- Toggling ------------------------------------------------------------- */

  function toggle(id) {
    var skill = byId[id];
    var i = selected.indexOf(id);

    if (i !== -1) {                       // removing is always allowed
      selected.splice(i, 1);
      if (leadOverride === id) leadOverride = null;
      clearAlert();
      render();
      track('plate_removed', { skill: id });
      return;
    }

    var clash = conflictWith(id, selected);
    if (clash) {
      refuse(skill, 'Refused — ' + skill.name + ' and ' + clash.name +
        ' are the same muscle at different sizes. Carry one.');
      track('plate_refused', { skill: id, reason: 'conflict' });
      return;
    }

    var next = compute(selected.concat([id]));
    if (next.verdict === 'blocked') {
      var drop = heaviestSecondary(next, id);
      var over = next.tokens - next.budget;
      refuse(skill, 'Over capacity by ' + over + ' tokens on this bench. ' +
        (drop
          ? 'Drop ' + drop.name + ', or move to a bigger machine.'
          : 'This plate alone is too heavy for this bench.'));
      track('plate_refused', { skill: id, reason: 'capacity', tier: tier });
      return;
    }

    selected.push(id);
    clearAlert();
    render();
    track('plate_added', { skill: id, total: selected.length });
  }

  /* -- Rendering: the bar ---------------------------------------------------- */

  var CX = 320, Y0 = 112, HALF = 292;
  var GRIP = 96;        // half-width of the knurled grip
  var COLLAR = 106;     // where the sleeve starts
  var PLATE_0 = 120;    // first plate sits just outside the collar
  var PLATE_GAP = 18;   // and the rest stack outward toward the sleeve tip

  function yAt(x, bend) { var t = (x - CX) / HALF; return Y0 + bend * t * t; }
  function slopeAt(x, bend) { return 2 * bend * (x - CX) / (HALF * HALF); }

  function svg(tag, attrs) {
    var e = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function renderBar(state) {
    var g = els.bar;
    while (g.firstChild) g.removeChild(g.firstChild);

    var bend = 26 * Math.min(state.load, 1.2);
    // The bar takes the dim sulphur when warning, so the bright plates stay legible
    // against it; only a hard block turns it rust.
    var barColor = state.verdict === 'blocked' ? '#C4491F'
      : state.verdict === 'sluggish' ? '#A8870E' : '#98A09B';

    // the bar itself, sampled along the curve
    var d = '';
    for (var x = 28; x <= 612; x += 18) d += (d ? 'L' : 'M') + x + ' ' + yAt(x, bend).toFixed(1) + ' ';
    g.appendChild(svg('path', {
      d: d.trim(), fill: 'none', stroke: barColor, 'stroke-width': 7,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));

    // knurled grip, centred where the agent holds it
    var gy = yAt(CX, bend);
    g.appendChild(svg('rect', { x: CX - GRIP, y: gy - 6, width: GRIP * 2, height: 12, rx: 2, fill: barColor }));
    g.appendChild(svg('rect', { x: CX - GRIP, y: gy - 6, width: GRIP * 2, height: 12, rx: 2, fill: 'url(#knurlpat)' }));

    // collars, just inboard of the first plate
    [-COLLAR, COLLAR].forEach(function (dx) {
      var x = CX + dx, y = yAt(x, bend);
      g.appendChild(svg('rect', { x: x - 4, y: y - 11, width: 8, height: 22, rx: 1, fill: '#4B565E' }));
    });

    // plates, lead first then by priority — the loading order the app uses
    var order = (state.lead ? [state.lead] : []).concat(
      state.secondaries.slice().sort(function (a, b) { return b.priority - a.priority; }));

    order.forEach(function (s, i) {
      var contrib = (s === state.lead) ? s.prompt + s.fewshot : s.compressed;
      var h = clamp(44 + contrib / 6, 44, 140);
      var w = (s === state.lead) ? 16 : 13;

      [-1, 1].forEach(function (side) {
        var x = CX + side * (PLATE_0 + i * PLATE_GAP);
        var y = yAt(x, bend);
        var rot = Math.atan(slopeAt(x, bend)) * 180 / Math.PI;
        var r = svg('rect', {
          x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 3,
          fill: s.price ? '#F0C21B' : 'none',
          stroke: s === state.lead ? '#E9EBE4' : (s.price ? '#A8870E' : '#4B565E'),
          'stroke-width': s === state.lead ? 1.6 : 1,
          transform: 'rotate(' + rot.toFixed(2) + ' ' + x + ' ' + y + ')'
        });
        g.appendChild(r);
      });
    });

    if (state.verdict === 'blocked') {
      var t = svg('text', {
        x: CX, y: 34, 'text-anchor': 'middle', fill: '#E8734A',
        'font-family': 'Martian Mono, monospace', 'font-size': 13, 'letter-spacing': 4
      });
      t.textContent = 'OVER CAPACITY';
      g.appendChild(t);
    }
  }

  /* -- Rendering: the lead-voice control ------------------------------------- */

  function renderLead(state) {
    var eligible = state.skills.filter(function (s) { return s.role === 'primary_eligible'; });
    var hadFocus = doc.activeElement && doc.activeElement.id === 'leadSel';
    els.lead.innerHTML = '';

    if (!state.skills.length) {
      els.lead.textContent = 'Nothing loaded — the base agent speaks for itself.';
      return;
    }
    if (!eligible.length) {
      els.lead.innerHTML = 'No loaded skill may lead — the <b>base agent</b> keeps the voice.';
      return;
    }

    var label = doc.createElement('span');
    label.textContent = 'Lead voice ';
    var sel = doc.createElement('select');
    sel.id = 'leadSel';
    sel.setAttribute('aria-label', 'Which skill owns the agent’s voice');
    eligible.forEach(function (s) {
      var o = doc.createElement('option');
      o.value = s.id; o.textContent = s.name;
      if (s === state.lead) o.selected = true;
      sel.appendChild(o);
    });

    sel.addEventListener('change', function () {
      var prev = leadOverride;
      var wanted = sel.value;
      leadOverride = wanted;
      var next = compute(selected);
      if (next.verdict === 'blocked') {
        leadOverride = prev;
        var over = next.tokens - next.budget;
        sticky = true;
        say('Refused — leading with ' + byId[wanted].name + ' costs its full instructions and ' +
            'worked examples: ' + over + ' tokens more than this bench has. Drop a plate first.', 'error');
        render();
        track('lead_refused', { skill: wanted, tier: tier });
        return;
      }
      clearAlert();
      render();
      track('lead_changed', { skill: wanted });
    });

    els.lead.appendChild(label);
    els.lead.appendChild(sel);
    if (hadFocus) sel.focus();
  }

  /* -- Rendering: readouts, wires, panels, prompt, basket -------------------- */

  var VERDICT_TEXT = { ready: 'Ready', sluggish: 'Sluggish', blocked: 'Over capacity' };

  function renderWires(state) {
    var slots = {};
    state.skills.forEach(function (s) {
      s.writes.forEach(function (slot) { (slots[slot] = slots[slot] || { w: [], r: [] }).w.push(s); });
      s.reads.forEach(function (slot) { (slots[slot] = slots[slot] || { w: [], r: [] }).r.push(s); });
    });

    var live = Object.keys(slots).filter(function (k) { return slots[k].w.length && slots[k].r.length; });
    els.wires.hidden = !live.length;
    els.wiresList.innerHTML = '';

    live.forEach(function (slot) {
      var li = doc.createElement('li');
      li.innerHTML = '<b>' + esc(slot) + '</b>' +
        '<span>' + esc(slots[slot].w.map(function (s) { return s.name; }).join(', ')) + ' writes</span>' +
        '<span class="arrow">→</span>' +
        '<span>' + esc(slots[slot].r.map(function (s) { return s.name; }).join(', ')) + ' reads</span>';
      els.wiresList.appendChild(li);
    });
  }

  function renderPanels(state) {
    els.panelWrap.hidden = !state.panels.length;
    els.panelList.innerHTML = '';
    state.panels.forEach(function (p) {
      var li = doc.createElement('li');
      li.textContent = p;
      els.panelList.appendChild(li);
    });
    els.dupeNote.textContent = state.dupes
      ? '· ' + state.dupes + ' duplicate' + (state.dupes > 1 ? 's' : '') + ' merged'
      : '';
  }

  function renderAssembled(state) {
    if (!state.skills.length) {
      els.assembled.textContent = 'Load a plate to see it assemble.';
      return;
    }
    var out = '<span class="dim">[base preamble — safety, formatting, refusal rules]</span>\n\n';
    out += state.lead
      ? '<b>' + esc(state.lead.persona) + '</b>\n'
      : '<b>[base agent persona — helpful, general-purpose]</b>\n';

    if (state.secondaries.length) {
      out += '\n<span class="key">You also have these specialties:</span>\n';
      state.secondaries.slice().sort(function (a, b) { return b.priority - a.priority; })
        .forEach(function (s) { out += '  · ' + esc(s.snippet) + '\n'; });
    }
    out += '\n<span class="dim">[tool contract] ' + esc(state.tools.join(', ') || 'none') + '</span>';
    els.assembled.innerHTML = out;
  }

  function renderBasket(state) {
    var paid = state.skills.filter(function (s) { return s.price > 0; });
    var n = paid.length;
    var price = priceFor(n), listPrice = n * 5, saving = listPrice - price;

    els.basketPrice.innerHTML = saving > 0
      ? '<s>$' + listPrice + '</s>$' + price
      : '$' + price;

    els.buyBtn.disabled = n === 0;
    els.buyBtn.textContent = n === 0
      ? 'Nothing selected'
      : 'Unlock ' + n + ' skill' + (n > 1 ? 's' : '') + ' — $' + price;

    if (n === 0) {
      els.basketNote.textContent = 'Both free plates are already in the app. Add a paid one and the price appears here.';
    } else if (saving > 0) {
      els.basketNote.textContent = 'Bundled automatically — $' + saving + ' less than buying them one at a time.';
    } else if (n === 1) {
      els.basketNote.textContent = 'One payment. Yours forever, on up to five of your machines. Add two more and the bundle price kicks in.';
    } else {
      els.basketNote.textContent = 'One more plate and this becomes a $12 three-pack.';
    }
  }

  function render() {
    var state = compute(selected);

    SKILLS.forEach(function (s) {
      var on = selected.indexOf(s.id) !== -1;
      s.el.setAttribute('aria-pressed', String(on));
      s.el.classList.toggle('is-lead', s === state.lead);
    });

    els.bench.setAttribute('data-verdict', state.verdict);
    els.tokUsed.textContent = state.tokens;
    els.tokBudget.textContent = state.budget;
    els.tokFill.style.width = clamp(state.load, 0, 1) * 100 + '%';
    els.verdict.textContent = VERDICT_TEXT[state.verdict];
    els.verdict.className = 'v-' + state.verdict;
    els.tokps.textContent = state.tokps.toFixed(1);
    els.nSkills.textContent = state.skills.length;
    els.nTools.textContent = state.tools.length;
    els.nPanels.textContent = state.panels.length;

    // A tier change can leave an already-loaded rack over capacity. The app never
    // silently disables a skill — it explains and leaves the user in charge (§8.3.5).
    if (!sticky) {
      var drop = heaviestSecondary(state);
      if (state.verdict === 'blocked') {
        say('This rack is ' + (state.tokens - state.budget) + ' tokens over what a ' +
            TIERS[tier].label + ' can hold. Nothing was disabled for you' +
            (drop ? ' — drop ' + drop.name + ' when you are ready.' : '.'), 'error');
      } else if (state.verdict === 'sluggish') {
        say('Sluggish, not blocked: about ' + state.tokps.toFixed(1) +
            ' tokens a second on this bench. Usable. Slower than you would like.', 'warn');
      } else {
        say('');
      }
    }

    renderBar(state);
    renderLead(state);
    renderWires(state);
    renderPanels(state);
    renderAssembled(state);
    renderBasket(state);
  }

  /* -- Wiring ---------------------------------------------------------------- */

  SKILLS.forEach(function (s) {
    s.el.addEventListener('click', function () { toggle(s.id); });
  });

  $$('.bench__opt').forEach(function (opt, i, all) {
    opt.addEventListener('click', function () {
      tier = opt.getAttribute('data-tier');
      all.forEach(function (o) {
        var on = o === opt;
        o.classList.toggle('is-on', on);
        o.setAttribute('aria-checked', String(on));
      });
      clearAlert();
      render();
      track('bench_changed', { tier: tier });
    });
    opt.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      next.focus(); next.click();
    });
  });

  $$('.preset').forEach(function (btn) {
    btn.addEventListener('click', function () {
      selected = [];
      leadOverride = null;
      clearAlert();
      btn.getAttribute('data-preset').split(',').forEach(function (id) {
        if (byId[id] && !conflictWith(id, selected)) {
          var next = compute(selected.concat([id]));
          if (next.verdict !== 'blocked') selected.push(id);
        }
      });
      render();
      track('preset_loaded', { preset: btn.textContent.trim() });
    });
  });

  els.copyBtn.addEventListener('click', function () {
    var url = location.origin + location.pathname +
      '?load=' + selected.join(',') + '&tier=' + tier +
      (leadOverride ? '&lead=' + leadOverride : '');
    var done = function () {
      var was = els.copyBtn.textContent;
      els.copyBtn.textContent = 'Copied';
      setTimeout(function () { els.copyBtn.textContent = was; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this loadout:', url); });
    } else {
      window.prompt('Copy this loadout:', url);
    }
    track('loadout_copied', { skills: selected.join(','), tier: tier });
  });

  els.buyBtn.addEventListener('click', function () {
    var paid = selected.filter(function (id) { return byId[id].price > 0; });
    track('checkout_click', { skills: paid.join(','), count: paid.length, price: priceFor(paid.length) });
    if (CHECKOUT_URL.indexOf('REPLACE_ME') !== -1) {
      console.warn('[hydropark] CHECKOUT_URL is still a placeholder — set it in app.js.');
      return;
    }
    location.href = CHECKOUT_URL + '?skills=' + encodeURIComponent(paid.join(','));
  });

  $$('[data-track="download"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      track('download_click', { location: btn.getAttribute('data-loc') || 'unknown' });
      if (DOWNLOAD_URL.indexOf('REPLACE_ME') !== -1) {
        console.warn('[hydropark] DOWNLOAD_URL is still a placeholder — set it in app.js.');
        return;
      }
      location.href = DOWNLOAD_URL;
    });
  });

  /* -- Shareable loadouts ----------------------------------------------------- */

  (function initFromUrl() {
    var q = new URLSearchParams(location.search);

    var t = q.get('tier');
    if (t && TIERS[t]) {
      tier = t;
      $$('.bench__opt').forEach(function (o) {
        var on = o.getAttribute('data-tier') === t;
        o.classList.toggle('is-on', on);
        o.setAttribute('aria-checked', String(on));
      });
    }

    var load = q.get('load');
    if (load) {
      load.split(',').forEach(function (id) {
        if (!byId[id] || selected.indexOf(id) !== -1) return;
        if (conflictWith(id, selected)) return;
        if (compute(selected.concat([id])).verdict === 'blocked') return;
        selected.push(id);
      });
    } else {
      selected = ['cooking-assistant', 'nutrition-coach'];   // a rack worth looking at
    }

    var lead = q.get('lead');
    if (lead && byId[lead] && selected.indexOf(lead) !== -1) leadOverride = lead;
  })();

  render();
  track('lp_view', { page: 'gym' });

  /* -- Reveal on scroll -------------------------------------------------------- */

  if ('IntersectionObserver' in window && !reduced) {
    var targets = $$('.correction__in > div, .routine-cards li, .rules__list li, .floor__cols p, .tier, .faq details');
    targets.forEach(function (el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    targets.forEach(function (el) { io.observe(el); });
  }
})();
