import { fx, flowJs, noise } from './kit.mjs';

const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

// ---------------------------------------------------------------- email-first: same page, in place

const ef = 'email-first';

fx({
  id: 'email-first-01', category: ef, brand: 'Acme Ledger', theme: 'slate', header: 'navbar', footer: 'news',
  description: 'Email then Next; the password block starts with the hidden attribute, and the email turns read-only when it opens.',
  title: 'Sign in - Acme Ledger',
  main: `<div class="narrow box"><h1>Sign in</h1><form id="ef" onsubmit="return false">
  <div class="row"><label for="ef-email">Work email</label><input id="ef-email" name="email" type="email" autocomplete="username"></div>
  <div class="row" id="pw-block" hidden><label for="ef-pass">Password</label><input id="ef-pass" name="password" type="password" autocomplete="current-password"></div>
  <button type="button" id="next">Next</button><button type="submit" id="done" hidden>Sign in</button></form></div>${noise.features('Acme Ledger')}`,
  script: `document.getElementById('next').addEventListener('click',function(){var e=document.getElementById('ef-email');e.readOnly=true;document.getElementById('pw-block').hidden=false;this.hidden=true;document.getElementById('done').hidden=false;document.getElementById('ef-pass').focus();});`,
  state: { username: '#ef-email', password: '#ef-pass' },
  steps: [
    { kind: 'email-first', expected: [u('#ef-email')], advance: { click: '#next' } },
    { kind: 'password-next', wait: '#pw-block:not([hidden])', expected: [p('#ef-pass')] },
  ],
});

fx({
  id: 'email-first-02', category: ef, brand: 'Kestrel Row', theme: 'paper', header: 'bar', footer: 'legal',
  description: 'Password row is display:none via a class at first; the email stays editable afterwards, so step 2 is a full sign-in form with both fields.',
  title: 'Log in | Kestrel Row',
  css: `.is-collapsed{display:none}`,
  main: `<section class="narrow box"><h1>Log in</h1><form onsubmit="return false"><div class="row"><label for="k-mail">Email</label><input id="k-mail" name="user[email]" type="email"></div>
  <div class="row is-collapsed" id="k-pass-row"><label for="k-pass">Password</label><input id="k-pass" name="user[password]" type="password"></div>
  <button type="button" id="k-continue">Continue</button></form><p class="muted">Or <a href="#">get a sign-in link by email</a></p></section>`,
  script: `document.getElementById('k-continue').addEventListener('click',function(){document.getElementById('k-pass-row').classList.remove('is-collapsed');this.textContent='Log in';});`,
  state: { username: '#k-mail', password: '#k-pass' },
  steps: [
    { kind: 'email-first', expected: [u('#k-mail')], advance: { click: '#k-continue' } },
    { kind: 'signin', wait: '#k-pass-row:not(.is-collapsed)', expected: [u('#k-mail'), p('#k-pass')] },
  ],
});

fx({
  id: 'email-first-03', category: ef, brand: 'Ostlery Booking', theme: 'sun', header: 'utility', footer: 'links',
  description: 'After Continue the email input is replaced by plain text with a Change link, and the password input is inserted by JS.',
  title: 'Ostlery partner hub',
  main: `<div class="narrow box" id="card"><h1>Partner hub</h1><div id="slot"><div class="row"><label for="partner-mail">Email</label><input type="email" id="partner-mail" name="partner_email"></div></div><button id="cont" type="button">Continue</button></div>${noise.status()}`,
  script: `var S={username:'',password:''};var m=document.getElementById('partner-mail');m.addEventListener('input',function(){S.username=m.value;});
window.__fixture={state:function(){return S;}};
document.getElementById('cont').addEventListener('click',function(){var slot=document.getElementById('slot');slot.innerHTML='';var who=document.createElement('p');who.innerHTML='<b></b> <a href="#" id="change">Change</a>';who.querySelector('b').textContent=S.username;slot.appendChild(who);var r=document.createElement('div');r.className='row';r.innerHTML='<label for="partner-pass">Password</label><input type="password" id="partner-pass" name="partner_password">';slot.appendChild(r);var pw=r.querySelector('input');pw.addEventListener('input',function(){S.password=pw.value;});this.textContent='Sign in';this.id='signin-now';});`,
  steps: [
    { kind: 'email-first', expected: [u('#partner-mail')], advance: { click: '#cont' } },
    { kind: 'password-next', wait: '#partner-pass', expected: [p('#partner-pass')] },
  ],
});

fx({
  id: 'email-first-04', category: ef, brand: 'Fernhollow Studio', theme: 'grape', header: 'nameless', footer: 'newsdiv',
  description: 'No form element; the password area sits in a max-height:0 overflow:hidden collapse with aria-expanded, so it has no visible height at first.',
  title: 'Fernhollow Studio',
  css: `.collapse-x{max-height:0;overflow:hidden;transition:max-height .15s}.collapse-x.open{max-height:200px}`,
  main: `<div class="narrow box" role="group" aria-label="Sign in"><h2>Sign in to your studio</h2>
  <div class="row"><input id="fh-id" type="text" placeholder="you@studio.example" aria-label="Email"></div>
  <div class="collapse-x" id="fh-more" aria-hidden="true"><div class="row"><input id="fh-pw" type="password" placeholder="Password" aria-label="Password" tabindex="-1"></div></div>
  <button id="fh-next" type="button" aria-expanded="false" aria-controls="fh-more">Next</button></div>`,
  script: `document.getElementById('fh-next').addEventListener('click',function(){var m=document.getElementById('fh-more');m.addEventListener('transitionend',function(){m.setAttribute('data-settled','true');},{once:true});m.classList.add('open');m.setAttribute('aria-hidden','false');document.getElementById('fh-pw').removeAttribute('tabindex');this.setAttribute('aria-expanded','true');this.textContent='Sign in';document.getElementById('fh-id').readOnly=true;});`,
  state: { username: '#fh-id', password: '#fh-pw' },
  steps: [
    { kind: 'email-first', expected: [u('#fh-id')], advance: { click: '#fh-next' } },
    { kind: 'password-next', wait: '#fh-more[data-settled]', expected: [p('#fh-pw')] },
  ],
});

fx({
  id: 'email-first-05', category: ef, brand: 'Tidewrack Systems', theme: 'corp', header: 'bar', footer: 'lang',
  description: 'Next performs a fake home-realm lookup (600 ms spinner) before the password field is created; a Use SSO link sits beside it.',
  title: 'Tidewrack sign-in',
  main: `<div class="narrow box"><h1>Sign in</h1><form id="hrd" onsubmit="return false"><div class="row"><label for="td-user">Corporate email</label><input id="td-user" name="identifier" type="email"></div><div id="pw-mount"></div><button type="button" id="td-next">Next</button> <a href="#sso">Use single sign-on</a><span id="spin" hidden> Checking your organisation&hellip;</span></form></div>`,
  script: `var S={username:'',password:''};document.getElementById('td-user').addEventListener('input',function(e){S.username=e.target.value;});window.__fixture={state:function(){return S;}};
document.getElementById('td-next').addEventListener('click',function(){var b=this;b.disabled=true;document.getElementById('spin').hidden=false;setTimeout(function(){document.getElementById('spin').hidden=true;var m=document.getElementById('pw-mount');m.innerHTML='<div class="row"><label for="td-pass">Password</label><input id="td-pass" name="credential" type="password"></div>';m.querySelector('input').addEventListener('input',function(e){S.password=e.target.value;});document.getElementById('td-user').setAttribute('readonly','');b.disabled=false;b.textContent='Sign in';},600);});`,
  steps: [
    { kind: 'email-first', expected: [u('#td-user')], advance: { click: '#td-next' } },
    { kind: 'password-next', wait: '#td-pass', expected: [p('#td-pass')] },
  ],
});

fx({
  id: 'email-first-06', category: ef, brand: 'Marrowbone Press', theme: 'paper', header: 'navbar', footer: 'news',
  description: 'Subscriber login where the password starts opacity:0 height:0 under a data-step attribute; Email me a sign-in link appears next to it; magazine article teaser around it.',
  title: 'Subscriber log in - Marrowbone Press',
  css: `[data-step="1"] .pw-area{opacity:0;height:0;overflow:hidden;pointer-events:none}`,
  main: `<div class="split"><article><h2>The long road to the perfect pencil</h2><p>A hundred and fifty years of graphite, cedar and stubbornness. Log in to keep reading this story, or subscribe from 3 a month.</p></article>
  <form class="box" id="sub" data-step="1" onsubmit="return false"><h2>Subscriber log in</h2>
  <div class="row"><label for="sub-e">Email</label><input id="sub-e" name="e" type="email"></div>
  <div class="pw-area"><div class="row"><label for="sub-p">Password</label><input id="sub-p" name="p" type="password"></div><p><a href="#magic">Email me a sign-in link instead</a></p></div>
  <button id="sub-next" type="button">Continue</button></form></div>`,
  script: `document.getElementById('sub-next').addEventListener('click',function(){document.getElementById('sub').setAttribute('data-step','2');document.getElementById('sub-e').readOnly=true;});`,
  state: { username: '#sub-e', password: '#sub-p' },
  steps: [
    { kind: 'email-first', expected: [u('#sub-e')], advance: { click: '#sub-next' } },
    { kind: 'password-next', wait: '#sub[data-step="2"]', expected: [p('#sub-p')] },
  ],
});

// ---------------------------------------------------------------- multi-step

const ms = 'multi-step';

fx({
  id: 'multi-step-01', category: ms, brand: 'Galdric', theme: 'corp', header: 'none', footer: 'lang',
  description: 'Big-tech style identifier view, removed from the DOM on Next; the password view is a fresh subtree showing the identifier as a chip, with a Forgot email link and Create account.',
  title: 'Sign in - Galdric Accounts',
  css: `.gcard{max-width:440px;margin:60px auto;padding:36px;border:1px solid var(--line);border-radius:10px}.gcard .act{display:flex;justify-content:space-between;align-items:center;margin-top:24px}.chip{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 12px}`,
  main: `<div class="gcard" id="app"></div>`,
  script: `var S={username:'',password:''};var app=document.getElementById('app');
function ident(){app.innerHTML='<h1>Sign in</h1><p>Use your Galdric account</p><div class="row"><label for="ident">Email or phone</label><input id="ident" type="email" name="identifier" autocomplete="username"></div><a href="#">Forgot email?</a><p class="muted">Not your computer? Use a private window to sign in.</p><div class="act"><a href="#">Create account</a><button id="idNext" type="button">Next</button></div>';
 var i=document.getElementById('ident');i.value=S.username;i.addEventListener('input',function(){S.username=i.value;});document.getElementById('idNext').addEventListener('click',pass);}
function pass(){app.innerHTML='<h1>Welcome</h1><p class="chip" id="who"></p><div class="row" style="margin-top:16px"><label for="pwinput">Enter your password</label><input id="pwinput" type="password" name="Passwd" autocomplete="current-password"></div><label style="font-weight:400"><input type="checkbox" id="showpw"> Show password</label><div class="act"><a href="#">Forgot password?</a><button id="pwNext" type="button">Next</button></div>';
 document.getElementById('who').textContent=S.username;var i=document.getElementById('pwinput');i.addEventListener('input',function(){S.password=i.value;});document.getElementById('showpw').addEventListener('change',function(){i.type=this.checked?'text':'password';});}
ident();window.__fixture={state:function(){return S;}};`,
  steps: [
    { kind: 'email-first', wait: '#ident', expected: [u('#ident')], advance: { click: '#idNext' } },
    { kind: 'password-next', wait: '#pwinput', expected: [p('#pwinput')] },
  ],
});

fx({
  id: 'multi-step-02', category: ms, brand: 'Contessa Suite', theme: 'slate', header: 'none', footer: 'legal',
  description: 'Enterprise style: identifier panel hidden by display:none (still in DOM), password panel with an identity banner and a Not you? use another account link that goes back.',
  title: 'Sign in to your account',
  css: `.panel{max-width:440px;margin:70px auto;background:var(--card);padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.2)}.panel--off{display:none}.ident-banner{display:block;margin-bottom:10px}`,
  main: `<div class="panel" id="p1"><h1>Sign in</h1><input id="login_identity" name="login_identity" type="email" placeholder="Email, phone, or username" style="width:100%" aria-required="true"><p class="muted">No account? <a href="#">Create one!</a></p><p><a href="#">Can&rsquo;t access your account?</a></p><button id="idSubmit" type="button">Next</button></div>
  <div class="panel panel--off" id="p2"><button class="linkbtn ident-banner" id="back" type="button">&larr; <span id="banner-who"></span></button><h1>Enter password</h1><input id="passwd" name="passwd" type="password" placeholder="Password" style="width:100%"><p><a href="#">Forgot my password</a></p><p><button type="button" class="linkbtn" id="not-you">Not you? Use another account</button></p><button id="pwSubmit" type="button">Sign in</button></div>`,
  script: `var a=document.getElementById('p1'),b=document.getElementById('p2');function sw(x){a.classList.toggle('panel--off',x);b.classList.toggle('panel--off',!x);}document.getElementById('idSubmit').addEventListener('click',function(){document.getElementById('banner-who').textContent=document.getElementById('login_identity').value;sw(true);});document.getElementById('back').addEventListener('click',function(){sw(false);});document.getElementById('not-you').addEventListener('click',function(){document.getElementById('login_identity').value='';sw(false);});`,
  state: { username: '#login_identity', password: '#passwd' },
  steps: [
    { kind: 'email-first', expected: [u('#login_identity')], advance: { click: '#idSubmit' } },
    { kind: 'password-next', wait: '#p2:not(.panel--off)', expected: [p('#passwd')] },
  ],
});

// Real navigation flows. advance.goto names the next document.
const flowPage = (id, n) => `_steps/${id}-${n}.html`;
const flowUrl = (id, n) => `/fixtures/${flowPage(id, n)}`;

fx({
  id: 'multi-step-03', category: ms, brand: 'Northgale Telecom', theme: 'forest', header: 'utility', footer: 'links',
  description: 'Real page navigation: identifier page, then a second document with a hidden username input carrying the value and a read-only text display.',
  title: 'My Northgale - sign in',
  main: `<div class="narrow box"><h1>My Northgale</h1><form id="f1" action="${flowUrl('multi-step-03', 2)}"><div class="row"><label for="acct">Email or mobile number</label><input id="acct" name="acct" type="text"></div><button type="submit">Next</button></form></div>${noise.features('Northgale')}`,
  script: flowJs({ flow: 'ms03', first: true, fields: { username: '#acct' }, next: flowUrl('multi-step-03', 2), submitSel: '#f1' }),
  pages: [{
    path: flowPage('multi-step-03', 2), title: 'My Northgale - password',
    main: `<div class="narrow box"><h1>Enter your password</h1><p>Signing in as <b id="who"></b> &middot; <a href="/fixtures/multi-step-03.html">Not you?</a></p><form id="f2" onsubmit="return false"><input type="hidden" name="username" id="hidden-username"><div class="row"><label for="pw2">Password</label><input id="pw2" name="password" type="password" autocomplete="current-password"></div><button>Sign in</button></form></div>`,
    script: flowJs({ flow: 'ms03', fields: { password: '#pw2' }, afterLoad: `document.getElementById('who').textContent=S.username||'';document.getElementById('hidden-username').value=S.username||'';` }),
  }],
  steps: [
    { kind: 'email-first', expected: [u('#acct')], advance: { goto: flowUrl('multi-step-03', 2) } },
    { kind: 'password-next', wait: '#pw2', expected: [p('#pw2')], honeypots: ['#hidden-username'] },
  ],
});

fx({
  id: 'multi-step-04', category: ms, brand: 'Bellwether Trust', theme: 'corp', header: 'utility', footer: 'table',
  description: 'Three real pages: user ID, password, then a 6-digit SMS code page. Bank wording with no account detail shown between steps.',
  title: 'Bellwether Online - User ID',
  main: `<div class="narrow box"><h1>Log in</h1><form id="b1" action="${flowUrl('multi-step-04', 2)}"><div class="row"><label for="userid">User ID</label><input id="userid" name="userid" type="text"></div><label style="font-weight:400"><input type="checkbox"> Save user ID</label><p><button>Continue</button></p></form></div>${noise.phishing('Bellwether')}`,
  script: flowJs({ flow: 'ms04', first: true, fields: { username: '#userid' }, next: flowUrl('multi-step-04', 2), submitSel: '#b1' }),
  pages: [{
    path: flowPage('multi-step-04', 2), title: 'Bellwether Online - Password',
    main: `<div class="narrow box"><h1>Log in</h1><p class="muted">User ID: <span id="mask"></span></p><form id="b2" action="${flowUrl('multi-step-04', 3)}"><div class="row"><label for="bw-pass">Password</label><input id="bw-pass" name="bw_pass" type="password"></div><button>Continue</button> <a href="#">Forgot password?</a></form></div>`,
    script: flowJs({ flow: 'ms04', fields: { password: '#bw-pass' }, next: flowUrl('multi-step-04', 3), submitSel: '#b2', afterLoad: `document.getElementById('mask').textContent=(S.username||'').slice(0,2)+'*****';` }),
  }, {
    path: flowPage('multi-step-04', 3), title: 'Bellwether Online - Verify',
    main: `<div class="narrow box"><h1>Verify it&rsquo;s you</h1><p>We texted a code to your mobile ending in 42. It expires in five minutes.</p><form onsubmit="return false"><div class="row"><label for="bw-code">Verification code</label><input id="bw-code" name="otpcode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div><button>Verify</button> <a href="#">Send a new code</a></form></div>`,
    script: flowJs({ flow: 'ms04', fields: { otp: '#bw-code' } }),
  }],
  steps: [
    { kind: 'email-first', expected: [u('#userid')], advance: { goto: flowUrl('multi-step-04', 2) } },
    { kind: 'password-next', wait: '#bw-pass', expected: [p('#bw-pass')], advance: { goto: flowUrl('multi-step-04', 3) } },
    { kind: 'otp', wait: '#bw-code', expected: [{ selector: '#bw-code', role: 'otp' }] },
  ],
});

fx({
  id: 'multi-step-05', category: ms, brand: 'Velvetine Cloud', theme: 'night', header: 'none', footer: 'legal',
  description: 'Single-page app with three views swapped in one container: identifier, password, authenticator code. Each view replaces the previous one in the DOM.',
  title: 'Velvetine',
  main: `<div class="narrow box" id="view" style="margin-top:60px"></div>`,
  script: `var S={username:'',password:'',otp:''};var v=document.getElementById('view');
function bind(id,key){var i=document.getElementById(id);i.addEventListener('input',function(){S[key]=i.value;});}
function one(){v.innerHTML='<h1>Sign in</h1><div class="row"><label for="v-user">Username</label><input id="v-user" autocomplete="username"></div><button id="v-next1" type="button">Next</button>';bind('v-user','username');document.getElementById('v-next1').onclick=two;}
function two(){v.innerHTML='<h1>Password</h1><p class="muted" id="v-who"></p><div class="row"><label for="v-pass">Password</label><input id="v-pass" type="password" autocomplete="current-password"></div><button id="v-next2" type="button">Next</button>';document.getElementById('v-who').textContent=S.username;bind('v-pass','password');document.getElementById('v-next2').onclick=three;}
function three(){v.innerHTML='<h1>Two-factor check</h1><p>Enter the code from your authenticator app.</p><div class="row"><label for="v-totp">6-digit code</label><input id="v-totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div><button type="button">Verify</button><p class="muted"><a href="#">Use a backup code instead</a></p>';bind('v-totp','otp');}
one();window.__fixture={state:function(){return S;}};`,
  steps: [
    { kind: 'email-first', wait: '#v-user', expected: [u('#v-user')], advance: { click: '#v-next1' } },
    { kind: 'password-next', wait: '#v-pass', expected: [p('#v-pass')], advance: { click: '#v-next2' } },
    { kind: 'otp', wait: '#v-totp', expected: [{ selector: '#v-totp', role: 'otp' }] },
  ],
});

fx({
  id: 'multi-step-06', category: ms, brand: 'Hollowmere Mail', theme: 'paper', header: 'navbar', footer: 'links',
  description: 'Second view shows the username in a visible read-only input and also a hidden input carrying it; only the password should be filled.',
  title: 'Hollowmere Mail',
  main: `<div class="narrow box"><form id="hm" onsubmit="return false"><div id="s1"><h1>Log in to your mailbox</h1><div class="row"><label for="hm-user">Mailbox address</label><input id="hm-user" type="text" name="mailbox"></div><button type="button" id="hm-go">Next</button></div></form></div>`,
  script: `var S={username:'',password:''};document.getElementById('hm-user').addEventListener('input',function(e){S.username=e.target.value;});window.__fixture={state:function(){return S;}};
document.getElementById('hm-go').addEventListener('click',function(){var f=document.getElementById('hm');document.getElementById('s1').remove();var d=document.createElement('div');d.innerHTML='<h1>Enter password</h1><input type="hidden" name="mailbox" id="hm-carry"><div class="row"><label for="hm-ro">Mailbox address</label><input id="hm-ro" type="text" readonly></div><div class="row"><label for="hm-pw">Password</label><input id="hm-pw" name="mailpass" type="password"></div><p><a href="#" id="hm-other">Not you? Use another account</a></p><button>Log in</button>';f.appendChild(d);document.getElementById('hm-carry').value=S.username;document.getElementById('hm-ro').value=S.username;document.getElementById('hm-pw').addEventListener('input',function(e){S.password=e.target.value;});});`,
  steps: [
    { kind: 'email-first', expected: [u('#hm-user')], advance: { click: '#hm-go' } },
    { kind: 'password-next', wait: '#hm-pw', expected: [p('#hm-pw')], honeypots: ['#hm-carry'] },
  ],
});

fx({
  id: 'multi-step-07', category: ms, brand: 'Galdric', theme: 'corp', header: 'none', footer: 'lang',
  description: 'Account chooser first: remembered profiles and Use another account, no inputs. Then identifier, then password, each replacing the last.',
  title: 'Choose an account',
  css: `.chooser{list-style:none;padding:0}.chooser li{padding:10px;border-bottom:1px solid var(--line)}.gcard{max-width:440px;margin:60px auto;padding:36px;border:1px solid var(--line);border-radius:10px}`,
  main: `<div class="gcard" id="app"><h1>Choose an account</h1><ul class="chooser"><li><a href="#">Pat Example<br><small>pat@example.test</small></a></li><li><a href="#">Robin Sample<br><small>robin@example.test</small></a></li><li><button type="button" class="linkbtn" id="use-another">Use another account</button></li></ul></div>`,
  script: `var S={username:'',password:''};var a=document.getElementById('app');window.__fixture={state:function(){return S;}};
document.getElementById('use-another').addEventListener('click',function(){a.innerHTML='<h1>Sign in</h1><div class="row"><label for="ac-id">Email or phone</label><input id="ac-id" type="text" name="identifier"></div><button id="ac-next" type="button">Next</button>';var i=document.getElementById('ac-id');i.addEventListener('input',function(){S.username=i.value;});document.getElementById('ac-next').addEventListener('click',function(){a.innerHTML='<h1>Hi there</h1><div class="row"><label for="ac-pw">Enter your password</label><input id="ac-pw" type="password" name="password"></div><button type="button">Next</button>';var p=document.getElementById('ac-pw');p.addEventListener('input',function(){S.password=p.value;});});});`,
  steps: [
    { kind: 'none', expected: [], advance: { click: '#use-another' } },
    { kind: 'email-first', wait: '#ac-id', expected: [u('#ac-id')], advance: { click: '#ac-next' } },
    { kind: 'password-next', wait: '#ac-pw', expected: [p('#ac-pw')] },
  ],
});

fx({
  id: 'multi-step-08', category: ms, brand: 'Sundial Payroll', host: 'other.localhost', theme: 'sun', header: 'bar', footer: 'news',
  description: 'Real navigation on another host; step 2 keeps the identifier in a visible read-only field with an Edit link beside it, plus a marketing panel.',
  title: 'Sundial Payroll - log in',
  main: `<div class="split"><div class="box"><h1>Log in to payroll</h1><form id="sd1" action="${flowUrl('multi-step-08', 2)}"><div class="row"><label for="sd-user">Work email</label><input id="sd-user" name="workEmail" type="email"></div><button>Next</button></form></div><div>${noise.quote('Sundial')}</div></div>`,
  script: flowJs({ flow: 'ms08', first: true, fields: { username: '#sd-user' }, next: flowUrl('multi-step-08', 2), submitSel: '#sd1' }),
  pages: [{
    path: flowPage('multi-step-08', 2), title: 'Sundial Payroll - password',
    main: `<div class="narrow box"><h1>Almost there</h1><form onsubmit="return false"><div class="row"><label for="sd-ro">Work email <a href="/fixtures/multi-step-08.html" style="font-weight:400">Edit</a></label><input id="sd-ro" readonly disabled></div><div class="row"><label for="sd-pass">Password</label><input id="sd-pass" name="pass" type="password"></div><button>Log in</button></form></div>`,
    script: flowJs({ flow: 'ms08', fields: { password: '#sd-pass' }, afterLoad: `document.getElementById('sd-ro').value=S.username||'';` }),
  }],
  steps: [
    { kind: 'email-first', expected: [u('#sd-user')], advance: { goto: flowUrl('multi-step-08', 2) } },
    { kind: 'password-next', wait: '#sd-pass', expected: [p('#sd-pass')] },
  ],
});

fx({
  id: 'multi-step-09', category: ms, brand: 'Palewing', theme: 'grape', header: 'navbar', footer: 'legal',
  description: 'Carousel: both slides stay in the DOM and the track slides sideways with overflow hidden, so the password is clipped off to the side on step 1 and the identifier on step 2. Inactive slide gets aria-hidden and inert.',
  title: 'Palewing sign-in',
  css: `.viewport{overflow:hidden;max-width:420px;margin:40px auto;background:var(--card);border-radius:12px;border:1px solid var(--line)}.track{display:flex;width:200%;transition:transform .15s}.track.at-2{transform:translateX(-50%)}.slide{width:50%;padding:28px}`,
  main: `<div class="viewport"><div class="track" id="tr"><section class="slide" id="sl1"><h2>Sign in</h2><div class="row"><label for="pw-id">Email address</label><input id="pw-id" name="email" type="email"></div><button type="button" id="pw-next">Continue</button></section><section class="slide" id="sl2" aria-hidden="true" inert><h2>Your password</h2><div class="row"><label for="pw-sec">Password</label><input id="pw-sec" name="password" type="password"></div><button type="button">Sign in</button><button type="button" id="pw-back" class="linkbtn" style="margin-left:10px">Back</button></section></div></div>`,
  script: `document.getElementById('tr').addEventListener('transitionend',function(e){e.currentTarget.setAttribute('data-settled',e.currentTarget.classList.contains('at-2')?'2':'1');});
function go(n){var t=document.getElementById('tr'),a=document.getElementById('sl1'),b=document.getElementById('sl2');t.classList.toggle('at-2',n===2);a.toggleAttribute('inert',n===2);b.toggleAttribute('inert',n===1);a.setAttribute('aria-hidden',String(n===2));b.setAttribute('aria-hidden',String(n===1));}document.getElementById('pw-next').addEventListener('click',function(){go(2);});document.getElementById('pw-back').addEventListener('click',function(){go(1);});`,
  state: { username: '#pw-id', password: '#pw-sec' },
  steps: [
    { kind: 'email-first', expected: [u('#pw-id')], advance: { click: '#pw-next' } },
    { kind: 'password-next', wait: '#tr[data-settled="2"]', expected: [p('#pw-sec')] },
  ],
});

fx({
  id: 'multi-step-10', category: ms, brand: 'Dappermint Pay', theme: 'grape', header: 'minimal', footer: 'legal',
  description: 'Passwordless: phone number first, then an SMS code on the next view. There is no password anywhere in this flow.',
  title: 'Dappermint - log in with your phone',
  main: `<div class="narrow box" id="dm"><h1>Enter your phone number</h1><form id="dm1" onsubmit="return false"><div class="row"><label for="dm-phone">Phone number</label><input id="dm-phone" name="phone_number" type="tel" autocomplete="tel"></div><button id="dm-send">Text me a code</button></form></div>`,
  script: `var S={username:'',otp:''};document.getElementById('dm-phone').addEventListener('input',function(e){S.username=e.target.value;});window.__fixture={state:function(){return S;}};
document.getElementById('dm-send').addEventListener('click',function(){var d=document.getElementById('dm');d.innerHTML='<h1>Check your messages</h1><p>We sent a text with a 6-digit code.</p><div class="row"><label for="dm-code">Code</label><input id="dm-code" name="sms_otp" inputmode="numeric" autocomplete="one-time-code"></div><button type="button">Verify</button> <a href="#">Resend</a>';document.getElementById('dm-code').addEventListener('input',function(e){S.otp=e.target.value;});});`,
  steps: [
    { kind: 'email-first', expected: [u('#dm-phone')], advance: { click: '#dm-send' } },
    { kind: 'otp', wait: '#dm-code', expected: [{ selector: '#dm-code', role: 'otp' }] },
  ],
});

fx({
  id: 'multi-step-11', category: ms, brand: 'Ironfern Security', theme: 'night', header: 'none', footer: 'legal',
  description: 'Three in-place steps ending in six split digit boxes; earlier panels stay in the DOM but hidden by the hidden attribute, so hidden fields keep their values.',
  title: 'Ironfern SSO',
  css: `.digits{display:flex;gap:6px}.digits input{width:42px;text-align:center}`,
  main: `<div class="narrow box" style="margin-top:50px"><section id="a1"><h1>Single sign-on</h1><div class="row"><label for="if-u">Corporate ID</label><input id="if-u" name="corp_id"></div><button type="button" id="if-1">Next</button></section>
  <section id="a2" hidden><h1>Password</h1><div class="row"><label for="if-p">Directory password</label><input id="if-p" name="dir_pass" type="password"></div><button type="button" id="if-2">Next</button></section>
  <section id="a3" hidden><h1>Authenticator code</h1><p>Open your authenticator app and type the six digits.</p><div class="digits" id="digits">${[1, 2, 3, 4, 5, 6].map((n) => `<input id="if-d${n}" maxlength="1" inputmode="numeric" aria-label="Digit ${n}">`).join('')}</div></section></div>`,
  script: `function show(n){['a1','a2','a3'].forEach(function(id,i){document.getElementById(id).hidden=(i+1)!==n;});}
document.getElementById('if-1').addEventListener('click',function(){show(2);});document.getElementById('if-2').addEventListener('click',function(){show(3);});
var boxes=[].slice.call(document.querySelectorAll('#digits input'));boxes.forEach(function(b,i){b.addEventListener('input',function(){if(b.value&&boxes[i+1])boxes[i+1].focus();});});`,
  state: { username: '#if-u', password: '#if-p', otp: [1, 2, 3, 4, 5, 6].map((n) => `#if-d${n}`) },
  steps: [
    { kind: 'email-first', expected: [u('#if-u')], advance: { click: '#if-1' } },
    { kind: 'password-next', wait: '#a2:not([hidden])', expected: [p('#if-p')], advance: { click: '#if-2' } },
    { kind: 'otp', wait: '#a3:not([hidden])', expected: [1, 2, 3, 4, 5, 6].map((n) => ({ selector: `#if-d${n}`, role: 'otp-digit' })) },
  ],
});

fx({
  id: 'multi-step-12', category: ms, brand: 'Contessa Suite', theme: 'slate', header: 'none', footer: 'legal',
  description: 'Real navigation: identifier, password, then a Stay signed in? interstitial with only Yes and No buttons, which has nothing to fill.',
  title: 'Sign in to your account',
  main: `<div class="narrow box" style="margin-top:60px"><h1>Sign in</h1><form id="c1" action="${flowUrl('multi-step-12', 2)}"><input id="c-login" name="c_login" type="email" placeholder="Email or phone" style="width:100%"><p><a href="#">Sign-in options</a></p><button>Next</button></form></div>`,
  script: flowJs({ flow: 'ms12', first: true, fields: { username: '#c-login' }, next: flowUrl('multi-step-12', 2), submitSel: '#c1' }),
  pages: [{
    path: flowPage('multi-step-12', 2), title: 'Enter password',
    main: `<div class="narrow box" style="margin-top:60px"><p id="c-who" class="muted"></p><h1>Enter password</h1><form id="c2" action="${flowUrl('multi-step-12', 3)}"><input type="hidden" name="c_login" id="c-hidden"><input id="c-pass" name="c_pass" type="password" placeholder="Password" style="width:100%"><p><a href="/fixtures/multi-step-12.html">Use a different account</a></p><button>Sign in</button></form></div>`,
    script: flowJs({ flow: 'ms12', fields: { password: '#c-pass' }, next: flowUrl('multi-step-12', 3), submitSel: '#c2', afterLoad: `document.getElementById('c-who').textContent=S.username||'';document.getElementById('c-hidden').value=S.username||'';` }),
  }, {
    path: flowPage('multi-step-12', 3), title: 'Stay signed in?',
    main: `<div class="narrow box" style="margin-top:60px"><h1>Stay signed in?</h1><p>Do this to reduce the number of times you are asked to sign in.</p><label style="font-weight:400"><input type="checkbox" id="c-dontshow"> Don&rsquo;t show this again</label><p><button id="c-no" type="button" style="background:var(--line);color:var(--fg)">No</button> <button id="c-yes" type="button">Yes</button></p></div>`,
    script: flowJs({ flow: 'ms12' }),
  }],
  steps: [
    { kind: 'email-first', expected: [u('#c-login')], advance: { goto: flowUrl('multi-step-12', 2) } },
    { kind: 'password-next', wait: '#c-pass', expected: [p('#c-pass')], honeypots: ['#c-hidden'], advance: { goto: flowUrl('multi-step-12', 3) } },
    { kind: 'none', wait: '#c-yes', expected: [] },
  ],
});
