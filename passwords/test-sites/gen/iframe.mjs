import { childRelay, fx, noise, parentMerge } from './kit.mjs';

const cat = 'iframe';
const widget = (uid, pid, heading, uLabel = 'Email', pLabel = 'Password') =>
  `<div style="padding:16px"><h2 style="margin-top:0">${heading}</h2><form onsubmit="return false"><div class="row"><label for="${uid}">${uLabel}</label><input id="${uid}" name="${uid}" type="text"></div><div class="row"><label for="${pid}">${pLabel}</label><input id="${pid}" name="${pid}" type="password"></div><button>Sign in</button></form></div>`;
const frameStyle = `border:1px solid var(--line);border-radius:8px;width:100%;max-width:420px;height:320px;background:var(--card)`;
const framePage = (path, main, map, extra = '') => ({ path, header: 'none', footer: 'none', title: 'Login widget', bare: true, main, script: childRelay(map, extra) });

fx({
  id: 'iframe-01', category: cat, brand: 'Acme Atlas', theme: 'slate', header: 'bar', footer: 'links',
  description: 'Same-origin login iframe embedded on a marketing page; the frame posts its state to the parent.',
  title: 'Acme Atlas',
  main: `<div class="split"><div><h1>Maps for field crews</h1><p>Offline tiles, job pins and a route sheet your whole crew can read.</p></div><iframe id="login-frame" title="Sign in" src="/fixtures/_frames/iframe-01.html" style="${frameStyle}"></iframe></div>`,
  pages: [framePage('_frames/iframe-01.html', widget('user', 'pass', 'Sign in'), { username: '#user', password: '#pass' })],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#user', role: 'username', frame: ['#login-frame'] },
    { selector: '#pass', role: 'password', frame: ['#login-frame'] },
  ] }],
});

fx({
  id: 'iframe-02', category: cat, brand: 'Kestrel Row', host: 'a.localhost', theme: 'paper', header: 'navbar', footer: 'legal',
  description: 'Different host on the same port: page on a.localhost embeds the sign-in widget from b.localhost. Browsers report this as cross-site (Sec-Fetch-Site: cross-site) because each *.localhost name is its own registrable domain; iframe-11 is the truly same-site case.',
  title: 'Kestrel Row members',
  main: `<h1>Members only</h1><p>Sign in with your Kestrel account to see this month&rsquo;s reading list.</p><iframe id="id-frame" title="Kestrel account" src="http://b.localhost:__PORT__/fixtures/_frames/iframe-02.html" style="${frameStyle}"></iframe>`,
  pages: [framePage('_frames/iframe-02.html', widget('kr-email', 'kr-pass', 'Kestrel account'), { username: '#kr-email', password: '#kr-pass' })],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', wait: '#id-frame', expected: [
    { selector: '#kr-email', role: 'username', frame: ['#id-frame'] },
    { selector: '#kr-pass', role: 'password', frame: ['#id-frame'] },
  ] }],
});

fx({
  id: 'iframe-03', category: cat, brand: 'Brindlewood Credit Union', theme: 'corp', header: 'utility', footer: 'table',
  description: 'Cross-origin by port: online banking login served from the second server port, embedded in the public site on the first.',
  title: 'Brindlewood - everyday banking',
  main: `<div class="split"><iframe id="ob-login" title="Online banking" src="http://localhost:__OTHER_PORT__/fixtures/_frames/iframe-03.html" style="${frameStyle}"></iframe><div><h1>Everyday banking</h1><p>No monthly fee on the Everyday account. Fee-free withdrawals at any member branch.</p>${noise.phishing('Brindlewood')}</div></div>`,
  pages: [framePage('_frames/iframe-03.html', widget('member', 'passcode', 'Online banking', 'Member number', 'Passcode'), { username: '#member', password: '#passcode' })],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#member', role: 'username', frame: ['#ob-login'] },
    { selector: '#passcode', role: 'password', frame: ['#ob-login'] },
  ] }],
});

fx({
  id: 'iframe-04', category: cat, brand: 'Dunmarrow Energy', theme: 'sun', header: 'bar', footer: 'news',
  description: 'Two same-origin frames deep: portal shell frame inside the page, login frame inside the shell.',
  title: 'Dunmarrow customer portal',
  main: `<h1>Customer portal</h1><p>See your bill, send a meter reading, or move house with us.</p><iframe id="outer" title="Portal" src="/fixtures/_frames/iframe-04-shell.html" style="border:1px solid var(--line);width:100%;max-width:520px;height:440px"></iframe>`,
  pages: [
    { path: '_frames/iframe-04-shell.html', header: 'none', footer: 'none', title: 'Portal shell', bare: true, main: `<div style="padding:10px"><p class="muted">Dunmarrow portal &middot; secure area</p><iframe id="inner" title="Sign in" src="/fixtures/_frames/iframe-04-login.html" style="${frameStyle}"></iframe></div>`, script: parentMerge({ username: '', password: '' }) },
    framePage('_frames/iframe-04-login.html', widget('acct-no', 'acct-pw', 'Sign in', 'Account number'), { username: '#acct-no', password: '#acct-pw' }),
  ],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#acct-no', role: 'username', frame: ['#outer', '#inner'] },
    { selector: '#acct-pw', role: 'password', frame: ['#outer', '#inner'] },
  ] }],
});

fx({
  id: 'iframe-05', category: cat, brand: 'Velvetine Cloud', host: 'a.localhost', theme: 'night', header: 'navbar', footer: 'links',
  description: 'Nested across origins: a.localhost embeds other.localhost on the second port, which embeds b.localhost holding the form.',
  title: 'Velvetine docs',
  main: `<h1>Docs</h1><p>Sign in to read the private sections of the handbook.</p><iframe id="broker" title="Identity broker" src="http://other.localhost:__OTHER_PORT__/fixtures/_frames/iframe-05-broker.html" style="border:0;width:100%;max-width:520px;height:440px"></iframe>`,
  pages: [
    { path: '_frames/iframe-05-broker.html', header: 'none', footer: 'none', title: 'Identity broker', bare: true, main: `<iframe id="idp" title="Identity provider" src="http://b.localhost:__PORT__/fixtures/_frames/iframe-05-idp.html" style="${frameStyle}"></iframe>`, script: parentMerge({ username: '', password: '' }) },
    framePage('_frames/iframe-05-idp.html', widget('idp-u', 'idp-p', 'Velvetine ID', 'Username'), { username: '#idp-u', password: '#idp-p' }),
  ],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#idp-u', role: 'username', frame: ['#broker', '#idp'] },
    { selector: '#idp-p', role: 'password', frame: ['#broker', '#idp'] },
  ] }],
});

fx({
  id: 'iframe-06', category: cat, brand: 'Marrowbone Press', theme: 'paper', header: 'none', footer: 'legal',
  description: 'Login widget iframe further down a page that opens with a newsletter form in the top document; the newsletter email must stay empty.',
  title: 'Marrowbone Press',
  main: `<form id="top-news" class="box" style="margin-bottom:24px" onsubmit="return false"><h2>The Sunday Letter</h2><p>Long reads, one email a week.</p><label for="sunday-email">Email address</label> <input id="sunday-email" type="email" name="email"> <button>Sign up</button></form>
  <h2>Already a subscriber?</h2><iframe id="sub-widget" title="Subscriber login" src="http://localhost:__OTHER_PORT__/fixtures/_frames/iframe-06.html" style="${frameStyle}"></iframe>`,
  pages: [framePage('_frames/iframe-06.html', widget('s-email', 's-pass', 'Subscriber login'), { username: '#s-email', password: '#s-pass' })],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', honeypots: ['#sunday-email'], expected: [
    { selector: '#s-email', role: 'username', frame: ['#sub-widget'] },
    { selector: '#s-pass', role: 'password', frame: ['#sub-widget'] },
  ] }],
});

const srcdocBody = `<!doctype html><meta charset=utf-8><style>body{font:15px system-ui;margin:12px}label{display:block;margin:8px 0 2px}input{width:100%;box-sizing:border-box;padding:6px}</style><form onsubmit='return false'><label for=sd-u>Login</label><input id=sd-u><label for=sd-p>Password</label><input id=sd-p type=password><p><button>Go</button></p></form><script>function s(){parent.postMessage({__fx:{username:document.getElementById('sd-u').value,password:document.getElementById('sd-p').value}},'*');}document.addEventListener('input',s,true);<\/script>`;

fx({
  id: 'iframe-07', category: cat, brand: 'Sable Notes', theme: 'slate', header: 'bar', footer: 'links',
  description: 'srcdoc iframe: no URL of its own, inherits the parent origin; the widget is embedded inline in the attribute.',
  title: 'Sable Notes',
  main: `<h1>Team spaces</h1><p>Share a notebook with your team and keep the rest to yourself.</p><iframe id="sd-frame" title="Login" style="${frameStyle}" srcdoc="${srcdocBody.replace(/"/g, '&quot;')}"></iframe>`,
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#sd-u', role: 'username', frame: ['#sd-frame'] },
    { selector: '#sd-p', role: 'password', frame: ['#sd-frame'] },
  ] }],
});

fx({
  id: 'iframe-08', category: cat, brand: 'Thistlegate Hosting', theme: 'corp', header: 'nameless', footer: 'legal',
  description: 'Lightbox iframe created only when the Log in button is clicked; before that the page has no form fields of its own.',
  title: 'Thistlegate status',
  css: `#lb{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}`,
  main: `<h1>Service status</h1><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><td>Web</td><td>Operational</td></tr><tr><td>Mail</td><td>Operational</td></tr></table><p><button id="lb-open" type="button">Log in to manage services</button></p>`,
  pages: [framePage('_frames/iframe-08.html', widget('tg-u', 'tg-p', 'Client login', 'Client email'), { username: '#tg-u', password: '#tg-p' })],
  script: parentMerge({ username: '', password: '' }) + `
document.getElementById('lb-open').addEventListener('click',function(){var d=document.createElement('div');d.id='lb';d.innerHTML='<iframe id="lb-frame" title="Client login" src="/fixtures/_frames/iframe-08.html" style="border:0;width:400px;max-width:92vw;height:320px;background:#fff"></iframe>';document.body.appendChild(d);});`,
  steps: [
    { kind: 'none', expected: [], advance: { click: '#lb-open' } },
    { kind: 'signin', wait: '#lb-frame', expected: [
      { selector: '#tg-u', role: 'username', frame: ['#lb-frame'] },
      { selector: '#tg-p', role: 'password', frame: ['#lb-frame'] },
    ] },
  ],
});

fx({
  id: 'iframe-09', category: cat, brand: 'Northgale Telecom', host: 'a.localhost', theme: 'forest', header: 'utility', footer: 'links',
  description: 'Identifier-then-password running entirely inside a b.localhost iframe, in place; the frame swaps its own views between steps.',
  title: 'Northgale - my account',
  main: `<h1>My account</h1><p>Check your data allowance and pay your bill.</p><iframe id="acct-frame" title="Sign in" src="http://b.localhost:__PORT__/fixtures/_frames/iframe-09.html" style="${frameStyle}"></iframe>`,
  pages: [{
    path: '_frames/iframe-09.html', header: 'none', footer: 'none', title: 'Sign in', bare: true,
    main: `<div style="padding:16px" id="vw"><h2>Sign in</h2><div class="row"><label for="ng-id">Email or mobile</label><input id="ng-id" name="id"></div><button id="ng-next" type="button">Next</button></div>`,
    script: `var S={username:'',password:''};function send(){parent.postMessage({__fx:S},'*');}window.__fixture={state:function(){return S;}};document.getElementById('ng-id').addEventListener('input',function(e){S.username=e.target.value;send();});
document.getElementById('ng-next').addEventListener('click',function(){var v=document.getElementById('vw');v.innerHTML='<h2>Password</h2><div class="row"><label for="ng-pw">Password</label><input id="ng-pw" name="pw" type="password"></div><button type="button">Sign in</button>';document.getElementById('ng-pw').addEventListener('input',function(e){S.password=e.target.value;send();});});`,
  }],
  script: parentMerge({ username: '', password: '' }),
  steps: [
    { kind: 'email-first', expected: [{ selector: '#ng-id', role: 'username', frame: ['#acct-frame'] }], advance: { click: '#ng-next', frame: ['#acct-frame'] } },
    { kind: 'password-next', expected: [{ selector: '#ng-pw', role: 'password', frame: ['#acct-frame'] }] },
  ],
});

fx({
  id: 'iframe-10', category: cat, brand: 'Palewing', theme: 'grape', header: 'navbar', footer: 'newsdiv',
  description: 'Frame plus shadow: cross-origin iframe holding a web component whose open shadow root contains the inputs.',
  title: 'Palewing community',
  main: `<h1>Community</h1><p>Join the conversation. Sign in with your Palewing account.</p><iframe id="cf" title="Palewing account" src="http://localhost:__OTHER_PORT__/fixtures/_frames/iframe-10.html" style="${frameStyle}"></iframe>`,
  pages: [{
    path: '_frames/iframe-10.html', header: 'none', footer: 'none', title: 'Palewing account', bare: true,
    main: `<pw-login id="pwl"></pw-login>`,
    script: `var S={username:'',password:''};function send(){parent.postMessage({__fx:S},'*');}window.__fixture={state:function(){return S;}};
customElements.define('pw-login',class extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'open'});r.innerHTML='<style>:host{display:block;padding:16px;font:15px system-ui}label{display:block;margin:10px 0 3px}input{width:100%;box-sizing:border-box;padding:6px}</style><label for="e">Email</label><input id="e" name="email" type="email"><label for="k">Password</label><input id="k" name="key" type="password"><p><button>Sign in</button></p>';r.getElementById('e').addEventListener('input',function(ev){S.username=ev.target.value;send();});r.getElementById('k').addEventListener('input',function(ev){S.password=ev.target.value;send();});}});`,
  }],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: ['#pwl', '#e'], role: 'username', frame: ['#cf'] },
    { selector: ['#pwl', '#k'], role: 'password', frame: ['#cf'] },
  ] }],
});

fx({
  id: 'iframe-11', category: cat, brand: 'Sundial Payroll', host: 'a.localhost', theme: 'sun', header: 'utility', footer: 'links',
  description: 'Truly same-site, different host: a.localhost embeds login.a.localhost on the same port, so the browser sends Sec-Fetch-Site: same-site and the two origins still differ.',
  title: 'Sundial Payroll',
  main: `<h1>Payslips</h1><p>Sign in to see this month&rsquo;s payslip and your leave balance.</p><iframe id="sso-frame" title="Sign in" src="http://login.a.localhost:__PORT__/fixtures/_frames/iframe-11.html" style="${frameStyle}"></iframe>`,
  pages: [framePage('_frames/iframe-11.html', widget('ss-user', 'ss-pass', 'Sign in', 'Work email'), { username: '#ss-user', password: '#ss-pass' })],
  script: parentMerge({ username: '', password: '' }),
  steps: [{ kind: 'signin', expected: [
    { selector: '#ss-user', role: 'username', frame: ['#sso-frame'] },
    { selector: '#ss-pass', role: 'password', frame: ['#sso-frame'] },
  ] }],
});
