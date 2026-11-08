// Ordinary sign-in pages in many styles.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-signin-01',
    category: 'signin',
    description: 'Shop account page in a utility CSS framework: labelled email and password with autocomplete hints, header product search and a footer discount sign-up.',
    steps: [step('signin', [x('#loginEmail', 'username'), x('#loginPassword', 'password')], ['#q', '#nl-email'])],
    html: doc({
      title: 'Account – Tallow & Wick',
      css: `
body{margin:0;font:15px/1.5 Georgia,serif;background:#fbf7f2;color:#2b211a}
.topbar{display:flex;gap:24px;align-items:center;padding:12px 32px;background:#2b211a;color:#fbf7f2}
.topbar a{color:inherit;text-decoration:none}.logo{font-size:22px;font-style:italic}
.search{flex:1;display:flex}.search input{flex:1;padding:6px 10px;border:0;border-radius:3px 0 0 3px}
.search button{border:0;background:#c9a27e;padding:6px 12px;border-radius:0 3px 3px 0}
.container{max-width:420px;margin:48px auto}.card{background:#fff;border:1px solid #e6dccf;padding:28px 32px;border-radius:6px}
.mb-3{margin-bottom:16px}.form-label{display:block;margin-bottom:4px;font-size:14px}
.form-control{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cdbfae;border-radius:4px;font:inherit}
.btn{display:block;width:100%;margin-top:18px;padding:10px;background:#2b211a;color:#fff;border:0;border-radius:4px;font:inherit}
footer{margin-top:64px;padding:28px 32px;background:#efe6da;display:flex;justify-content:space-between}
.nl input{padding:7px;border:1px solid #cdbfae;width:220px}`,
      body: `
<header class="topbar">
  <a class="logo" href="#">Tallow &amp; Wick</a>
  <form class="search" role="search" action="#" onsubmit="return false">
    <input type="search" id="q" name="q" placeholder="Search candles, diffusers, gift sets" aria-label="Search the shop">
    <button type="submit">Search</button>
  </form>
  <nav><a href="#">Shop</a> &nbsp; <a href="#">Gifts</a> &nbsp; <a href="#">Cart (0)</a></nav>
</header>
<main class="container">
  <div class="card">
    <h1>Sign in</h1>
    <form id="customer_login" method="post" action="#" accept-charset="UTF-8" onsubmit="event.preventDefault()">
      <div class="mb-3">
        <label for="loginEmail" class="form-label">Email address</label>
        <input type="email" class="form-control" id="loginEmail" name="customer[email]" autocomplete="email" autocapitalize="off" required>
      </div>
      <div class="mb-3">
        <label for="loginPassword" class="form-label">Password</label>
        <input type="password" class="form-control" id="loginPassword" name="customer[password]" autocomplete="current-password" required>
      </div>
      <a href="#recover">Forgot your password?</a>
      <button type="submit" class="btn">Sign in</button>
    </form>
    <p>New customer? <a href="#register">Create an account</a></p>
  </div>
</main>
<footer>
  <div>&copy; Tallow &amp; Wick Candle Co.<br>Hand poured in small batches.</div>
  <form class="nl" action="#" onsubmit="return false">
    <label for="nl-email">Get 10% off your first order</label><br>
    <input type="email" id="nl-email" name="contact[email]" placeholder="Your email">
    <button type="submit">Join</button>
  </form>
</footer>`,
      js: fxLive({ username: '#loginEmail', password: '#loginPassword' }),
    }),
  },

  {
    id: 'h4-signin-02',
    category: 'signin',
    description: 'Single-page app with no form element: two inputs named only by aria-label, no ids or names, a div acting as the button.',
    steps: [step('signin', [x('.auth-box input[aria-label="Work email"]', 'username'), x('.auth-box input[aria-label="Password"]', 'password')])],
    html: doc({
      title: 'Kestrel Analytics',
      css: `
body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#0f2027,#2c5364);font:14px system-ui,sans-serif}
.auth-box{width:340px;background:#fff;border-radius:10px;padding:32px;box-shadow:0 20px 40px rgba(0,0,0,.3)}
.auth-box h2{margin:0 0 4px}.sub{color:#667;margin:0 0 24px}
.auth-box input{display:block;width:100%;box-sizing:border-box;margin-bottom:14px;padding:11px 12px;border:1px solid #ccd;border-radius:6px;font-size:14px}
.go{background:#2c5364;color:#fff;text-align:center;padding:11px;border-radius:6px;cursor:pointer;user-select:none}
.msg{min-height:18px;color:#2c5364;margin-top:10px;font-size:13px}`,
      body: `
<div id="app">
  <div class="auth-box">
    <h2>Kestrel</h2>
    <p class="sub">Sign in to your workspace</p>
    <input type="email" aria-label="Work email" placeholder="name@company.com">
    <input type="password" aria-label="Password" placeholder="••••••••">
    <div class="go" role="button" tabindex="0">Continue</div>
    <div class="msg" aria-live="polite"></div>
  </div>
</div>`,
      js: `
document.querySelector('.go').addEventListener('click', function () {
  document.querySelector('.msg').textContent = 'Checking your details...';
});
${fxLive({ username: '.auth-box input[aria-label="Work email"]', password: '.auth-box input[aria-label="Password"]' })}`,
    }),
  },

  {
    id: 'h4-signin-03',
    category: 'signin',
    description: 'Social site log-in with placeholder-only fields ("Phone, email or username"), bracketed field names and a language picker in the footer.',
    steps: [step('signin', [x('input[name="session[username_or_email]"]', 'username'), x('input[name="session[password]"]', 'password')], ['#lang'])],
    html: doc({
      title: 'Log in to Chirpline',
      css: `
body{margin:0;font:15px system-ui,Segoe UI,sans-serif;background:#fff;color:#0f1419}
.wrap{max-width:360px;margin:60px auto;text-align:left}
.bird{width:40px;height:40px;border-radius:50%;background:#1d9bf0;margin-bottom:24px}
h1{font-size:30px;margin:0 0 28px}
.in{display:block;width:100%;box-sizing:border-box;padding:16px 10px;margin-bottom:18px;border:1px solid #cfd9de;border-radius:4px;font-size:17px}
.btn{width:100%;padding:12px;border-radius:999px;border:0;background:#0f1419;color:#fff;font-weight:700;font-size:15px}
.links{display:flex;justify-content:space-between;margin-top:20px;font-size:14px}
.links a{color:#1d9bf0;text-decoration:none}
footer{text-align:center;color:#536471;font-size:13px;margin-top:80px}`,
      body: `
<div class="wrap">
  <div class="bird" aria-hidden="true"></div>
  <h1>Log in to Chirpline</h1>
  <form action="#" method="post" onsubmit="event.preventDefault()">
    <input class="in" type="text" name="session[username_or_email]" autocapitalize="none" autocorrect="off" placeholder="Phone, email or username">
    <input class="in" type="password" name="session[password]" placeholder="Password">
    <input type="hidden" name="authenticity_token" value="b1e9f04ac2d7">
    <button class="btn" type="submit">Log in</button>
  </form>
  <div class="links"><a href="#">Forgot password?</a><a href="#">Sign up for Chirpline</a></div>
</div>
<footer>
  <a href="#">About</a> · <a href="#">Help</a> · <a href="#">Terms</a> ·
  <select id="lang" aria-label="Language"><option>English</option><option>Español</option><option>Français</option></select>
</footer>`,
      js: fxLive({ username: 'input[name="session[username_or_email]"]', password: 'input[name="session[password]"]' }),
    }),
  },

  {
    id: 'h4-signin-04',
    category: 'signin',
    description: 'Old forum header bar: table layout, the username box shows "User Name" as its value until focused, remember-me tick, and a forum search box in the sidebar.',
    steps: [step('signin', [x('#navbar_username', 'username'), x('#navbar_password', 'password')], ['#forum-search'])],
    html: doc({
      title: 'Lowgear Motorcycle Forums - Powered by BoardKit',
      css: `
body{margin:0;font:12px Verdana,Arial,sans-serif;background:#d8dde6}
.page{width:960px;margin:0 auto;background:#fff;border:1px solid #889}
.hdr{background:#33476a;color:#fff;padding:10px}
.hdr table td{font-size:11px;color:#fff;padding:1px 3px}
.hdr input.bginput{font-size:11px;width:120px}
.cols{display:flex}.side{width:200px;padding:8px;border-right:1px solid #ccd}.main{flex:1;padding:8px}
.thead{background:#738fbf;color:#fff;font-weight:bold;padding:4px}
.alt1{background:#f5f5ff;padding:4px;border-bottom:1px solid #dde}`,
      body: `
<div class="page">
  <div class="hdr">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><b style="font-size:18px">Lowgear Forums</b></td>
      <td align="right">
        <form action="#" method="post" onsubmit="return false">
          <table cellpadding="0" cellspacing="3" border="0">
            <tr>
              <td>User Name</td>
              <td><input type="text" class="bginput" name="fk_username" id="navbar_username" size="10" accesskey="u" tabindex="101" value="User Name" onfocus="if (this.value == 'User Name') this.value = '';"></td>
              <td><label><input type="checkbox" name="cookieuser" value="1" tabindex="103" id="cb_cookieuser_navbar">Remember Me?</label></td>
            </tr>
            <tr>
              <td>Password</td>
              <td><input type="password" class="bginput" name="fk_password" id="navbar_password" size="10" tabindex="102"></td>
              <td><input type="submit" class="button" value="Log in" tabindex="104" accesskey="s"></td>
            </tr>
          </table>
          <input type="hidden" name="do" value="login">
        </form>
      </td>
    </tr></table>
  </div>
  <div class="cols">
    <div class="side">
      <div class="thead">Search Forums</div>
      <form action="#" onsubmit="return false"><input type="text" id="forum-search" name="query" size="18"> <input type="submit" value="Go"></form>
      <div class="thead" style="margin-top:8px">Who's Online</div><div class="alt1">212 members and 1,044 guests</div>
    </div>
    <div class="main">
      <div class="thead">Forum</div>
      <div class="alt1"><b>Touring &amp; Long Distance</b><br>Routes, luggage and saddle sores.</div>
      <div class="alt1"><b>Workshop</b><br>Valve clearances, chain care and the dreaded wiring loom.</div>
      <div class="alt1"><b>Classifieds</b><br>Bikes and parts for sale.</div>
    </div>
  </div>
</div>`,
      js: fxLive({ username: 'js:(function(){var v=document.getElementById("navbar_username").value;return v==="User Name"?"":v;})()', password: '#navbar_password' }),
    }),
  },

  {
    id: 'h4-signin-05',
    category: 'signin',
    description: 'Checkout gate with "Returning customer" log-in beside a "New customer" guest-checkout email box, plus a header search.',
    steps: [step('signin', [x('#rc-email', 'username'), x('#rc-password', 'password')], ['#hdr-search', '#guest-email'])],
    html: doc({
      title: 'Checkout – Brightloom Yarns',
      css: `
body{margin:0;font:15px/1.45 "Trebuchet MS",sans-serif;color:#333}
header{display:flex;justify-content:space-between;padding:14px 40px;border-bottom:3px solid #e07a5f}
header input{padding:6px;width:260px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:40px;max-width:900px;margin:40px auto}
.box{border:1px solid #ddd;padding:24px}.box h2{margin-top:0;color:#e07a5f}
.row{margin-bottom:14px}.row label{display:block;font-weight:bold;font-size:13px}
.row input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb}
button{background:#3d405b;color:#fff;border:0;padding:10px 18px}`,
      body: `
<header><strong>Brightloom Yarns</strong><input type="search" id="hdr-search" placeholder="Search yarn, patterns, needles"></header>
<div class="cols">
  <section class="box">
    <h2>Returning customer</h2>
    <form id="login-form" action="#" onsubmit="return false">
      <div class="row"><label for="rc-email">E-mail</label><input id="rc-email" name="login[username]" type="email" autocomplete="username"></div>
      <div class="row"><label for="rc-password">Password</label><input id="rc-password" name="login[password]" type="password" autocomplete="current-password"></div>
      <button>Sign in and continue</button> <a href="#">Lost your password?</a>
    </form>
  </section>
  <section class="box">
    <h2>New customer</h2>
    <p>Check out as a guest. You can create an account after your order.</p>
    <form id="guest-form" action="#" onsubmit="return false">
      <div class="row"><label for="guest-email">E-mail for order updates</label><input id="guest-email" name="guest[email]" type="email" autocomplete="email"></div>
      <button>Continue as guest</button>
    </form>
  </section>
</div>`,
      js: fxLive({ username: '#rc-email', password: '#rc-password' }),
    }),
  },

  {
    id: 'h4-signin-06',
    category: 'signin',
    description: 'Building-society internet banking with unusual labels: "Customer number" (numeric keyboard) and "Passcode", a remember-number tick and a security notice.',
    steps: [step('signin', [x('#custNo', 'username'), x('#passcode', 'password')])],
    html: doc({
      title: 'Harbourstone Mutual – Internet Banking',
      css: `
body{margin:0;font:15px Arial,sans-serif;background:#eef2f5;color:#14213d}
.bar{background:#14213d;color:#fff;padding:16px 40px;font-size:20px}
.panel{max-width:480px;margin:40px auto;background:#fff;border-top:5px solid #fca311;padding:26px 34px}
.fld{margin:18px 0}.fld label{display:block;font-weight:bold;margin-bottom:6px}
.fld .hint{font-size:12px;color:#556}
.fld input[type=text],.fld input[type=password]{width:230px;padding:9px;border:2px solid #9aa;font-size:16px;letter-spacing:1px}
.note{background:#fff8e6;border-left:4px solid #fca311;padding:10px 14px;font-size:13px}
.btn{background:#fca311;border:0;padding:11px 26px;font-weight:bold}`,
      body: `
<div class="bar">Harbourstone Mutual</div>
<div class="panel">
  <h1 style="font-size:22px">Log on to Internet Banking</h1>
  <form name="logonForm" action="#" onsubmit="return false" autocomplete="off">
    <div class="fld">
      <label for="custNo">Customer number</label>
      <span class="hint">This is the 8 to 10 digit number on your welcome letter.</span><br>
      <input type="text" id="custNo" name="customerNumber" inputmode="numeric" autocomplete="off">
    </div>
    <div class="fld"><label><input type="checkbox" name="rememberCustNo"> Remember my customer number</label></div>
    <div class="fld">
      <label for="passcode">Passcode</label>
      <input type="password" id="passcode" name="pc" autocomplete="off">
      <div class="hint"><a href="#">Forgotten your passcode?</a></div>
    </div>
    <button class="btn" type="submit">Log on</button>
  </form>
  <p class="note">We will never ask for your full passcode by phone or email.</p>
</div>`,
      js: fxLive({ username: '#custNo', password: '#passcode' }),
    }),
  },

  {
    id: 'h4-signin-07',
    category: 'signin',
    description: 'Cinema site whose "Log in" header button opens a native dialog with the form; the header search stays on the page behind the backdrop.',
    steps: [
      step('none', [], ['#search'], { advance: { click: '#open-login' } }),
      step('signin', [x('#dlg-email', 'username'), x('#dlg-pass', 'password')], ['#search'], { wait: 'dialog[open] #dlg-email' }),
    ],
    html: doc({
      title: 'Pinewood Cinemas – What\'s on',
      css: `
body{margin:0;font:15px Helvetica,sans-serif;background:#111;color:#eee}
header{display:flex;align-items:center;gap:20px;padding:14px 30px;background:#000}
header input{padding:7px 10px;background:#222;border:1px solid #444;color:#eee;width:240px}
header button{margin-left:auto;background:#e50914;color:#fff;border:0;padding:8px 16px;border-radius:4px}
.films{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:30px}
.film{background:#222;height:200px;border-radius:6px;padding:10px}
dialog{border:0;border-radius:8px;padding:28px;width:340px;background:#fff;color:#111}
dialog::backdrop{background:rgba(0,0,0,.7)}
dialog label{display:block;font-size:13px;margin-top:12px}
dialog input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:4px}
.x{float:right;background:none;border:0;font-size:20px}`,
      body: `
<header>
  <strong>PINEWOOD</strong>
  <input type="search" id="search" placeholder="Search films and cinemas">
  <button id="open-login" type="button">Log in</button>
</header>
<div class="films"><div class="film">Night Harbour</div><div class="film">The Ninth Lantern</div><div class="film">Paper Moons</div><div class="film">Iron Orchard</div></div>
<dialog id="login-dialog" aria-labelledby="dlg-title">
  <button class="x" type="button" aria-label="Close" onclick="this.closest('dialog').close()">×</button>
  <h2 id="dlg-title">Log in to Pinewood</h2>
  <form method="dialog" onsubmit="event.preventDefault()">
    <label for="dlg-email">Email</label><input id="dlg-email" type="email" name="email" autocomplete="username">
    <label for="dlg-pass">Password</label><input id="dlg-pass" type="password" name="password" autocomplete="current-password">
    <p><button type="submit">Log in</button> <a href="#">Join Pinewood Plus</a></p>
  </form>
</dialog>`,
      js: `
document.getElementById('open-login').addEventListener('click', function () { document.getElementById('login-dialog').showModal(); });
${fxLive({ username: '#dlg-email', password: '#dlg-pass' })}`,
    }),
  },

  {
    id: 'h4-signin-08',
    category: 'signin',
    description: 'Patient portal with floating labels placed after the inputs, "Member ID or email" as the identifier, and a show/hide password button that swaps the input type.',
    steps: [step('signin', [x('#f-user', 'username'), x('#f-pass', 'password')])],
    html: doc({
      title: 'Mossgrove Health – Member sign in',
      css: `
body{margin:0;font:16px "Segoe UI",sans-serif;background:#f1f7f4}
.card{max-width:400px;margin:70px auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 2px 12px rgba(0,60,40,.12)}
.fl{position:relative;margin-bottom:20px}
.fl input{width:100%;box-sizing:border-box;padding:22px 12px 8px;border:1px solid #9bb;border-radius:8px;font-size:16px}
.fl label{position:absolute;left:13px;top:15px;color:#577;pointer-events:none;transition:all .15s}
.fl input:focus + label,.fl input:not(:placeholder-shown) + label{top:5px;font-size:11px}
.eye{position:absolute;right:8px;top:12px;border:0;background:none;color:#286;font-size:13px}
.submit{width:100%;padding:12px;background:#1f7a5a;color:#fff;border:0;border-radius:8px;font-size:16px}`,
      body: `
<div class="card">
  <h1 style="font-size:22px;color:#1f7a5a">Mossgrove Health</h1>
  <p>Sign in to see claims, benefits and your digital card.</p>
  <form action="#" onsubmit="return false" novalidate>
    <div class="fl">
      <input id="f-user" name="identifier" type="text" placeholder=" " autocomplete="username">
      <label for="f-user">Member ID or email</label>
    </div>
    <div class="fl">
      <input id="f-pass" name="secret" type="password" placeholder=" " autocomplete="current-password">
      <label for="f-pass">Password</label>
      <button class="eye" type="button" aria-pressed="false" aria-controls="f-pass">Show</button>
    </div>
    <button class="submit" type="submit">Sign in</button>
  </form>
  <p style="font-size:14px"><a href="#">Forgot member ID?</a> · <a href="#">Reset password</a></p>
</div>`,
      js: `
document.querySelector('.eye').addEventListener('click', function () {
  var p = document.getElementById('f-pass');
  var show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  this.textContent = show ? 'Hide' : 'Show';
  this.setAttribute('aria-pressed', String(show));
});
${fxLive({ username: '#f-user', password: '#f-pass' })}`,
    }),
  },

  {
    id: 'h4-signin-09',
    category: 'signin',
    description: 'CRM log-in with generated ids and aria-labelledby labels, an off-screen "website" trap field, and an SSO company-email box inside a closed details element.',
    steps: [step('signin', [x('input[id="_r_7_"]', 'username'), x('input[id="_r_9_"]', 'password')], ['input[name="website"]', '#sso-domain'])],
    html: doc({
      title: 'Ferrous CRM',
      css: `
body{margin:0;font:14px Inter,Arial,sans-serif;background:#f6f6f9;color:#1c1c28}
.box{width:380px;margin:80px auto;background:#fff;border:1px solid #e3e3ea;border-radius:8px;padding:30px}
.lbl{font-weight:600;font-size:13px;margin:14px 0 6px}
.box input[type=text],.box input[type=password]{width:100%;box-sizing:border-box;padding:9px;border:1px solid #c8c8d4;border-radius:6px}
.trap{position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}
button{margin-top:18px;width:100%;padding:10px;background:#5b4cdb;color:#fff;border:0;border-radius:6px}
details{margin-top:18px;font-size:13px}`,
      body: `
<div class="box">
  <h2>Ferrous CRM</h2>
  <form action="#" onsubmit="return false">
    <div class="lbl" id="_r_6_">Username</div>
    <input id="_r_7_" type="text" aria-labelledby="_r_6_" autocomplete="off" spellcheck="false">
    <div class="lbl" id="_r_8_">Password</div>
    <input id="_r_9_" type="password" aria-labelledby="_r_8_">
    <div class="trap" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    <button type="submit">Log in</button>
  </form>
  <details>
    <summary>Log in with company SSO</summary>
    <label>Company email domain <input id="sso-domain" type="text" placeholder="acme.example"></label>
    <button type="button">Continue with SSO</button>
  </details>
</div>`,
      js: fxLive({ username: 'input[id="_r_7_"]', password: 'input[id="_r_9_"]' }),
    }),
  },

  {
    id: 'h4-signin-10',
    category: 'signin',
    description: 'Rewards app with "Email" and "Mobile" tabs; the mobile tab\'s phone and password boxes sit in a hidden panel.',
    steps: [step('signin', [x('#e-email', 'username'), x('#e-pass', 'password')], ['#m-phone', '#m-pass'])],
    html: doc({
      title: 'Orchardline Rewards – Sign in',
      css: `
body{margin:0;font:15px Avenir,Helvetica,sans-serif;background:#fffaf0}
.wrap{max-width:380px;margin:60px auto}
[role=tablist]{display:flex;border-bottom:2px solid #f0c987}
[role=tab]{flex:1;padding:10px;background:none;border:0;font:inherit;cursor:pointer}
[role=tab][aria-selected=true]{border-bottom:3px solid #b5651d;font-weight:bold}
[role=tabpanel]{padding:20px 0}
.f{margin-bottom:14px}.f label{display:block;font-size:13px;color:#7a5230}
.f input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #e0c9a6;border-radius:6px}
.go{width:100%;padding:11px;border:0;border-radius:6px;background:#b5651d;color:#fff}`,
      body: `
<div class="wrap">
  <h1 style="color:#b5651d">Orchardline Rewards</h1>
  <div role="tablist" aria-label="Sign in with">
    <button role="tab" id="tab-e" aria-selected="true" aria-controls="panel-e">Email</button>
    <button role="tab" id="tab-m" aria-selected="false" aria-controls="panel-m">Mobile</button>
  </div>
  <div role="tabpanel" id="panel-e" aria-labelledby="tab-e">
    <form action="#" onsubmit="return false">
      <div class="f"><label for="e-email">Email address</label><input id="e-email" type="email" name="email" autocomplete="email"></div>
      <div class="f"><label for="e-pass">Password</label><input id="e-pass" type="password" name="password" autocomplete="current-password"></div>
      <button class="go">Sign in</button>
    </form>
  </div>
  <div role="tabpanel" id="panel-m" aria-labelledby="tab-m" hidden>
    <form action="#" onsubmit="return false">
      <div class="f"><label for="m-phone">Mobile number</label><input id="m-phone" type="tel" name="mobile" autocomplete="tel"></div>
      <div class="f"><label for="m-pass">Password</label><input id="m-pass" type="password" name="password" autocomplete="current-password"></div>
      <button class="go">Sign in</button>
    </form>
  </div>
</div>`,
      js: `
document.querySelectorAll('[role=tab]').forEach(function (t) {
  t.addEventListener('click', function () {
    document.querySelectorAll('[role=tab]').forEach(function (o) {
      var on = o === t;
      o.setAttribute('aria-selected', String(on));
      document.getElementById(o.getAttribute('aria-controls')).hidden = !on;
    });
  });
});
${fxLive({ username: '#e-email', password: '#e-pass' })}`,
    }),
  },
];
