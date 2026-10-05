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
