import { fx, noise } from './kit.mjs';

const cat = 'late';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

fx({
  id: 'late-01', category: cat, brand: 'Acme Roster', theme: 'slate', header: 'navbar', footer: 'links',
  description: 'Skeleton placeholder for 1.5 s, then a setTimeout swaps in the real form. Nothing to classify until then.',
  title: 'Acme Roster',
  css: `.skel{height:38px;background:var(--line);border-radius:4px;margin-bottom:12px}`,
  main: `<div class="narrow box" id="host"><div class="skel"></div><div class="skel"></div><div class="skel" style="width:40%"></div></div>${noise.status()}`,
  script: `setTimeout(function(){document.getElementById('host').innerHTML='<h1>Sign in</h1><form onsubmit="return false"><div class="row"><label for="late-u">Username</label><input id="late-u" name="username"></div><div class="row"><label for="late-p">Password</label><input id="late-p" name="password" type="password"></div><button>Sign in</button></form>';},1500);`,
  state: { username: '#late-u', password: '#late-p' },
  steps: [{ kind: 'signin', wait: '#late-p', expected: [u('#late-u'), p('#late-p')] }],
});

fx({
  id: 'late-02', category: cat, brand: 'Tidewrack Systems', theme: 'corp', header: 'bar', footer: 'legal',
  description: 'Form described by JSON from a local fetch plus 700 ms latency, with the fields rendered from that schema; ids carry a numeric suffix from the response.',
  title: 'Tidewrack',
  main: `<div class="narrow box" id="dyn"><p>Loading sign-in options&hellip;</p></div>`,
  pages: [{ path: '_data/late-02.json', raw: JSON.stringify({ heading: 'Sign in', fields: [{ id: 'fld-8841', label: 'Account', name: 'f8841', type: 'text', key: 'username' }, { id: 'fld-8842', label: 'Password', name: 'f8842', type: 'password', key: 'password' }] }) }],
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};
fetch('/fixtures/_data/late-02.json').then(function(r){return r.json();}).then(function(cfg){return new Promise(function(res){setTimeout(function(){res(cfg);},700);});}).then(function(cfg){var d=document.getElementById('dyn');d.innerHTML='';var h=document.createElement('h1');h.textContent=cfg.heading;d.appendChild(h);cfg.fields.forEach(function(f){var w=document.createElement('div');w.className='row';var l=document.createElement('label');l.htmlFor=f.id;l.textContent=f.label;var i=document.createElement('input');i.id=f.id;i.name=f.name;i.type=f.type;i.addEventListener('input',function(){S[f.key]=i.value;});w.appendChild(l);w.appendChild(i);d.appendChild(w);});var b=document.createElement('button');b.textContent='Sign in';b.type='button';d.appendChild(b);});`,
  steps: [{ kind: 'signin', wait: '#fld-8842', expected: [u('#fld-8841'), p('#fld-8842')] }],
});

fx({
  id: 'late-03', category: cat, brand: 'Bellwether Trust', theme: 'corp', header: 'utility', footer: 'table',
  description: 'Anti-autofill trick: both inputs carry readonly until they get focus, then a focus handler removes it. A filler that skips readonly fields, or writes without focusing, gets nothing.',
  title: 'Bellwether Online',
  main: `<div class="narrow box"><h1>Log in</h1><form onsubmit="return false" autocomplete="off"><div class="row"><label for="ro-u">User ID</label><input id="ro-u" name="userid" readonly onfocus="this.removeAttribute('readonly')"></div><div class="row"><label for="ro-p">Password</label><input id="ro-p" name="pwd" type="password" readonly onfocus="this.removeAttribute('readonly')"></div><button>Log in</button></form></div>${noise.phishing('Bellwether')}`,
  state: { username: '#ro-u', password: '#ro-p' },
  steps: [{ kind: 'signin', expected: [u('#ro-u'), p('#ro-p')] }],
});

fx({
  id: 'late-04', category: cat, brand: 'Northgale Telecom', theme: 'forest', header: 'utility', footer: 'links',
  description: 'Page blanks both fields 800 ms after load, resetting the app model, as a late hydration does; form gets data-hydrated when done. Anything filled before that is erased.',
  title: 'My Northgale',
  main: `<form id="ng" class="narrow box" onsubmit="return false"><h1>My Northgale</h1><div class="row"><label for="bl-u">Mobile number</label><input id="bl-u" name="msisdn"></div><div class="row"><label for="bl-p">Password</label><input id="bl-p" name="pw" type="password"></div><button>Log in</button></form>`,
  script: `var M={username:'',password:''};var a=document.getElementById('bl-u'),b=document.getElementById('bl-p');a.addEventListener('input',function(){M.username=a.value;});b.addEventListener('input',function(){M.password=b.value;});setTimeout(function(){a.value='';b.value='';M.username='';M.password='';document.getElementById('ng').setAttribute('data-hydrated','true');},800);window.__fixture={state:function(){return M;}};`,
  steps: [{ kind: 'signin', wait: '#ng[data-hydrated="true"]', expected: [u('#bl-u'), p('#bl-p')] }],
});

fx({
  id: 'late-05', category: cat, brand: 'Velvetine Cloud', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'SPA route change: starts on a marketing view; clicking Log in calls history.pushState and renders the login route without a page load.',
  title: 'Velvetine Cloud',
  main: `<div id="outlet"><section><h1>Compute that stays out of your way</h1><p>Deploy from a folder. Scale when you need to.</p><p><a href="?view=login" id="nav-login">Log in</a> &middot; <a href="#">Pricing</a></p></section></div>`,
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};
function login(){document.title='Log in - Velvetine Cloud';document.getElementById('outlet').innerHTML='<div class="narrow box"><h1>Log in</h1><div class="row"><label for="rt-u">Email</label><input id="rt-u" type="email" name="email"></div><div class="row"><label for="rt-p">Password</label><input id="rt-p" type="password" name="password"></div><button type="button">Log in</button></div>';document.getElementById('rt-u').addEventListener('input',function(e){S.username=e.target.value;});document.getElementById('rt-p').addEventListener('input',function(e){S.password=e.target.value;});}
document.getElementById('nav-login').addEventListener('click',function(e){e.preventDefault();history.pushState({view:'login'},'','?view=login');setTimeout(login,250);});`,
  steps: [
    { kind: 'none', expected: [], advance: { click: '#nav-login' } },
    { kind: 'signin', wait: '#rt-p', expected: [u('#rt-u'), p('#rt-p')] },
  ],
});

fx({
  id: 'late-06', category: cat, brand: 'Kestrel Row', theme: 'paper', header: 'bar', footer: 'news',
  description: 'Server-rendered inputs replaced after a second by client-rendered ones with the same ids; only the new elements are wired to the app. The body gets data-hydrated when finished.',
  title: 'Kestrel Row',
  main: `<div class="narrow box" id="ssr"><h1>Log in</h1><div class="row"><label for="hy-u">Email</label><input id="hy-u" name="email" type="email"></div><div class="row"><label for="hy-p">Password</label><input id="hy-p" name="password" type="password"></div><button type="button">Log in</button></div>`,
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};setTimeout(function(){['hy-u','hy-p'].forEach(function(id){var old=document.getElementById(id);var n=old.cloneNode(false);n.value='';n.addEventListener('input',function(){S[id==='hy-u'?'username':'password']=n.value;});old.replaceWith(n);});document.body.setAttribute('data-hydrated','true');},1000);`,
  steps: [{ kind: 'signin', wait: 'body[data-hydrated="true"]', expected: [u('#hy-u'), p('#hy-p')] }],
});

fx({
  id: 'late-07', category: cat, brand: 'Palewing', theme: 'grape', header: 'navbar', footer: 'links',
  description: 'Route guard redirect with no click: an auth check takes 900 ms, then pushState moves to the login route and the home view is swapped for the form.',
  title: 'Palewing dashboard',
  main: `<div id="rv" class="narrow box"><p>Checking your session&hellip;</p></div>`,
  script: `var S={username:'',password:''};window.__fixture={state:function(){return S;}};setTimeout(function(){history.pushState({},'','?next=dashboard&view=signin');var v=document.getElementById('rv');v.innerHTML='<h1>Please sign in</h1><form onsubmit="return false"><div class="row"><label for="gd-u">Email</label><input id="gd-u" type="email"></div><div class="row"><label for="gd-p">Password</label><input id="gd-p" type="password"></div><button>Sign in</button></form>';document.getElementById('gd-u').addEventListener('input',function(e){S.username=e.target.value;});document.getElementById('gd-p').addEventListener('input',function(e){S.password=e.target.value;});},900);`,
  steps: [{ kind: 'signin', wait: '#gd-p', expected: [u('#gd-u'), p('#gd-p')] }],
});
