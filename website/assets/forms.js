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
