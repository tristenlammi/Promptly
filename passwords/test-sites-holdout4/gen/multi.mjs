// Multi-step sign-in: the password (or a code) appears after a transition.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-multi-01',
    category: 'multi-step',
    description: 'Identifier first, then a progress bar and a fade to a "Welcome" step that shows the account as a text chip, keeps the identifier in a hidden input and asks for the password.',
    steps: [
      step('email-first', [x('#identifierId', 'username')], [], { advance: { click: '#identifierNext' } }),
      step('password-next', [x('#pw', 'password')], ['#hiddenIdentifier'], { wait: 'body[data-settled] #pw' }),
    ],
    html: doc({
      title: 'Sign in – Corvid Accounts',
      css: `
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f0f4f9;font:14px Roboto,Arial,sans-serif;color:#1f1f1f}
.card{position:relative;width:420px;background:#fff;border-radius:28px;padding:36px 40px;overflow:hidden}
.bar{position:absolute;top:0;left:0;height:4px;width:0;background:#0b57d0;transition:width .4s}
.bar.run{width:100%}
.logo{font-weight:700;font-size:20px;color:#0b57d0}
h1{font-size:30px;font-weight:400;margin:16px 0 8px}
.field{position:relative;margin:24px 0 8px}
.field input{width:100%;box-sizing:border-box;padding:16px 14px;border:1px solid #747775;border-radius:4px;font-size:16px}
.field .lbl{position:absolute;left:12px;top:-9px;background:#fff;padding:0 4px;font-size:12px;color:#444;pointer-events:none}
.actions{display:flex;justify-content:space-between;align-items:center;margin-top:36px}
.actions button{background:#0b57d0;color:#fff;border:0;border-radius:20px;padding:10px 24px;font-size:14px}
.chip{display:inline-flex;align-items:center;gap:8px;border:1px solid #c4c7c5;border-radius:16px;padding:4px 12px 4px 4px}
.avatar{width:20px;height:20px;border-radius:50%;background:#b3261e}
section{transition:opacity .2s}section.fade{opacity:0}
.err{color:#b3261e;font-size:12px;min-height:16px}`,
      body: `
<div class="card">
  <div class="bar" id="bar"></div>
  <div class="logo">Corvid</div>
  <section id="s-id">
    <h1>Sign in</h1>
    <p>Use your Corvid Account</p>
    <div class="field">
      <input type="email" id="identifierId" name="identifier" autocomplete="username" spellcheck="false" aria-label="Email or phone">
      <div class="lbl" aria-hidden="true">Email or phone</div>
    </div>
    <div class="err" id="id-err"></div>
    <a href="#">Forgot email?</a>
    <div class="actions"><a href="#">Create account</a><button id="identifierNext" type="button">Next</button></div>
  </section>
  <section id="s-pw" hidden class="fade">
    <h1>Welcome</h1>
    <div class="chip"><span class="avatar"></span><span id="chip-email"></span><span aria-hidden="true">▾</span></div>
    <form action="#" onsubmit="return false">
      <input type="email" name="identifier" id="hiddenIdentifier" autocomplete="username" hidden>
      <div class="field">
        <input type="password" name="Passwd" id="pw" autocomplete="current-password" aria-label="Enter your password">
        <div class="lbl" aria-hidden="true">Enter your password</div>
      </div>
      <label><input type="checkbox" id="show"> Show password</label>
      <div class="actions"><a href="#">Try another way</a><button id="passwordNext" type="button">Next</button></div>
    </form>
  </section>
</div>`,
      js: `
var model = { username: '' };
document.getElementById('identifierNext').addEventListener('click', function () {
  var v = document.getElementById('identifierId').value.trim();
  if (!v) { document.getElementById('id-err').textContent = 'Enter an email or phone number'; return; }
  model.username = v;
  document.getElementById('bar').classList.add('run');
  document.getElementById('s-id').classList.add('fade');
  setTimeout(function () {
    document.getElementById('s-id').hidden = true;
    document.getElementById('chip-email').textContent = v;
    document.getElementById('hiddenIdentifier').value = v;
    var pw = document.getElementById('s-pw');
    pw.hidden = false;
    requestAnimationFrame(function () { pw.classList.remove('fade'); });
    setTimeout(function () { document.body.setAttribute('data-settled', ''); document.getElementById('pw').focus(); }, 250);
  }, 450);
});
document.getElementById('show').addEventListener('change', function () { document.getElementById('pw').type = this.checked ? 'text' : 'password'; });
${fxLive({ username: 'js:model.username || document.getElementById("identifierId").value', password: '#pw' })}`,
    }),
  },

  {
    id: 'h4-multi-02',
    category: 'multi-step',
    description: 'Email step slides left and the password step slides in from the right with a back arrow showing the address; the email input is hidden once the slide ends.',
    steps: [
      step('email-first', [x('input[name="loginfmt"]', 'username')], [], { advance: { click: '#idSIButton9' } }),
      step('password-next', [x('input[name="passwd"]', 'password')], [], { wait: '.stage[data-settled="pw"]' }),
    ],
    html: doc({
      title: 'Sign in to your account – Lumen ID',
      css: `
body{margin:0;background:#e8eef3;font:15px "Segoe UI",sans-serif}
.box{width:440px;margin:90px auto;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.2);padding:44px;overflow:hidden}
.stage{position:relative;height:250px}
.pane{position:absolute;inset:0;transition:transform .3s ease-out}
.pane.off-right{transform:translateX(110%)}.pane.off-left{transform:translateX(-110%)}
.pane input{width:100%;border:0;border-bottom:1px solid #666;padding:6px 0;font-size:15px;outline:none}
.title{font-size:24px;font-weight:600;margin:10px 0 16px}
.back{background:none;border:0;padding:0;font-size:15px;cursor:pointer}
.btnrow{text-align:right;margin-top:30px}.btnrow input{background:#0067b8;color:#fff;border:0;padding:6px 30px;font-size:15px}`,
      body: `
<div class="box">
  <div style="font-weight:700;color:#0067b8">Lumen</div>
  <div class="stage" id="stage">
    <div class="pane" id="pane-email">
      <div class="title">Sign in</div>
      <input type="email" name="loginfmt" id="i0116" maxlength="113" placeholder="Email, phone, or Lumen ID" aria-label="Enter your email, phone, or Lumen ID" autocomplete="username">
      <p><a href="#">Can't access your account?</a></p>
      <div class="btnrow"><input type="submit" id="idSIButton9" value="Next"></div>
    </div>
    <div class="pane off-right" id="pane-pw" hidden>
      <button class="back" type="button" id="backBtn">← <span id="displayName"></span></button>
      <div class="title">Enter password</div>
      <input name="passwd" type="password" id="i0118" autocomplete="current-password" placeholder="Password" aria-label="Enter the password for your account">
      <p><a href="#">Forgot my password</a><br><a href="#">Sign in with a code instead</a></p>
      <div class="btnrow"><input type="submit" id="idSIButton10" value="Sign in"></div>
    </div>
  </div>
</div>`,
      js: `
var who = '';
document.getElementById('idSIButton9').addEventListener('click', function () {
  who = document.getElementById('i0116').value;
  document.getElementById('displayName').textContent = who;
  var pe = document.getElementById('pane-email'), pp = document.getElementById('pane-pw');
  pp.hidden = false;
  requestAnimationFrame(function () {
    pe.classList.add('off-left');
    pp.classList.remove('off-right');
  });
  setTimeout(function () {
    pe.hidden = true;
    document.getElementById('stage').setAttribute('data-settled', 'pw');
  }, 380);
});
${fxLive({ username: 'js:who || document.getElementById("i0116").value', password: 'input[name="passwd"]' })}`,
    }),
  },

  {
    id: 'h4-multi-03',
    category: 'multi-step',
    description: 'Hosting control panel: username first, then the password box expands below while the username stays editable, so step two is a full sign-in.',
    steps: [
      step('email-first', [x('#login-user', 'username')], [], { advance: { click: '#continue' } }),
      step('signin', [x('#login-user', 'username'), x('#login-pass', 'password')], [], { wait: '#pw-row.open' }),
    ],
    html: doc({
      title: 'Quarry Hosting – Client area',
      css: `
body{margin:0;font:14px Tahoma,sans-serif;background:#2d2f33;color:#ddd}
.panel{width:360px;margin:100px auto;background:#3a3d42;border-radius:6px;padding:26px}
label{display:block;margin:10px 0 4px;color:#aab}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px;background:#26282b;color:#eee;border:1px solid #555;border-radius:4px}
#pw-row{display:none}#pw-row.open{display:block;animation:drop .25s}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1}}
button{margin-top:16px;width:100%;padding:10px;background:#f2a541;border:0;border-radius:4px;font-weight:bold}`,
      body: `
<div class="panel">
  <h2 style="margin-top:0;color:#f2a541">Quarry Hosting</h2>
  <form id="f" action="#" onsubmit="return false">
    <label for="login-user">Username</label>
    <input type="text" id="login-user" name="user" autocomplete="username">
    <div id="pw-row">
      <label for="login-pass">Password</label>
      <input type="password" id="login-pass" name="pass" autocomplete="current-password">
    </div>
    <button type="button" id="continue">Continue</button>
  </form>
</div>`,
      js: `
document.getElementById('continue').addEventListener('click', function () {
  var row = document.getElementById('pw-row');
  if (!row.classList.contains('open')) {
    setTimeout(function () { row.classList.add('open'); document.getElementById('continue').textContent = 'Log in'; }, 300);
  }
});
${fxLive({ username: '#login-user', password: '#login-pass' })}`,
    }),
  },

  {
    id: 'h4-multi-04',
    category: 'multi-step',
    description: 'Brokerage log-in that swaps to a "Check your phone" view with a single one-time-code box after a short spinner.',
    steps: [
      step('signin', [x('#user', 'username'), x('#pass', 'password')], [], { advance: { click: '#login-btn' } }),
      step('otp', [x('#mfa-code', 'otp')], [], { wait: '#mfa-view:not([hidden]) #mfa-code' }),
    ],
    html: doc({
      title: 'Tidewater Brokerage – Log in',
      css: `
body{margin:0;font:15px "Helvetica Neue",sans-serif;background:#f4f6f8;color:#0b2239}
.card{width:400px;margin:70px auto;background:#fff;padding:30px;border-radius:4px;border:1px solid #d6dde4}
.f{margin-bottom:16px}.f label{display:block;font-size:13px;font-weight:600;margin-bottom:5px}
.f input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #8a99a8;border-radius:3px;font-size:15px}
.primary{width:100%;padding:11px;background:#0b2239;color:#fff;border:0;border-radius:3px}
.spin{display:none;text-align:center;padding:40px}.spin.on{display:block}
#mfa-code{letter-spacing:6px;font-size:22px;text-align:center}`,
      body: `
<div class="card">
  <div id="login-view">
    <h1 style="font-size:22px">Log in to Tidewater</h1>
    <form action="#" onsubmit="return false">
      <div class="f"><label for="user">User ID</label><input id="user" name="userId" type="text" autocomplete="username"></div>
      <div class="f"><label for="pass">Password</label><input id="pass" name="password" type="password" autocomplete="current-password"></div>
      <button class="primary" id="login-btn" type="button">Log in</button>
    </form>
  </div>
  <div class="spin" id="spin">Verifying…</div>
  <div id="mfa-view" hidden>
    <h1 style="font-size:22px">Check your phone</h1>
    <p>We sent a 6-digit code to the mobile number ending in 0148.</p>
    <form action="#" onsubmit="return false">
      <div class="f"><label for="mfa-code">Security code</label><input id="mfa-code" name="otpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>
      <label style="font-size:13px"><input type="checkbox" name="rememberDevice"> Don't ask again on this device</label>
      <p><button class="primary" type="submit">Verify</button></p>
      <a href="#">Resend code</a>
    </form>
  </div>
</div>`,
      js: `
var saved = { username: '', password: '' };
document.getElementById('login-btn').addEventListener('click', function () {
  saved.username = document.getElementById('user').value;
  saved.password = document.getElementById('pass').value;
  document.getElementById('login-view').remove();
  document.getElementById('spin').classList.add('on');
  setTimeout(function () {
    document.getElementById('spin').classList.remove('on');
    document.getElementById('mfa-view').hidden = false;
  }, 500);
});
${fxLive({ username: 'js:saved.username || val("#user")', password: 'js:saved.password || val("#pass")', otp: '#mfa-code' })}`,
    }),
  },

  {
    id: 'h4-multi-05',
    category: 'multi-step',
    description: 'Webmail sign-in across two real pages: the email page navigates to a password page that shows the address as text and keeps it in session storage.',
    steps: [
      step('email-first', [x('#login-email', 'username')], [], { advance: { click: '#next' } }),
      step('password-next', [x('#login-password', 'password')], [], { wait: '#pw-page #login-password' }),
    ],
    html: doc({
      title: 'Northbeam Mail',
      css: `
body{margin:0;font:15px Verdana,sans-serif;background:#e9f0fb}
.box{width:380px;margin:90px auto;background:#fff;padding:30px;border-radius:12px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #9ab;border-radius:8px;margin:8px 0 16px}
button{background:#3366cc;color:#fff;border:0;padding:10px 22px;border-radius:8px}`,
      body: `
<div class="box">
  <h1 style="font-size:22px">Northbeam Mail</h1>
  <form id="f1" action="#" onsubmit="return false">
    <label for="login-email">Your Northbeam address</label>
    <input id="login-email" type="email" name="login" autocomplete="username" placeholder="you@northbeam.example">
    <button id="next" type="button">Next</button>
  </form>
  <p><a href="#">Create a free mailbox</a></p>
</div>`,
      js: `
sessionStorage.removeItem('nb-login');
document.getElementById('next').addEventListener('click', function () {
  sessionStorage.setItem('nb-login', document.getElementById('login-email').value);
  location.href = '_steps/h4-multi-05-password.html';
});
${fxLive({ username: '#login-email' })}`,
    }),
    files: {
      '_steps/h4-multi-05-password.html': doc({
        title: 'Northbeam Mail – Password',
        css: `
body{margin:0;font:15px Verdana,sans-serif;background:#e9f0fb}
.box{width:380px;margin:90px auto;background:#fff;padding:30px;border-radius:12px}
.who{background:#eef3fb;border-radius:20px;padding:6px 14px;display:inline-block}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #9ab;border-radius:8px;margin:8px 0 16px}
button{background:#3366cc;color:#fff;border:0;padding:10px 22px;border-radius:8px}`,
        body: `
<div class="box" id="pw-page">
  <h1 style="font-size:22px">Enter your password</h1>
  <p class="who" id="who"></p> <a href="../h4-multi-05.html">Not you?</a>
  <form action="#" onsubmit="return false">
    <input type="hidden" name="login" id="carry">
    <label for="login-password">Password</label>
    <input id="login-password" type="password" name="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>`,
        js: `
var who = sessionStorage.getItem('nb-login') || '';
document.getElementById('who').textContent = who;
document.getElementById('carry').value = who;
${fxLive({ username: 'js:sessionStorage.getItem("nb-login") || ""', password: '#login-password' })}`,
      }),
    },
  },

  {
    id: 'h4-multi-06',
    category: 'multi-step',
    description: 'Account chooser listing two remembered accounts as buttons; picking one shows a password step with that account as text and a hidden login hint.',
    steps: [
      step('none', [], [], { advance: { click: '#acct-0' } }),
      step('password-next', [x('#chooser-pw', 'password')], [], { wait: '#pw-step.ready' }),
    ],
    html: doc({
      title: 'Choose an account – Saltmarsh Cloud',
      css: `
body{margin:0;font:15px system-ui,sans-serif;background:#f7f7f2}
.card{width:400px;margin:80px auto;background:#fff;border:1px solid #ddd;border-radius:10px;padding:26px}
.acct{display:flex;align-items:center;gap:12px;width:100%;padding:12px;border:0;border-bottom:1px solid #eee;background:none;text-align:left;cursor:pointer;font:inherit}
.dot{width:32px;height:32px;border-radius:50%;background:#4a7c59;color:#fff;display:grid;place-items:center}
#pw-step{display:none}#pw-step.ready{display:block}
#pw-step input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #aaa;border-radius:6px;margin:10px 0}`,
      body: `
<div class="card">
  <div id="choose">
    <h2>Choose an account</h2>
    <button class="acct" id="acct-0" data-email="m.okafor@saltmarsh.example"><span class="dot">M</span><span>Mira Okafor<br><small>m.okafor@saltmarsh.example</small></span></button>
    <button class="acct" id="acct-1" data-email="mira.home@post.example"><span class="dot">M</span><span>Mira (home)<br><small>mira.home@post.example</small></span></button>
    <button class="acct" id="acct-other"><span class="dot">+</span><span>Use another account</span></button>
  </div>
  <div id="pw-step">
    <h2>Hi <span id="first"></span></h2>
    <p id="picked"></p>
    <form action="#" onsubmit="return false">
      <input type="hidden" name="login_hint" id="login_hint">
      <label for="chooser-pw">Password</label>
      <input type="password" id="chooser-pw" name="password" autocomplete="current-password">
      <button type="submit">Sign in</button> <a href="#" id="switch">Switch account</a>
    </form>
  </div>
</div>`,
      js: `
var chosen = '';
document.querySelectorAll('.acct[data-email]').forEach(function (b) {
  b.addEventListener('click', function () {
    chosen = b.getAttribute('data-email');
    document.getElementById('choose').remove();
    document.getElementById('picked').textContent = chosen;
    document.getElementById('first').textContent = 'Mira';
    document.getElementById('login_hint').value = chosen;
    setTimeout(function () { document.getElementById('pw-step').classList.add('ready'); }, 200);
  });
});
${fxLive({ password: '#chooser-pw' })}`,
    }),
  },

  {
    id: 'h4-multi-07',
    category: 'multi-step',
    description: 'Bank "Online ID" first, then a route change that removes the first form, shows a skeleton, then the chosen security picture and phrase above a "Passcode" box.',
    steps: [
      step('email-first', [x('#onlineId', 'username')], [], { advance: { click: '#onlineId-continue' } }),
      step('password-next', [x('#passcode-input', 'password')], [], { wait: '#sitekey-step #passcode-input' }),
    ],
    html: doc({
      title: 'Glasswing Bank – Sign in',
      css: `
body{margin:0;font:15px Georgia,serif;background:#fff;color:#222}
.top{background:#5b2a86;color:#fff;padding:14px 36px;font-size:20px}
main{width:420px;margin:50px auto}
.skeleton{height:120px;border-radius:8px;background:linear-gradient(90deg,#eee,#f8f8f8,#eee);background-size:200%;animation:sh 1s infinite}
@keyframes sh{to{background-position:-200% 0}}
.pic{width:120px;height:90px;border-radius:6px;background:radial-gradient(circle at 30% 30%,#ffd166,#ef476f)}
.phrase{font-style:italic;margin:10px 0 20px}
label{display:block;margin-bottom:6px;font-weight:bold}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #777}
button{margin-top:16px;padding:10px 24px;background:#5b2a86;color:#fff;border:0}`,
      body: `
<div class="top">Glasswing Bank</div>
<main id="view"></main>`,
      js: `
var state = { username: '' };
var view = document.getElementById('view');
function first() {
  view.innerHTML = '<form id="id-form" action="#" onsubmit="return false"><h1>Sign in</h1>' +
    '<label for="onlineId">Online ID</label><input type="text" id="onlineId" name="onlineId" autocomplete="off">' +
    '<label style="font-weight:normal;margin-top:8px"><input type="checkbox" name="saveId"> Save this Online ID</label>' +
    '<button id="onlineId-continue" type="button">Continue</button></form>';
  document.getElementById('onlineId-continue').addEventListener('click', function () {
    state.username = document.getElementById('onlineId').value;
    view.innerHTML = '<div class="skeleton" aria-busy="true"></div>';
    setTimeout(second, 600);
  });
}
function second() {
  view.innerHTML = '<section id="sitekey-step"><h1>Is this your picture?</h1>' +
    '<div class="pic" role="img" aria-label="Your security picture"></div>' +
    '<p class="phrase">Your phrase: <span>lighthouse at dawn</span></p>' +
    '<p>If you recognise your picture and phrase, enter your passcode.</p>' +
    '<form action="#" onsubmit="return false"><label for="passcode-input">Passcode</label>' +
    '<input type="password" id="passcode-input" name="passcode" autocomplete="current-password">' +
    '<button type="submit">Sign in</button></form></section>';
}
first();
${fxLive({ username: 'js:state.username || val("#onlineId")', password: '#passcode-input' })}`,
    }),
  },
];
