import { fx, noise } from './kit.mjs';

const cat = 'signin';
const u = (selector) => ({ selector, role: 'username' });
const p = (selector) => ({ selector, role: 'password' });

fx({
  id: 'signin-classic-01', category: cat, brand: 'Acme Parcel', theme: 'slate', header: 'bar', footer: 'news',
  description: 'Textbook sign-in: labels by for, Remember me, Forgot password, header search and footer newsletter as noise.',
  title: 'Sign in - Acme Parcel',
  main: `<div class="split"><div class="box">
  <h1>Sign in to track your parcels</h1>
  <form id="login-form" action="#session" method="post" onsubmit="return false">
    <div class="row"><label for="user">Username</label><input id="user" name="username" type="text" autocomplete="username"></div>
    <div class="row"><label for="pass">Password</label><input id="pass" name="password" type="password" autocomplete="current-password"></div>
    <div class="row"><label style="font-weight:400"><input type="checkbox" name="remember"> Remember me on this computer</label></div>
    <button type="submit">Sign in</button> <a href="#forgot" style="margin-left:12px">Forgot your password?</a>
  </form></div>
  <div>${noise.features('Acme Parcel')}${noise.status()}</div></div>`,
  state: { username: '#user', password: '#pass' },
  steps: [{ kind: 'signin', expected: [u('#user'), p('#pass')] }],
});

fx({
  id: 'signin-classic-02', category: cat, brand: 'Dunmarrow County Library', theme: 'retro', header: 'table', footer: 'table',
  description: 'Old table layout with bgcolor attributes, text labels in a sibling cell (no label element), names uid and pwd, no ids.',
  title: 'Patron Login',
  css: `.loginbox td{padding:4px 8px}.loginbox{margin:30px auto;border:2px outset #bbb;background:var(--card)}`,
  main: `<center><h2>Patron Account Access</h2></center>
<form name="frmLogin" method="post" action="#patron" onsubmit="return false">
<table class="loginbox" border="0" cellpadding="2" cellspacing="0" align="center">
  <tr bgcolor="#ccccdd"><td colspan="2"><b>Please log in</b></td></tr>
  <tr><td align="right"><font size="2">Library card no:</font></td><td><input type="text" name="uid" size="20" maxlength="32"></td></tr>
  <tr><td align="right"><font size="2">PIN / Password:</font></td><td><input type="password" name="pwd" size="20" maxlength="32"></td></tr>
  <tr><td></td><td><input type="submit" value="Login"> <input type="reset" value="Clear"></td></tr>
  <tr><td colspan="2"><font size="1"><a href="#help">Forgot your PIN?</a> Ask at the circulation desk.</font></td></tr>
</table></form>
<p align="center"><font size="2">Opening hours: Mon-Fri 9-6, Sat 10-2. The reading room is closed for repainting until May.</font></p>`,
  state: { username: 'input[name="uid"]', password: 'input[name="pwd"]' },
  steps: [{ kind: 'signin', expected: [u('input[name="uid"]'), p('input[name="pwd"]')] }],
});

fx({
  id: 'signin-classic-03', category: cat, brand: 'Quillfin', theme: 'grape', header: 'navbar', footer: 'links',
  description: 'No form element at all: BEM divs, placeholder-only inputs, submit is a div with role=button handled in JS.',
  title: 'Welcome back | Quillfin',
  css: `.auth-card{max-width:400px;margin:40px auto;padding:32px;background:var(--card);border-radius:14px;box-shadow:0 4px 30px rgba(0,0,0,.08)}.auth-card__input{display:block;width:100%;margin-bottom:12px;padding:.8em}.auth-card__submit{background:var(--accent);color:#fff;text-align:center;padding:.8em;border-radius:6px;cursor:pointer}`,
  main: `<div class="auth-card"><div class="auth-card__title"><h1>Welcome back</h1></div>
  <div class="auth-card__field"><input class="auth-card__input auth-card__input--id" id="identity" placeholder="Email address" type="email"></div>
  <div class="auth-card__field"><input class="auth-card__input auth-card__input--secret" id="secret" placeholder="Password" type="password"></div>
  <div class="auth-card__submit" role="button" tabindex="0" id="go">Continue</div>
  <div class="auth-card__foot muted" style="margin-top:14px"><a href="#reset">Trouble signing in?</a> New here? <a href="#signup">Create a free workspace</a></div></div>`,
  state: { username: '#identity', password: '#secret' },
  steps: [{ kind: 'signin', expected: [u('#identity'), p('#secret')] }],
});

fx({
  id: 'signin-classic-04', category: cat, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal',
  description: 'Framework-style generated ids (input-17, input-21) with floating labels tied by for; no name attributes; autocomplete=off.',
  title: 'Tarnhold Console',
  css: `.v-field{position:relative;margin:0 0 18px}.v-field input{width:100%;padding:1.3em .8em .4em;background:transparent}.v-field label{position:absolute;left:.8em;top:.25em;font-size:.72em;color:var(--soft)}`,
  main: `<div class="narrow box" data-v-3fa1c2>
  <h1>Console sign in</h1>
  <form novalidate autocomplete="off" onsubmit="return false" class="v-form">
    <div class="v-field v-field--active"><label for="input-17" class="v-label">Account</label><input id="input-17" type="text" autocomplete="off" aria-describedby="input-17-messages" size="1"><div id="input-17-messages" class="v-messages"></div></div>
    <div class="v-field"><label for="input-21" class="v-label">Secret</label><input id="input-21" type="password" autocomplete="off" aria-describedby="input-21-messages" size="1"><div id="input-21-messages" class="v-messages"></div></div>
    <button class="v-btn v-btn--block" type="submit">Log in</button>
  </form>
  <p class="muted">Region: eu-north. <a href="#">Switch region</a></p></div>`,
  state: { username: '#input-17', password: '#input-21' },
  steps: [{ kind: 'signin', expected: [u('#input-17'), p('#input-21')] }],
});

fx({
  id: 'signin-classic-05', category: cat, brand: 'Mossgrove Outfitters', theme: 'forest', header: 'shop', footer: 'newsdiv',
  description: 'Wrapping labels with the input inside them, email type, no ids; store page with product search and footer email capture.',
  title: 'Your Mossgrove account',
  css: `label.f{display:block;margin-bottom:14px;font-weight:600}label.f input{display:block;width:100%;font-weight:400;margin-top:4px}`,
  main: `<div class="split"><form class="box" action="#account" onsubmit="return false">
    <h1>My account</h1>
    <label class="f f-email">Email address <input type="email" name="email"></label>
    <label class="f f-pass">Password <input type="password" name="passwd"></label>
    <button>Log in</button> <a href="#lost" class="muted">Lost your password?</a></form>
  <div><h2>Summer kit is in</h2><p>Waxed jackets, canvas packs and boots that outlast you. Members get free returns and early access to the autumn drop.</p>${noise.quote('Mossgrove')}</div></div>`,
  state: { username: 'label.f-email input', password: 'label.f-pass input' },
  steps: [{ kind: 'signin', expected: [u('label.f-email input'), p('label.f-pass input')] }],
});

fx({
  id: 'signin-classic-06', category: cat, brand: 'Brindlewood Credit Union', theme: 'corp', header: 'utility', footer: 'table',
  description: 'aria-labelledby labels on spans, opaque names f8 and f9, banking wording: Member number and Passcode.',
  title: 'Online Banking | Brindlewood',
  main: `<section class="narrow box" aria-labelledby="ob-head">
  <h1 id="ob-head">Online banking</h1>
  <form method="post" action="#ob" onsubmit="return false">
    <div class="row"><span id="lbl-8" class="lbl">Member number</span><input aria-labelledby="lbl-8" id="f8" name="f8" type="text" inputmode="numeric"></div>
    <div class="row"><span id="lbl-9" class="lbl">Passcode</span><input aria-labelledby="lbl-9" id="f9" name="f9" type="password"></div>
    <button type="submit">Log on</button>
    <p class="muted"><a href="#">Reset passcode</a> | <a href="#">Register for online banking</a></p>
  </form></section>
  ${noise.phishing('Brindlewood')}
  <p>Rates: 12-month term deposit 4.10% p.a. Home loans from 5.89% p.a. Conditions apply.</p>`,
  state: { username: '#f8', password: '#f9' },
  steps: [{ kind: 'signin', expected: [u('#f8'), p('#f9')] }],
});

fx({
  id: 'signin-classic-07', category: cat, brand: 'Pellucid Freight', theme: 'sun', header: 'nameless', footer: 'legal',
  description: 'Placeholder-only inputs with no name, no id and no autocomplete; selected purely by position and type.',
  title: 'Customer portal',
  css: `.login input{display:block;width:100%;margin-bottom:10px}`,
  main: `<div class="narrow login box"><h2>Customer portal</h2>
  <form onsubmit="return false"><input type="text" placeholder="Login"><input type="password" placeholder="Password"><button>OK</button></form>
  <p class="muted">Need a quote instead? Call the depot on 0800 000 000.</p></div>`,
  state: { username: '.login input[type=text]', password: '.login input[type=password]' },
  steps: [{ kind: 'signin', expected: [u('.login input[type=text]'), p('.login input[type=password]')] }],
});

fx({
  id: 'signin-classic-08', category: cat, brand: 'Larkspur & Vane', theme: 'paper', header: 'minimal', footer: 'lang',
  description: 'Icon-only: inline SVG user and lock glyphs, no text label or placeholder at all; servlet-style names j_username and j_password.',
  title: 'Partner login',
  css: `.icn{display:flex;align-items:center;gap:8px;margin-bottom:12px}.icn svg{width:20px;height:20px;flex:none}.icn input{flex:1;min-width:0}`,
  main: `<div class="narrow box"><form action="#j_security_check" method="post" onsubmit="return false">
    <div class="icn"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6" r="4" fill="currentColor"/><path d="M2 19c1-5 15-5 16 0" fill="currentColor"/></svg><input type="text" name="j_username" class="ico-field"></div>
    <div class="icn"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="9" width="14" height="10" rx="2" fill="currentColor"/><path d="M6 9V6a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><input type="password" name="j_password" class="ico-field"></div>
    <button type="submit" aria-label="Log in">&rarr;</button></form></div>`,
  state: { username: 'input[name="j_username"]', password: 'input[name="j_password"]' },
  steps: [{ kind: 'signin', expected: [u('input[name="j_username"]'), p('input[name="j_password"]')] }],
});

fx({
  id: 'signin-classic-09', category: cat, brand: 'Ombrelle Travel', theme: 'slate', header: 'bar', footer: 'applink',
  description: 'Show-password toggle swaps the input between password and text; footer asks for a phone number to text an app link.',
  title: 'Log in to Ombrelle',
  css: `.pw-wrap{position:relative}.pw-wrap input{width:100%;padding-right:64px}.pw-toggle{position:absolute;right:4px;top:4px;background:none;color:var(--accent);padding:.2em .5em}`,
  main: `<div class="split"><div class="box"><h1>Log in</h1><form onsubmit="return false" id="ombrelle-login">
    <div class="row"><label for="ol-email">Email or booking reference</label><input id="ol-email" name="login" type="text" autocomplete="username"></div>
    <div class="row"><label for="ol-pass">Password</label><div class="pw-wrap"><input id="ol-pass" name="password" type="password" autocomplete="current-password"><button type="button" class="pw-toggle" id="pw-toggle" aria-pressed="false">Show</button></div></div>
    <button type="submit">Log in</button></form></div>
    <div><h2>Long weekends from 49</h2><p>Fly somewhere you cannot pronounce. Points on every booking and free changes up to a day before departure.</p></div></div>`,
  script: `document.getElementById('pw-toggle').addEventListener('click',function(){var i=document.getElementById('ol-pass');var show=i.type==='password';i.type=show?'text':'password';this.textContent=show?'Hide':'Show';this.setAttribute('aria-pressed',String(show));});`,
  state: { username: '#ol-email', password: '#ol-pass' },
  steps: [{ kind: 'signin', expected: [u('#ol-email'), p('#ol-pass')] }],
});

fx({
  id: 'signin-classic-10', category: cat, brand: 'Thistlegate Hosting', theme: 'corp', header: 'nameless', footer: 'links',
  description: 'Password input is type=text with name secret until it gets focus, then the page script flips it to type=password.',
  title: 'Client area',
  main: `<div class="narrow box"><h1>Client area</h1><form onsubmit="return false" name="clientlogin">
    <div class="row"><label for="cl-u">Client email</label><input id="cl-u" type="text" name="clientemail"></div>
    <div class="row"><label for="cl-p">Password</label><input id="cl-p" type="text" name="secret" placeholder="Password" onfocus="this.type='password'"></div>
    <button type="submit">Enter</button></form>
    <p class="muted">Domain renewals are due 30 days before expiry. <a href="#">View invoices</a> after you log in.</p></div>`,
  state: { username: '#cl-u', password: '#cl-p' },
  steps: [{ kind: 'signin', expected: [u('#cl-u'), p('#cl-p')] }],
});

fx({
  id: 'signin-classic-11', category: cat, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'CSS-in-JS hashed classes, wrapper soup, data-testid attributes the only stable hook; autocomplete absent.',
  title: 'Cobalt Ferret ID',
  css: `.css-1x2y3z{max-width:380px;margin:48px auto}.css-9qq1a{margin-bottom:16px}.css-77ha2{width:100%}.css-p0p0k{width:100%;margin-top:6px}`,
  main: `<div class="css-1x2y3z"><div class="css-0"><div class="css-j4x"><h1 class="css-hd">Play on</h1></div>
  <div class="css-9qq1a"><div class="css-w"><div class="css-lbl" id="css-a1">Player name or email</div><div class="css-in"><input class="css-77ha2" data-testid="username-input" aria-labelledby="css-a1" type="text"></div></div></div>
  <div class="css-9qq1a"><div class="css-w"><div class="css-lbl" id="css-a2">Password</div><div class="css-in"><input class="css-77ha2" data-testid="password-input" aria-labelledby="css-a2" type="password"></div></div></div>
  <button class="css-p0p0k" data-testid="login-submit" type="button">Log in</button></div></div>`,
  state: { username: '[data-testid="username-input"]', password: '[data-testid="password-input"]' },
  steps: [{ kind: 'signin', expected: [u('[data-testid="username-input"]'), p('[data-testid="password-input"]')] }],
});

fx({
  id: 'signin-classic-12', category: cat, brand: 'Harrowgate Mutual', theme: 'corp',
  description: 'WebForms pattern: one form wraps the whole page, so search, login and newsletter share it; ctl00-prefixed ids and names, __VIEWSTATE hidden.',
  title: 'Member Services Login',
  bare: true,
  main: `<form name="aspnetForm" method="post" action="#Login.aspx" id="aspnetForm" onsubmit="return false">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="c3RhdGljLXZpZXdzdGF0ZS1wbGFjZWhvbGRlcg==">
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ZXZlbnQtcGxhY2Vob2xkZXI=">
<div id="ctl00_pnlHeader" style="padding:10px 18px;background:var(--accent);color:#fff"><b>Harrowgate Mutual</b>
  <span style="float:right">Search: <input name="ctl00$txtSearch" type="text" id="ctl00_txtSearch" style="color:#000;background:#fff"> <input type="submit" name="ctl00$btnSearch" value="Go" id="ctl00_btnSearch"></span></div>
<div class="wrap"><div id="ctl00_MainContent_pnlLogin" class="narrow box"><h2>Member Services</h2>
  <div class="row"><label for="ctl00_MainContent_txtUserName">User Name:</label><input name="ctl00$MainContent$txtUserName" type="text" id="ctl00_MainContent_txtUserName"></div>
  <div class="row"><label for="ctl00_MainContent_txtPassword">Password:</label><input name="ctl00$MainContent$txtPassword" type="password" id="ctl00_MainContent_txtPassword"></div>
  <div class="row"><input id="ctl00_MainContent_chkRemember" type="checkbox" name="ctl00$MainContent$chkRemember"><label for="ctl00_MainContent_chkRemember" style="display:inline;font-weight:400"> Keep me logged in</label></div>
  <input type="submit" name="ctl00$MainContent$btnLogin" value="Log In" id="ctl00_MainContent_btnLogin">
  <p class="muted"><a id="ctl00_MainContent_lnkForgot" href="#">Forgot your password?</a></p></div></div>
<div id="ctl00_pnlFooter" style="padding:14px 18px;border-top:1px solid var(--line)">Quarterly newsletter: <input name="ctl00$txtNewsEmail" type="text" id="ctl00_txtNewsEmail"> <input type="submit" name="ctl00$btnNews" value="Join"></div>
</form>`,
  state: { username: '#ctl00_MainContent_txtUserName', password: '#ctl00_MainContent_txtPassword' },
  steps: [{ kind: 'signin', expected: [u('#ctl00_MainContent_txtUserName'), p('#ctl00_MainContent_txtPassword')], honeypots: ['#ctl00_txtSearch', '#ctl00_txtNewsEmail'] }],
});

fx({
  id: 'signin-classic-13', category: cat, brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'news',
  description: 'Checkout crossroads: Returning customer login beside a Guest checkout form asking only for an email, which must not be filled.',
  title: 'Checkout - Wrenfield Home',
  main: `<h1>Checkout</h1><div class="split">
  <form class="box" id="returning" onsubmit="return false"><h2>Returning customers</h2>
    <div class="row"><label for="ret-email">Email</label><input id="ret-email" name="customer[email]" type="email"></div>
    <div class="row"><label for="ret-pass">Password</label><input id="ret-pass" name="customer[password]" type="password"></div>
    <button>Sign in and check out</button></form>
  <form class="box" id="guest" onsubmit="return false"><h2>New here?</h2><p>No account needed. We just need somewhere to send your receipt.</p>
    <div class="row"><label for="guest-email">Email for your receipt</label><input id="guest-email" name="guest_email" type="email"></div>
    <button>Continue as guest</button></form></div>
  <p class="muted">Your cart: 1 &times; ceramic planter, 1 &times; linen throw. Subtotal 86.00.</p>`,
  state: { username: '#ret-email', password: '#ret-pass' },
  steps: [{ kind: 'signin', expected: [u('#ret-email'), p('#ret-pass')], honeypots: ['#guest-email'] }],
});

fx({
  id: 'signin-classic-14', category: cat, brand: 'Stonebarrow Council Services', theme: 'forest', header: 'utility', footer: 'links',
  description: 'Definition list with fieldset and legend; Employee ID wording; bracketed names login[username] and login[password].',
  title: 'Staff intranet',
  css: `dl.frm dt{font-weight:600;margin-top:10px}dl.frm dd{margin:2px 0 0}dl.frm input{width:100%}fieldset{border:1px solid var(--line);border-radius:6px;padding:16px}`,
  main: `<div class="narrow"><form action="#intranet" method="post" onsubmit="return false"><fieldset><legend>Staff sign-in</legend>
  <dl class="frm"><dt><label for="login_username">Employee ID</label></dt><dd><input id="login_username" name="login[username]" type="text"></dd>
  <dt><label for="login_password">Network password</label></dt><dd><input id="login_password" name="login[password]" type="password"></dd></dl>
  <p><button type="submit">Sign in</button></p></fieldset></form>
  <p class="muted">Bin collection changes over the holidays are listed on the public site. IT desk extension 4400.</p></div>`,
  state: { username: '#login_username', password: '#login_password' },
  steps: [{ kind: 'signin', expected: [u('#login_username'), p('#login_password')] }],
});

fx({
  id: 'signin-classic-15', category: cat, brand: 'Sable Notes', theme: 'slate', header: 'navbar', footer: 'lang',
  description: 'Bootstrap-like floating labels placed after the input, plus several Continue-with SSO buttons and a divider; session[email] style names.',
  title: 'Sign in to Sable Notes',
  css: `.form-floating{position:relative;margin-bottom:12px}.form-floating input{width:100%;padding:1.5em .75em .5em}.form-floating label{position:absolute;top:.3em;left:.8em;font-size:.75em;color:var(--soft)}.sso button{display:block;width:100%;margin-bottom:8px;background:var(--card);color:var(--fg);border:1px solid var(--line)}.or{text-align:center;color:var(--soft);margin:14px 0}`,
  main: `<div class="narrow box"><h1>Sign in</h1><div class="sso"><button type="button">Continue with work SSO</button><button type="button">Continue with a passkey</button></div><div class="or">or</div>
  <form onsubmit="return false"><div class="form-floating"><input class="form-control" id="floatingInput" name="session[email]" type="email" placeholder="name@example.test"><label for="floatingInput">Email address</label></div>
  <div class="form-floating"><input class="form-control" id="floatingPassword" name="session[password]" type="password" placeholder="Password"><label for="floatingPassword">Password</label></div>
  <button class="w-100" type="submit" style="width:100%">Sign in</button></form></div>`,
  state: { username: '#floatingInput', password: '#floatingPassword' },
  steps: [{ kind: 'signin', expected: [u('#floatingInput'), p('#floatingPassword')] }],
});

fx({
  id: 'signin-classic-16', category: cat, brand: 'Ferncastle Forums', theme: 'retro', footer: 'legal',
  description: 'Forum-style inline login squeezed into the page header on a long discussion page; quick reply box and thread search as noise.',
  title: 'Ferncastle Forums - Bread baking',
  chromeTop: `<div style="background:var(--accent);color:#fff;padding:6px 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center"><b style="margin-right:auto">Ferncastle Forums</b>
  <form id="navbar_loginform" onsubmit="return false" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
    <span>User Name</span><input type="text" name="vb_login_username" id="navbar_username" size="10" style="color:#000;background:#fff">
    <span>Password</span><input type="password" name="vb_login_password" id="navbar_password" size="10" style="color:#000;background:#fff">
    <label><input type="checkbox" name="cookieuser"> Remember</label><input type="submit" value="Log in"></form></div>`,
  main: `<h1>Thread: My sourdough will not rise</h1><p><input type="text" id="thread-search" name="threadq" placeholder="Search this thread"> <button type="button">Find</button></p>
  <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr><td width="130"><b>crumb_lord</b><br><small>Posts: 4,102</small></td><td>Have you tried feeding it twice a day for a week before baking? Mine perked right up.</td></tr><tr><td><b>mabel_k</b><br><small>Posts: 87</small></td><td>Water temperature made all the difference for me. Also keep it away from the draught.</td></tr></table>
  <h3>Quick reply</h3><textarea name="message" id="quick-reply" rows="4" style="width:100%" placeholder="Log in to reply"></textarea>`,
  state: { username: '#navbar_username', password: '#navbar_password' },
  steps: [{ kind: 'signin', expected: [u('#navbar_username'), p('#navbar_password')], honeypots: ['#thread-search', '#quick-reply'] }],
});

fx({
  id: 'signin-classic-17', category: cat, brand: 'Dappermint Pay', theme: 'grape', header: 'minimal', footer: 'news',
  description: 'Phone number is the login: type=tel with a country code select next to it, then a password. Role is still username.',
  title: 'Log in with your mobile number',
  css: `.tel-row{display:flex;gap:6px}.tel-row input{flex:1;min-width:0}`,
  main: `<div class="narrow box"><h1>Welcome back</h1><form onsubmit="return false">
    <div class="row"><label for="msisdn">Mobile number</label><div class="tel-row"><select aria-label="Country code" name="cc"><option>+61</option><option>+64</option><option>+65</option></select><input id="msisdn" name="msisdn" type="tel" inputmode="tel"></div></div>
    <div class="row"><label for="login-pw">Password</label><input id="login-pw" name="pw" type="password"></div>
    <button>Log in</button></form></div>`,
  state: { username: '#msisdn', password: '#login-pw' },
  steps: [{ kind: 'signin', expected: [u('#msisdn'), p('#login-pw')] }],
});
