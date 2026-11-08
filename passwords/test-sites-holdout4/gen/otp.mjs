// Second-factor code pages.
import { doc, fxLive, step, x } from './kit.mjs';

const digits = (n, sel) => Array.from({ length: n }, (_, i) => x(sel(i + 1), 'otp-digit'));

export default [
  {
    id: 'h4-otp-01',
    category: 'otp',
    description: 'Cloud console two-factor page: one box with one-time-code autocomplete for an authenticator app, a trust-this-browser tick and a recovery-code link.',
    steps: [step('otp', [x('#totp', 'otp')])],
    html: doc({
      title: 'Two-factor authentication – Ironbark Cloud',
      css: `
body{margin:0;font:14px "Atkinson Hyperlegible",sans-serif;background:#f4f4f4}
.c{width:380px;margin:90px auto;background:#fff;padding:28px;border-top:4px solid #8d4b1f}
#totp{width:100%;box-sizing:border-box;padding:12px;font-size:20px;letter-spacing:4px;border:1px solid #999}
button{margin-top:14px;width:100%;padding:10px;background:#8d4b1f;color:#fff;border:0}`,
      body: `
<div class="c">
  <h1 style="font-size:20px">Two-factor authentication</h1>
  <p>Open your authenticator app and enter the 6-digit code for <b>Ironbark Cloud</b>.</p>
  <form action="#" onsubmit="return false">
    <label for="totp">Authentication code</label>
    <input id="totp" name="code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="123456">
    <p><label><input type="checkbox" name="trust"> Trust this browser for 30 days</label></p>
    <button type="submit">Verify</button>
  </form>
  <p><a href="#">Use a recovery code instead</a></p>
</div>`,
      js: fxLive({ otp: '#totp' }),
    }),
  },

  {
    id: 'h4-otp-02',
    category: 'otp',
    description: 'Game account verification with six one-character boxes, aria-labels per digit, auto-advance and paste spreading.',
    steps: [step('otp', digits(6, (i) => `.code-inputs input:nth-child(${i})`))],
    html: doc({
      title: 'Verify it\'s you – Tallyho Games',
      css: `
body{margin:0;font:15px "Rubik",sans-serif;background:#1b1036;color:#fff}
.c{width:420px;margin:100px auto;text-align:center}
.code-inputs{display:flex;gap:10px;justify-content:center;margin:24px 0}
.code-inputs input{width:46px;height:56px;text-align:center;font-size:24px;border-radius:8px;border:2px solid #6d4bd8;background:#2a1a52;color:#fff}`,
      body: `
<div class="c">
  <h1>Check your email</h1>
  <p>Enter the 6-digit code we sent to r•••@mail.example</p>
  <form action="#" onsubmit="return false">
    <div class="code-inputs" role="group" aria-label="Verification code">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 1 of 6">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 2 of 6">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 3 of 6">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 4 of 6">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 5 of 6">
      <input type="text" inputmode="numeric" maxlength="1" aria-label="Digit 6 of 6">
    </div>
    <button type="submit">Verify</button>
  </form>
</div>`,
      js: `
var boxes = Array.prototype.slice.call(document.querySelectorAll('.code-inputs input'));
boxes.forEach(function (b, i) {
  b.addEventListener('input', function () {
    if (b.value.length > 1) b.value = b.value.slice(-1);
    if (b.value && boxes[i + 1]) boxes[i + 1].focus();
  });
  b.addEventListener('keydown', function (e) { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); });
  b.addEventListener('paste', function (e) {
    var t = (e.clipboardData.getData('text') || '').replace(/[^0-9]/g, '');
    if (!t) return;
    e.preventDefault();
    for (var k = 0; k < boxes.length; k++) boxes[k].value = t.charAt(k) || '';
  });
});
window.__fixture = { state: function () { return { otp: boxes.map(function (b) { return b.value; }).join('') }; } };`,
    }),
  },

  {
    id: 'h4-otp-03',
    category: 'otp',
    description: 'Spanish mobile carrier SMS check: "Código de verificación" box with a numeric keyboard and a resend countdown.',
    steps: [step('otp', [x('input[name="sms_code"]', 'otp')])],
    html: doc({
      title: 'Verificación – Ceibo Móvil',
      lang: 'es',
      css: `
body{margin:0;font:15px Arial,sans-serif;background:#fff3e0}
.c{width:380px;margin:80px auto;background:#fff;border-radius:10px;padding:26px}
input[name=sms_code]{width:100%;box-sizing:border-box;padding:12px;font-size:22px;letter-spacing:6px;text-align:center;border:1px solid #ffb74d}
button{width:100%;margin-top:14px;padding:11px;background:#ef6c00;color:#fff;border:0;border-radius:6px}`,
      body: `
<div class="c">
  <h1 style="font-size:20px">Introduce el código</h1>
  <p>Te hemos enviado un SMS con un código de 6 cifras al número terminado en 47.</p>
  <form action="#" onsubmit="return false">
    <label for="sms">Código de verificación</label>
    <input id="sms" name="sms_code" type="text" inputmode="numeric" maxlength="6">
    <button type="submit">Confirmar</button>
  </form>
  <p id="reenviar">Reenviar código en <span id="t">0:30</span></p>
</div>`,
      js: `
var left = 30;
var timer = setInterval(function () {
  left--;
  document.getElementById('t').textContent = '0:' + (left < 10 ? '0' : '') + left;
  if (left <= 0) { clearInterval(timer); document.getElementById('reenviar').innerHTML = '<a href="#">Reenviar código</a>'; }
}, 1000);
${fxLive({ otp: 'input[name="sms_code"]' })}`,
    }),
  },

  {
    id: 'h4-otp-04',
    category: 'otp',
    description: 'Document app new-device check: an alphanumeric "XXXX-XXXX" code emailed to the user, one text box with no autocomplete hint.',
    steps: [step('otp', [x('#email-code', 'otp')])],
    html: doc({
      title: 'Confirm it\'s you – Stillwater Docs',
      css: `
body{margin:0;font:15px "Lora",serif;background:#f0f4f8}
.c{width:400px;margin:90px auto;background:#fff;padding:28px;border-radius:6px}
#email-code{width:100%;box-sizing:border-box;padding:11px;font:20px monospace;text-transform:uppercase;border:1px solid #8ca0b3}
button{margin-top:14px;padding:10px 20px;background:#2c4a6b;color:#fff;border:0}`,
      body: `
<div class="c">
  <h1 style="font-size:21px">New sign-in from Firefish on Linux</h1>
  <p>We emailed a confirmation code to s•••••@post.example. It looks like <code>AB12-CD34</code>.</p>
  <form action="#" onsubmit="return false">
    <label for="email-code">Confirmation code</label>
    <input id="email-code" name="device_verification_code" type="text" maxlength="9" autocapitalize="characters" spellcheck="false">
    <button type="submit">Confirm</button>
  </form>
  <p><a href="#">Didn't get it? Send a new code</a></p>
</div>`,
      js: fxLive({ otp: '#email-code' }),
    }),
  },

  {
    id: 'h4-otp-05',
    category: 'otp',
    description: 'Ride-hailing phone check: four telephone-keyboard boxes for an SMS code, no labels beyond the heading.',
    steps: [step('otp', digits(4, (i) => `#pin-${i}`))],
    html: doc({
      title: 'Quokka Rides',
      css: `
body{margin:0;font:16px "Montserrat",sans-serif;background:#fff}
.c{width:340px;margin:110px auto;text-align:center}
.pins{display:flex;gap:14px;justify-content:center;margin:26px 0}
.pins input{width:52px;height:60px;border:0;border-bottom:3px solid #222;font-size:28px;text-align:center}`,
      body: `
<div class="c">
  <h1 style="font-size:22px">Enter the 4-digit code sent to +61 4•• ••• 018</h1>
  <div class="pins">
    <input id="pin-1" type="tel" maxlength="1">
    <input id="pin-2" type="tel" maxlength="1">
    <input id="pin-3" type="tel" maxlength="1">
    <input id="pin-4" type="tel" maxlength="1">
  </div>
  <button type="button">Next</button>
  <p><a href="#">I haven't received a code</a></p>
</div>`,
      js: `
var pins = [1, 2, 3, 4].map(function (n) { return document.getElementById('pin-' + n); });
pins.forEach(function (p, i) { p.addEventListener('input', function () { if (p.value && pins[i + 1]) pins[i + 1].focus(); }); });
window.__fixture = { state: function () { return { otp: pins.map(function (p) { return p.value; }).join('') }; } };`,
    }),
  },
];
