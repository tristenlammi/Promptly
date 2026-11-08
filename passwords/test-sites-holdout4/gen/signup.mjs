// Sign-up pages.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-signup-01',
    category: 'signup',
    description: 'Recipe site registration: email, password and confirm password with a terms tick; a newsletter box sits in the footer.',
    steps: [step('signup', [x('#reg-email', 'username'), x('#reg-pass', 'new-password'), x('#reg-pass2', 'confirm-password')], ['#footer-news'])],
    html: doc({
      title: 'Create your account – Marigold Recipes',
      css: `
body{margin:0;font:15px Georgia,serif;background:#fffaf0;color:#3b2f1e}
main{width:420px;margin:50px auto;background:#fff;border:1px solid #f1d9a8;padding:28px}
.r{margin-bottom:14px}.r label{display:block;font-size:14px}
.r input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #d9b77a}
.cta{background:#e09f3e;border:0;padding:10px 20px;color:#fff}
footer{background:#3b2f1e;color:#f1d9a8;padding:24px;text-align:center}`,
      body: `
<main>
  <h1>Join Marigold</h1>
  <p>Save recipes, build shopping lists and share your own dishes.</p>
  <form action="#" method="post" onsubmit="return false">
    <div class="r"><label for="reg-email">Email</label><input id="reg-email" name="user[email]" type="email" autocomplete="email"></div>
    <div class="r"><label for="reg-pass">Password</label><input id="reg-pass" name="user[password]" type="password" autocomplete="new-password"></div>
    <div class="r"><label for="reg-pass2">Confirm password</label><input id="reg-pass2" name="user[password_confirmation]" type="password" autocomplete="new-password"></div>
    <label><input type="checkbox" name="user[terms]"> I agree to the Terms and Privacy Policy</label>
    <p><button class="cta" type="submit">Create account</button></p>
  </form>
  <p>Already a member? <a href="#">Log in</a></p>
</main>
<footer>
  <form action="#" onsubmit="return false"><label for="footer-news">Weekly recipes in your inbox</label> <input id="footer-news" type="email" name="news_email" placeholder="you@example.com"> <button>Subscribe</button></form>
</footer>`,
      js: fxLive({ username: '#reg-email', 'new-password': '#reg-pass', 'confirm-password': '#reg-pass2' }),
    }),
  },

  {
    id: 'h4-signup-02',
    category: 'signup',
    description: 'Community sign-up with a public username, a separate email and a single new password with a live rules checklist and show toggle.',
    steps: [step('signup', [x('#su-username', 'username'), x('#su-email', 'email'), x('#su-password', 'new-password')])],
    html: doc({
      title: 'Join Pixelgrove',
      css: `
body{margin:0;font:14px "Inter",sans-serif;background:#0f172a;color:#e2e8f0}
.card{width:400px;margin:60px auto;background:#1e293b;border-radius:12px;padding:28px}
.f{margin-bottom:14px}.f label{display:block;margin-bottom:5px;font-size:13px;color:#94a3b8}
.f input{width:100%;box-sizing:border-box;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#fff}
.pw{position:relative}.pw button{position:absolute;right:6px;top:6px;background:none;border:0;color:#38bdf8}
ul.rules{list-style:none;padding:0;font-size:12px;color:#94a3b8}ul.rules li.ok{color:#4ade80}
.go{width:100%;padding:11px;background:#38bdf8;border:0;border-radius:8px;font-weight:600}`,
      body: `
<div class="card">
  <h1 style="font-size:22px">Create your Pixelgrove account</h1>
  <form action="#" onsubmit="return false">
    <div class="f"><label for="su-username">Username</label><input id="su-username" name="username" type="text" autocomplete="username" maxlength="20"><small>This is your public name. Letters, numbers and underscores.</small></div>
    <div class="f"><label for="su-email">Email address</label><input id="su-email" name="email" type="email" autocomplete="email"></div>
    <div class="f"><label for="su-password">Password</label><div class="pw"><input id="su-password" name="password" type="password" autocomplete="new-password" aria-describedby="rules"><button type="button" id="toggle">Show</button></div>
      <ul class="rules" id="rules"><li data-r="len">At least 10 characters</li><li data-r="num">One number</li><li data-r="case">Upper and lower case</li></ul></div>
    <button class="go" type="submit">Create account</button>
  </form>
</div>`,
      js: `
var pw = document.getElementById('su-password');
pw.addEventListener('input', function () {
  var v = pw.value;
  var checks = { len: v.length >= 10, num: /[0-9]/.test(v), case: /[a-z]/.test(v) && /[A-Z]/.test(v) };
  document.querySelectorAll('#rules li').forEach(function (li) { li.classList.toggle('ok', checks[li.getAttribute('data-r')]); });
});
document.getElementById('toggle').addEventListener('click', function () { pw.type = pw.type === 'password' ? 'text' : 'password'; });
${fxLive({ username: '#su-username', email: '#su-email', 'new-password': '#su-password' })}`,
    }),
  },

  {
    id: 'h4-signup-03',
    category: 'signup',
    description: 'German bike shop registration: Vorname, Nachname, E-Mail-Adresse, Passwort and "Passwort wiederholen", without autocomplete hints.',
    steps: [step('signup', [x('#vorname', 'first-name'), x('#nachname', 'last-name'), x('#email', 'username'), x('#passwort', 'new-password'), x('#passwort2', 'confirm-password')])],
    html: doc({
      title: 'Konto erstellen – Radhaus Brenner',
      lang: 'de',
      css: `
body{margin:0;font:15px Arial,sans-serif;background:#f5f5f5}
.box{width:520px;margin:40px auto;background:#fff;padding:26px;border:1px solid #ddd}
.zeile{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.feld{margin-bottom:12px}.feld label{display:block;font-size:13px;margin-bottom:3px}
.feld input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #aaa}
button{background:#d32f2f;color:#fff;border:0;padding:10px 22px}`,
      body: `
<div class="box">
  <h1 style="font-size:22px">Neues Kundenkonto</h1>
  <form action="#" onsubmit="return false">
    <div class="zeile">
      <div class="feld"><label for="vorname">Vorname*</label><input id="vorname" name="vorname" type="text"></div>
      <div class="feld"><label for="nachname">Nachname*</label><input id="nachname" name="nachname" type="text"></div>
    </div>
    <div class="feld"><label for="email">E-Mail-Adresse*</label><input id="email" name="email" type="email"></div>
    <div class="feld"><label for="passwort">Passwort*</label><input id="passwort" name="passwort" type="password"><small>Mindestens 8 Zeichen</small></div>
    <div class="feld"><label for="passwort2">Passwort wiederholen*</label><input id="passwort2" name="passwort_wdh" type="password"></div>
    <label><input type="checkbox" name="agb"> Ich habe die AGB und die Datenschutzerklärung gelesen.</label>
    <p><button type="submit">Registrieren</button></p>
  </form>
</div>`,
      js: fxLive({ 'first-name': '#vorname', 'last-name': '#nachname', username: '#email', 'new-password': '#passwort', 'confirm-password': '#passwort2' }),
    }),
  },

  {
    id: 'h4-signup-04',
    category: 'signup',
    description: 'Craft marketplace sign-up with one password, a display:none bot trap, an optional referral code box and a "how did you hear" select.',
    steps: [step('signup', [x('#signup_email', 'username'), x('#signup_password', 'new-password')], ['input[name="hp_company"]', '#referral', '#heard'])],
    html: doc({
      title: 'Sign up – Pebblework',
      css: `
body{margin:0;font:15px "Work Sans",sans-serif;background:#f4f1ec}
.panel{width:400px;margin:60px auto;background:#fff;border-radius:10px;padding:28px}
.f{margin-bottom:14px}.f label{display:block;font-size:13px;color:#555}
.f input,.f select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccc;border-radius:6px}
.trap{display:none}
.btn{width:100%;padding:11px;background:#264653;color:#fff;border:0;border-radius:6px}`,
      body: `
<div class="panel">
  <h1 style="font-size:22px">Start selling on Pebblework</h1>
  <form action="#" onsubmit="return false">
    <div class="f"><label for="signup_email">Email</label><input id="signup_email" name="email" type="email" autocomplete="email"></div>
    <div class="f"><label for="signup_password">Create a password</label><input id="signup_password" name="password" type="password" autocomplete="new-password"></div>
    <div class="trap" aria-hidden="true"><label>Company <input name="hp_company" type="text" tabindex="-1" autocomplete="off"></label></div>
    <div class="f"><label for="referral">Referral code (optional)</label><input id="referral" name="referral" type="text"></div>
    <div class="f"><label for="heard">How did you hear about us?</label><select id="heard" name="heard"><option value="">Choose…</option><option>A friend</option><option>A craft fair</option><option>Search</option></select></div>
    <button class="btn" type="submit">Create shop account</button>
  </form>
</div>`,
      js: fxLive({ username: '#signup_email', 'new-password': '#signup_password' }),
    }),
  },

  {
    id: 'h4-signup-05',
    category: 'signup',
    description: 'Travel site "Join" button opens a slide-in panel asking for full name, email and a password with a strength bar.',
    steps: [
      step('none', [], [], { advance: { click: '#join-btn' } }),
      step('signup', [x('#j-name', 'full-name'), x('#j-email', 'username'), x('#j-pass', 'new-password')], [], { wait: '#join-panel[data-settled]' }),
    ],
    html: doc({
      title: 'Fernway Travel',
      css: `
body{margin:0;font:15px "Poppins",sans-serif;background:#e0f2f1;overflow-x:hidden}
header{display:flex;justify-content:space-between;padding:14px 30px;background:#00695c;color:#fff}
header button{background:#ffb300;border:0;padding:8px 16px;border-radius:20px}
.hero{padding:80px 40px;font-size:30px;color:#004d40}
#join-panel{position:fixed;top:0;right:0;width:380px;height:100%;background:#fff;box-shadow:-4px 0 18px rgba(0,0,0,.2);padding:28px;box-sizing:border-box;transform:translateX(100%);transition:transform .3s}
#join-panel.open{transform:none}
#join-panel label{display:block;margin:12px 0 4px;font-size:13px}
#join-panel input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #80cbc4;border-radius:6px}
.meter{height:5px;background:#eee;margin-top:6px}.meter div{height:100%;width:0;background:#00897b;transition:width .2s}`,
      body: `
<header><b>Fernway</b><button id="join-btn" type="button">Join free</button></header>
<div class="hero">Trips planned by people who have been there.</div>
<aside id="join-panel" aria-hidden="true" hidden>
  <h2>Create your Fernway account</h2>
  <form action="#" onsubmit="return false">
    <label for="j-name">Full name</label><input id="j-name" name="name" type="text" autocomplete="name">
    <label for="j-email">Email</label><input id="j-email" name="email" type="email" autocomplete="email">
    <label for="j-pass">Password</label><input id="j-pass" name="password" type="password" autocomplete="new-password">
    <div class="meter"><div id="bar"></div></div>
    <p><button type="submit">Join Fernway</button></p>
  </form>
</aside>`,
      js: `
document.getElementById('join-btn').addEventListener('click', function () {
  var p = document.getElementById('join-panel');
  p.hidden = false;
  p.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(function () { requestAnimationFrame(function () { p.classList.add('open'); }); });
  setTimeout(function () { p.setAttribute('data-settled', ''); }, 380);
});
document.getElementById('j-pass').addEventListener('input', function () {
  document.getElementById('bar').style.width = Math.min(100, this.value.length * 9) + '%';
});
${fxLive({ 'full-name': '#j-name', username: '#j-email', 'new-password': '#j-pass' })}`,
    }),
  },
];
