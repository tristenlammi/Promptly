import { fx, noise } from './kit.mjs';

const cat = 'modal';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

const heroCss = `.hero{padding:40px 0}.hero h1{font-size:2em}`;
const openerStep = (sel, extra = {}) => ({ kind: 'none', expected: [], advance: { click: sel }, ...extra });

fx({
  id: 'modal-01', category: cat, brand: 'Acme Harvest', theme: 'forest', header: 'bar', footer: 'news',
  description: 'Native dialog element opened with showModal by a Log in button; the form is in the DOM but not rendered until then.',
  title: 'Acme Harvest - seed subscriptions',
  css: heroCss + `dialog{border:1px solid var(--line);border-radius:10px;padding:24px;width:min(380px,90vw);background:var(--card);color:var(--fg)}dialog::backdrop{background:rgba(0,0,0,.4)}`,
  main: `<section class="hero"><h1>Seeds that actually come up</h1><p>A box of heritage varieties every season, chosen for your climate.</p><button id="open-login" type="button">Log in</button></section>${noise.features('Acme Harvest')}
  <dialog id="login-dialog"><form method="dialog" onsubmit="return false"><h2>Log in</h2><div class="row"><label for="dlg-email">Email</label><input id="dlg-email" type="email" name="email"></div><div class="row"><label for="dlg-pass">Password</label><input id="dlg-pass" type="password" name="password"></div><button>Log in</button> <button type="button" id="dlg-close" class="linkbtn">Close</button></form></dialog>`,
  script: `var d=document.getElementById('login-dialog');document.getElementById('open-login').addEventListener('click',function(){d.showModal();});document.getElementById('dlg-close').addEventListener('click',function(){d.close();});`,
  state: { username: '#dlg-email', password: '#dlg-pass' },
  steps: [
    openerStep('#open-login'),
    { kind: 'signin', wait: 'dialog[open]', expected: [u('#dlg-email'), p('#dlg-pass')] },
  ],
});

fx({
  id: 'modal-02', category: cat, brand: 'Marrowbone Press', theme: 'paper', header: 'navbar', footer: 'links',
  description: 'Paywall overlay auto-opens on a timer about a second after load and is appended to body at that moment; article text behind it.',
  title: 'The pencil, reconsidered',
  css: `.overlay{position:fixed;inset:0;background:rgba(20,20,20,.55);display:flex;align-items:center;justify-content:center;z-index:50}.overlay__box{background:var(--card);padding:28px;border-radius:8px;width:min(400px,92vw)}`,
  main: `<article><h1>The pencil, reconsidered</h1><p>It began, as these things do, with a shortage. By the spring the workshop had run out of cedar and the foreman had run out of patience.</p><p>What followed was a decade of experiments in incense wood, recycled newsprint and, briefly, compressed sawdust from a nearby furniture factory.</p></article>`,
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};
setTimeout(function(){var o=document.createElement('div');o.className='overlay';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.innerHTML='<div class="overlay__box"><h2>Keep reading</h2><p>You have reached your free article limit. Subscribers, please log in.</p><div class="row"><input id="pay-user" type="email" placeholder="Email" aria-label="Email"></div><div class="row"><input id="pay-pass" type="password" placeholder="Password" aria-label="Password"></div><button type="button">Log in</button><p class="muted">Not a subscriber? <a href="#">From 3 a month</a></p></div>';document.body.appendChild(o);document.getElementById('pay-user').addEventListener('input',function(e){S.username=e.target.value;});document.getElementById('pay-pass').addEventListener('input',function(e){S.password=e.target.value;});},1000);`,
  steps: [{ kind: 'signin', wait: '#pay-pass', expected: [u('#pay-user'), p('#pay-pass')] }],
});

fx({
  id: 'modal-03', category: cat, brand: 'Sable Notes', theme: 'slate', header: 'nameless', footer: 'legal',
  description: 'HTML popover attribute with popovertarget on the trigger; compact login in a popover anchored under the nav.',
  title: 'Sable Notes - notes that stay put',
  css: heroCss + `#signin-pop{border:1px solid var(--line);border-radius:8px;padding:18px;width:min(320px,90vw);background:var(--card);color:var(--fg)}`,
  main: `<section class="hero"><h1>Notes that stay put</h1><p>Plain text, tags, and a search that actually finds things.</p><button id="pop-btn" type="button" popovertarget="signin-pop">Sign in</button></section>
  <div id="signin-pop" popover><form onsubmit="return false"><label class="lbl" for="pop-u">Username</label><input id="pop-u" name="u" style="width:100%"><label class="lbl" for="pop-p" style="margin-top:8px">Password</label><input id="pop-p" name="p" type="password" style="width:100%"><p><button>Sign in</button></p></form></div>`,
  state: { username: '#pop-u', password: '#pop-p' },
  steps: [
    openerStep('#pop-btn'),
    { kind: 'signin', wait: '#signin-pop:popover-open', expected: [u('#pop-u'), p('#pop-p')] },
  ],
});

fx({
  id: 'modal-04', category: cat, brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'newsdiv',
  description: 'Modal with Sign in and Create account tabs, both panels in the DOM. Sign in is active; the hidden Create account inputs must not count and must not be filled.',
  title: 'Wrenfield Home',
  css: `.mb{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}.mb.is-open{display:flex}.mb__panel{background:var(--card);padding:24px;border-radius:8px;width:min(420px,94vw)}.tabs button{background:none;color:var(--fg);border-bottom:2px solid transparent;border-radius:0}.tabs button[aria-selected=true]{border-bottom-color:var(--accent)}[role=tabpanel][hidden]{display:none}`,
  main: `<h1>New in: linen for every room</h1><p>Stonewashed bedding and tableware, made in small runs.</p><button id="account-btn" type="button">My account</button>
  <div class="mb" id="auth-modal" role="dialog" aria-modal="true" aria-label="Your account"><div class="mb__panel"><div class="tabs" role="tablist"><button role="tab" id="tab-in" aria-selected="true" type="button">Sign in</button><button role="tab" id="tab-up" aria-selected="false" type="button">Create account</button></div>
  <form role="tabpanel" id="panel-in" onsubmit="return false"><div class="row"><label for="in-email">Email</label><input id="in-email" type="email" name="email"></div><div class="row"><label for="in-pass">Password</label><input id="in-pass" type="password" name="password"></div><button>Sign in</button></form>
  <form role="tabpanel" id="panel-up" hidden onsubmit="return false"><div class="row"><label for="up-name">Your name</label><input id="up-name" name="name"></div><div class="row"><label for="up-email">Email</label><input id="up-email" type="email" name="email"></div><div class="row"><label for="up-pass">Choose a password</label><input id="up-pass" type="password" name="password" autocomplete="new-password"></div><button>Create account</button></form></div></div>`,
  script: `document.getElementById('account-btn').addEventListener('click',function(){document.getElementById('auth-modal').classList.add('is-open');});
function tab(up){document.getElementById('panel-in').hidden=up;document.getElementById('panel-up').hidden=!up;document.getElementById('tab-in').setAttribute('aria-selected',String(!up));document.getElementById('tab-up').setAttribute('aria-selected',String(up));}
document.getElementById('tab-in').addEventListener('click',function(){tab(false);});document.getElementById('tab-up').addEventListener('click',function(){tab(true);});`,
  state: { username: '#in-email', password: '#in-pass' },
  steps: [
    openerStep('#account-btn', { honeypots: ['#up-name', '#up-email', '#up-pass'] }),
    { kind: 'signin', wait: '#auth-modal.is-open', expected: [u('#in-email'), p('#in-pass')], honeypots: ['#up-name', '#up-email', '#up-pass'] },
  ],
});

fx({
  id: 'modal-05', category: cat, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'On-page tabs defaulting to Sign up, with the Sign in panel hidden by a class; clicking the Log in tab swaps them. Each step counts only the visible panel.',
  title: 'Join Cobalt Ferret',
  css: `.tabrow{display:flex;gap:4px;margin-bottom:16px}.tabrow a{padding:.4em 1em;border:1px solid var(--line);border-radius:6px 6px 0 0;text-decoration:none}.tabrow a.on{background:var(--accent);color:#fff}.pane{display:none}.pane.on{display:block}`,
  main: `<div class="narrow box"><div class="tabrow"><a href="#up" id="t-up" class="on">Sign up</a><a href="#in" id="t-in">Log in</a></div>
  <div class="pane on" id="p-up"><h2>Create your player ID</h2><div class="row"><label for="su-email">Email</label><input id="su-email" type="email"></div><div class="row"><label for="su-pw">Password</label><input id="su-pw" type="password" autocomplete="new-password"></div><button type="button">Sign up free</button></div>
  <div class="pane" id="p-in"><h2>Welcome back</h2><div class="row"><label for="li-email">Email</label><input id="li-email" type="email" autocomplete="username"></div><div class="row"><label for="li-pw">Password</label><input id="li-pw" type="password" autocomplete="current-password"></div><button type="button">Log in</button></div></div>`,
  script: `function t(which){['up','in'].forEach(function(k){var on=k===which;document.getElementById('t-'+k).classList.toggle('on',on);document.getElementById('p-'+k).classList.toggle('on',on);});}document.getElementById('t-up').addEventListener('click',function(e){e.preventDefault();t('up');});document.getElementById('t-in').addEventListener('click',function(e){e.preventDefault();t('in');});
window.__fixture={state:function(){var v=function(i){return document.getElementById(i).value;};var inOn=document.getElementById('p-in').classList.contains('on');return {username:inOn?v('li-email'):v('su-email'),'new-password':v('su-pw'),password:v('li-pw')};}};`,
    steps: [
    { kind: 'signup', expected: [u('#su-email'), { selector: '#su-pw', role: 'new-password' }], honeypots: ['#li-email', '#li-pw'], advance: { click: '#t-in' } },
    { kind: 'signin', wait: '#p-in.on', expected: [u('#li-email'), p('#li-pw')], honeypots: ['#su-email', '#su-pw'] },
  ],
});

fx({
  id: 'modal-06', category: cat, brand: 'Ombrelle Travel', theme: 'slate', header: 'bar', footer: 'links',
  description: 'Off-canvas drawer parked with translateX(100%) off the right edge: its inputs are in the DOM and technically rendered but off-screen until the Account button slides it in.',
  title: 'Ombrelle - book a trip',
  css: `body{overflow-x:hidden}.drawer{position:fixed;top:0;right:0;bottom:0;width:min(340px,90vw);background:var(--card);padding:24px;border-left:1px solid var(--line);transform:translateX(100%);transition:transform .12s;z-index:20}.drawer.drawer--open{transform:none}`,
  main: `<h1>Where next?</h1><form onsubmit="return false" class="box" style="display:flex;gap:10px;flex-wrap:wrap"><input id="trip-from" placeholder="From" name="from"><input id="trip-to" placeholder="To" name="to"><input id="trip-date" type="date" name="depart"><button>Search trips</button></form><p><button id="drawer-btn" type="button">Account</button></p>
  <aside class="drawer" id="acct-drawer" aria-label="Account"><h2>Log in</h2><form onsubmit="return false"><div class="row"><label for="dr-u">Email</label><input id="dr-u" name="email" type="email"></div><div class="row"><label for="dr-p">Password</label><input id="dr-p" name="password" type="password"></div><button>Log in</button></form></aside>`,
  script: `document.getElementById('drawer-btn').addEventListener('click',function(){var d=document.getElementById('acct-drawer');d.addEventListener('transitionend',function(){d.setAttribute('data-settled','true');},{once:true});d.classList.add('drawer--open');});`,
  state: { username: '#dr-u', password: '#dr-p' },
  steps: [
    openerStep('#drawer-btn', { honeypots: ['#trip-from', '#trip-to', '#trip-date'] }),
    { kind: 'signin', wait: '#acct-drawer[data-settled]', expected: [u('#dr-u'), p('#dr-p')], honeypots: ['#trip-from', '#trip-to', '#trip-date'] },
  ],
});

fx({
  id: 'modal-07', category: cat, brand: 'Thistlegate Hosting', theme: 'corp', header: 'none', footer: 'links',
  description: 'Bootstrap-like dropdown in the navbar: a small login form inside a display:none dropdown-menu that toggles on click.',
  title: 'Thistlegate Hosting - plans',
  css: `.nb{display:flex;align-items:center;gap:18px;padding:12px 24px;background:var(--accent);color:#fff}.nb a{color:#fff}.dd{position:relative;margin-left:auto}.dropdown-menu{display:none;position:absolute;right:0;top:110%;background:var(--card);color:var(--fg);border:1px solid var(--line);padding:16px;width:260px;border-radius:6px}.dropdown-menu.show{display:block}`,
  chromeTop: `<nav class="nb"><b>Thistlegate</b><a href="#">Plans</a><a href="#">Domains</a><div class="dd"><button id="dd-toggle" type="button" aria-haspopup="true" aria-expanded="false">Client login</button><div class="dropdown-menu" id="dd-menu"><form onsubmit="return false"><input id="dd-user" type="text" name="client" placeholder="Email" style="width:100%;margin-bottom:8px"><input id="dd-pass" type="password" name="pw" placeholder="Password" style="width:100%;margin-bottom:8px"><button style="width:100%">Log in</button></form></div></div></nav>`,
  main: `<h1>Shared hosting from 2 a month</h1><p>Fast disks, free backups and a support team that has actually run a server.</p><table border="1" cellpadding="8" style="border-collapse:collapse"><tr><th>Plan</th><th>Sites</th><th>Price</th></tr><tr><td>Starter</td><td>1</td><td>2</td></tr><tr><td>Studio</td><td>10</td><td>7</td></tr></table>`,
  script: `document.getElementById('dd-toggle').addEventListener('click',function(){var m=document.getElementById('dd-menu');var on=m.classList.toggle('show');this.setAttribute('aria-expanded',String(on));});`,
  state: { username: '#dd-user', password: '#dd-pass' },
  steps: [
    openerStep('#dd-toggle'),
    { kind: 'signin', wait: '#dd-menu.show', expected: [u('#dd-user'), p('#dd-pass')] },
  ],
});

fx({
  id: 'modal-08', category: cat, brand: 'Pellucid Freight', theme: 'sun', header: 'nameless',
  description: 'Modal markup does not exist until the button is clicked (portal appended to body), with a cookie banner still sitting on the page underneath.',
  title: 'Pellucid Freight quotes',
  css: `.portal-root{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.5);z-index:100}.portal-card{background:var(--card);padding:26px;border-radius:6px;width:min(380px,92vw)}.cookie-bar{position:fixed;bottom:0;left:0;right:0;background:var(--fg);color:var(--bg);padding:10px 16px;z-index:10}`,
  main: `<h1>Get a freight quote in minutes</h1><p>Pallets, part loads and full trucks across the region.</p><button id="portal-open" type="button">Customer login</button>`,
  chromeBottom: `<div class="cookie-bar">This site uses cookies for session management. <button type="button">Accept</button></div>`,
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};
document.getElementById('portal-open').addEventListener('click',function(){var r=document.createElement('div');r.className='portal-root';r.innerHTML='<div class="portal-card" role="dialog" aria-labelledby="pc-title"><h2 id="pc-title">Customer login</h2><div class="row"><label>Account code<input id="pc-acct" name="account_code" style="display:block;width:100%"></label></div><div class="row"><label>Password<input id="pc-pass" name="account_password" type="password" style="display:block;width:100%"></label></div><button type="button">Log in</button></div>';document.body.appendChild(r);document.getElementById('pc-acct').addEventListener('input',function(e){S.username=e.target.value;});document.getElementById('pc-pass').addEventListener('input',function(e){S.password=e.target.value;});});`,
  steps: [
    openerStep('#portal-open'),
    { kind: 'signin', wait: '#pc-pass', expected: [u('#pc-acct'), p('#pc-pass')] },
  ],
});
