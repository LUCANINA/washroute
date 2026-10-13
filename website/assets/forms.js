// Contact + commercial quote forms → Supabase edge function `website-contact`.
// Works without JS too (plain form post → /thankyou); this just keeps people on the page.
(function () {
  document.querySelectorAll('form[data-contact]').forEach(function (form) {
    var t = form.querySelector('input[name=t]'); if (t) t.value = String(Date.now());
    var msg = form.querySelector('.form-msg'), btn = form.querySelector('button[type=submit]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {}; new FormData(form).forEach(function (v, k) { data[k] = v; });
      btn.disabled = true; btn.textContent = 'Sending…'; msg.className = 'form-msg'; msg.textContent = '';
      fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (r) {
          if (r.ok) { form.innerHTML = '<p class="lead">Thanks! We got your message and will reply within one business day.</p>'; return; }
          throw new Error(r.error || 'Sorry, that did not go through. Please call or text us.');
        })
        .catch(function (err) {
          btn.disabled = false; btn.textContent = 'Send';
          msg.className = 'form-msg err'; msg.textContent = err.message || 'Sorry, that did not go through. Please call or text us.';
        });
    });
  });
})();

// "Our story" photo carousel: arrows + dots on top of a native swipeable scroll-snap strip.
(function () {
  document.querySelectorAll('[data-carousel]').forEach(function (root) {
    var track = root.querySelector('.h-car-track'), slides = track.children, n = slides.length;
    var prev = root.querySelector('.prev'), next = root.querySelector('.next'), dots = root.querySelector('.h-car-dots');
    if (n < 2) return;
    root.classList.add('js');
    for (var i = 0; i < n; i++) {
      var d = document.createElement('button'); d.type = 'button'; d.tabIndex = -1;
      d.addEventListener('click', go.bind(null, i)); dots.appendChild(d);
    }
    function cur() { return Math.round(track.scrollLeft / track.clientWidth); }
    function go(i) { track.scrollTo({ left: Math.max(0, Math.min(n - 1, i)) * track.clientWidth }); }
    function sync() {
      var c = cur();
      [].forEach.call(dots.children, function (d, i) { d.setAttribute('aria-current', i === c ? 'true' : 'false'); });
      prev.disabled = c === 0; next.disabled = c === n - 1;
    }
    prev.addEventListener('click', function () { go(cur() - 1); });
    next.addEventListener('click', function () { go(cur() + 1); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(cur() + 1); }
    });
    track.addEventListener('scroll', function () { clearTimeout(track._t); track._t = setTimeout(sync, 60); }, { passive: true });
    window.addEventListener('resize', sync);
    sync();
  });
})();

// "Do we serve your area?" ZIP check on the homepage. Data (ZIPs, live pickup windows) is printed into the page
// as #zc-data by pages.js, so the check is instant and needs no network call.
(function () {
  var dataEl = document.getElementById('zc-data');
  if (!dataEl) return;
  var D; try { D = JSON.parse(dataEl.textContent); } catch (e) { return; }
  function h(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  document.querySelectorAll('form[data-zipcheck]').forEach(function (form) {
    var input = form.querySelector('.zc-input'), out = form.querySelector('.zc-out');
    input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, '').slice(0, 5); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var zip = input.value.trim();
      if (!/^\d{5}$/.test(zip)) { out.className = 'zc-out zc-err'; out.innerHTML = 'Enter a 5-digit ZIP code.'; input.focus(); return; }
      var z = D.zips[zip];
      if (z && !z.x) {
        out.className = 'zc-out zc-yes';
        out.innerHTML = '<p class="zc-head"><span class="zc-icon" aria-hidden="true">✓</span> Yes, we pick up in ' + h(zip) + (z.n ? ' (' + h(z.n) + ')' : '') + '.</p>' +
          (z.w ? '<p class="zc-sub">' + h(z.w) + ', ' + h(D.days) + '.</p>' : '<p class="zc-sub">' + h(D.days) + '. Pickup times depend on your street; you\'ll see yours when you book.</p>') +
          '<p class="zc-actions"><a class="btn" href="' + h(D.app) + '">Schedule a pickup</a>' + (z.p ? ' <a class="zc-link" href="' + h(z.p) + '">About ' + h(z.n) + '</a>' : '') + '</p>';
      } else if (z && z.x) {
        out.className = 'zc-out zc-part';
        out.innerHTML = '<p class="zc-head">We serve parts of ' + h(zip) + (z.n ? ' (' + h(z.n) + ')' : '') + '.</p>' +
          '<p class="zc-sub">Enter your street address in the app and we\'ll tell you right away.</p>' +
          '<p class="zc-actions"><a class="btn" href="' + h(D.app) + '">Check my address</a></p>';
      } else {
        out.className = 'zc-out zc-no';
        out.innerHTML = '<p class="zc-head">We\'re not in ' + h(zip) + ' yet.</p>' +
          '<p class="zc-sub">Leave your email and we\'ll tell you when we start picking up there.</p>' +
          '<div class="zc-row zc-wait"><input class="zc-input zc-email" type="email" autocomplete="email" placeholder="you@email.com" aria-label="Your email">' +
          '<button class="h-btn zc-btn" type="button">Notify me</button></div>' +
          '<p class="zc-wait-msg" aria-live="polite"></p>';
        var em = out.querySelector('.zc-email'), nb = out.querySelector('.zc-wait .zc-btn'), wm = out.querySelector('.zc-wait-msg');
        function join() {
          var email = em.value.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { wm.className = 'zc-wait-msg zc-err'; wm.textContent = 'Enter a valid email address.'; em.focus(); return; }
          nb.disabled = true; nb.textContent = 'Saving…'; wm.className = 'zc-wait-msg'; wm.textContent = '';
          fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zip: zip, email: email }) })
            .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
            .then(function (r) {
              if (!r.ok) throw new Error(r.error || 'Sorry, that did not go through. Please try again in a minute.');
              out.className = 'zc-out zc-yes';
              out.innerHTML = '<p class="zc-head"><span class="zc-icon" aria-hidden="true">✓</span> Thanks! We\'ll email ' + h(email) + ' when we start picking up in ' + h(zip) + '.</p>';
            })
            .catch(function (err) {
              nb.disabled = false; nb.textContent = 'Notify me';
              wm.className = 'zc-wait-msg zc-err'; wm.textContent = err.message || 'Sorry, that did not go through. Please try again in a minute.';
            });
        }
        nb.addEventListener('click', join);
        em.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); join(); } });
        em.focus();
      }
    });
  });
})();
