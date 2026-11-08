// Pages where nothing may be filled.
import { doc, fxNone, step } from './kit.mjs';

const neg = (id, description, kind, honeypots, page) => ({ id, category: 'negative', description, steps: [step(kind, [], honeypots)], html: doc({ ...page, js: (page.js ? page.js + '\n' : '') + fxNone }) });

export default [
  neg('h4-neg-01', 'Help-centre search results: the big search box holds the query "reset password", with a sort select beside it.', 'search', ['#q', '#sort'], {
    title: 'Search results – Wanderdocs Help',
    css: `
body{margin:0;font:15px "Segoe UI",sans-serif;background:#fafafa}
.bar{display:flex;gap:10px;padding:20px 40px;background:#fff;border-bottom:1px solid #ddd}
.bar input{flex:1;padding:12px;font-size:17px;border:1px solid #bbb;border-radius:24px}
.res{max-width:760px;margin:20px 40px}.res article{margin-bottom:18px}.res h3{margin:0;color:#1a4fbf}`,
    body: `
<form class="bar" role="search" action="#" onsubmit="return false">
  <input type="search" id="q" name="q" value="reset password" aria-label="Search help articles" autocomplete="off">
  <select id="sort" name="sort" aria-label="Sort by"><option>Most relevant</option><option>Newest</option></select>
  <button type="submit">Search</button>
</form>
<div class="res">
  <p>About 14 results</p>
  <article><h3>Reset a forgotten password</h3><p>Use the link on the sign-in page and we'll email you a reset link…</p></article>
  <article><h3>Change your password while signed in</h3><p>Go to Settings, then Security…</p></article>
  <article><h3>Password requirements</h3><p>Passwords must be at least 12 characters…</p></article>
</div>`,
  }),

  neg('h4-neg-02', 'Newsletter landing page: first name and email with a Subscribe button, nothing else.', 'newsletter', ['#nl-first', '#nl-email'], {
    title: 'The Sunday Slow-Read',
    css: `
body{margin:0;font:17px Charter,Georgia,serif;background:#fdf6e3;color:#333}
.wrap{max-width:520px;margin:90px auto;text-align:center}
form{display:flex;flex-direction:column;gap:10px;margin-top:24px}
input{padding:12px;border:1px solid #c9b88f;font:inherit}
button{padding:12px;background:#b58900;color:#fff;border:0;font:inherit}`,
    body: `
<div class="wrap">
  <h1>The Sunday Slow-Read</h1>
  <p>One long essay, every Sunday morning. No ads, unsubscribe any time.</p>
  <form action="#" onsubmit="return false">
    <input id="nl-first" name="first_name" type="text" placeholder="First name" autocomplete="given-name">
    <input id="nl-email" name="email" type="email" placeholder="Email address" autocomplete="email">
    <button type="submit">Subscribe</button>
  </form>
  <p style="font-size:13px">Join 41,000 readers.</p>
</div>`,
  }),

  neg('h4-neg-03', 'Blog post comment form: name, email "(will not be published)", website and the comment itself.', 'none', ['#author', '#email', '#url', '#comment'], {
    title: 'Pruning an old pear tree – Quietplot Gardens',
    css: `
body{margin:0;font:16px/1.6 "Lora",serif;background:#fff;color:#2d2d2d}
article,#respond{max-width:680px;margin:30px auto}
#respond p{margin:8px 0}#respond label{display:block;font-size:14px}
#respond input[type=text],#respond input[type=email],#respond input[type=url],#respond textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc}`,
    body: `
<article>
  <h1>Pruning an old pear tree</h1>
  <p>Our neighbour's pear tree hadn't seen a saw in twenty years. Here's how we brought it back over three winters…</p>
</article>
<div id="respond">
  <h3>Leave a Reply</h3>
  <form action="#" method="post" id="commentform" onsubmit="return false">
    <p>Your email address will not be published. Required fields are marked *</p>
    <p><label for="comment">Comment *</label><textarea id="comment" name="comment" rows="6"></textarea></p>
    <p><label for="author">Name *</label><input id="author" name="author" type="text" autocomplete="name"></p>
    <p><label for="email">Email *</label><input id="email" name="email" type="email" autocomplete="email"></p>
    <p><label for="url">Website</label><input id="url" name="url" type="url" autocomplete="url"></p>
    <p><label><input id="cookies-consent" name="cookies-consent" type="checkbox"> Save my name, email, and website in this browser for the next time I comment.</label></p>
    <p><input name="submit" type="submit" value="Post Comment"></p>
  </form>
</div>`,
  }),

  neg('h4-neg-04', 'Bot check before a download: a box drawn on a canvas shows a code, and one text box asks you to type the characters from the box.', 'none', ['#captcha_answer'], {
    title: 'Security check – Openfold Downloads',
    css: `
body{margin:0;font:15px Arial,sans-serif;background:#eceff1}
.c{width:380px;margin:100px auto;background:#fff;padding:26px;border-radius:6px;text-align:center}
canvas{border:1px solid #999;background:#f5f5dc}
input{width:180px;padding:9px;font-size:18px;text-align:center;letter-spacing:3px}`,
    body: `
<div class="c">
  <h2>One more step</h2>
  <p>Please type the characters you see in the box below.</p>
  <canvas id="cap" width="200" height="60" aria-label="Security code image"></canvas>
  <p><a href="#" id="refresh">Show a different code</a> · <a href="#">Audio code</a></p>
  <form action="#" onsubmit="return false">
    <label for="captcha_answer">Characters from the box</label><br>
    <input id="captcha_answer" name="captcha_answer" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="6">
    <p><button type="submit">Continue to download</button></p>
  </form>
</div>`,
    js: `
var ctx = document.getElementById('cap').getContext('2d');
ctx.font = 'italic bold 30px serif';
ctx.fillStyle = '#4a3b2a';
'K7QM4X'.split('').forEach(function (ch, i) { ctx.save(); ctx.translate(20 + i * 28, 40); ctx.rotate((i % 2 ? 1 : -1) * 0.2); ctx.fillText(ch, 0, 0); ctx.restore(); });
ctx.strokeStyle = '#999'; ctx.beginPath(); ctx.moveTo(0, 20); ctx.bezierCurveTo(60, 60, 140, 0, 200, 40); ctx.stroke();`,
  }),

  neg('h4-neg-05', 'Password strength demo on a security blog: one password box with a live meter and crack-time estimate, used only to test a made-up password.', 'none', ['#pw-test'], {
    title: 'How strong is your password? – Lockpick Weekly',
    css: `
body{margin:0;font:16px "Fira Sans",sans-serif;background:#0d1117;color:#c9d1d9}
.c{max-width:560px;margin:60px auto}
#pw-test{width:100%;box-sizing:border-box;padding:14px;font-size:18px;background:#161b22;border:1px solid #30363d;color:#fff;border-radius:8px}
.meter{height:10px;background:#21262d;border-radius:5px;margin-top:10px}.meter div{height:100%;width:0;border-radius:5px;background:#f85149}`,
    body: `
<div class="c">
  <h1>How strong is your password?</h1>
  <p>Type a made-up password to see how long it might take to crack. The check runs only in your browser and nothing is sent anywhere. Please don't type your real password.</p>
  <label for="pw-test">Try a password</label>
  <input id="pw-test" type="password" autocomplete="off" placeholder="Try something like correct-horse-battery">
  <label><input type="checkbox" id="reveal"> Show</label>
  <div class="meter"><div id="fill"></div></div>
  <p id="verdict">Start typing…</p>
</div>`,
    js: `
var t = document.getElementById('pw-test');
t.addEventListener('input', function () {
  var n = t.value.length, pct = Math.min(100, n * 7);
  document.getElementById('fill').style.width = pct + '%';
  document.getElementById('fill').style.background = pct > 70 ? '#3fb950' : pct > 40 ? '#d29922' : '#f85149';
  document.getElementById('verdict').textContent = n < 8 ? 'Cracked instantly' : n < 12 ? 'About a day' : 'Centuries';
});
document.getElementById('reveal').addEventListener('change', function () { t.type = this.checked ? 'text' : 'password'; });`,
  }),

  neg('h4-neg-06', 'Small-business contact form: name, email, phone, a subject select and a message.', 'none', ['#cf-name', '#cf-email', '#cf-phone', '#cf-subject', '#cf-message'], {
    title: 'Contact us – Bluewren Plumbing',
    css: `
body{margin:0;font:15px Arial,sans-serif;background:#f0f6fb}
form{width:480px;margin:40px auto;background:#fff;padding:26px;border-radius:8px}
.f{margin-bottom:12px}.f label{display:block;font-size:13px}
.f input,.f select,.f textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #9bbbd4;border-radius:4px}`,
    body: `
<form action="#" onsubmit="return false">
  <h1 style="font-size:22px">Get in touch</h1>
  <p>Leaking tap? Blocked drain? Tell us about the job and we'll call you back.</p>
  <div class="f"><label for="cf-name">Your name</label><input id="cf-name" name="your-name" autocomplete="name"></div>
  <div class="f"><label for="cf-email">Email</label><input id="cf-email" name="your-email" type="email" autocomplete="email"></div>
  <div class="f"><label for="cf-phone">Phone</label><input id="cf-phone" name="your-phone" type="tel" autocomplete="tel"></div>
  <div class="f"><label for="cf-subject">What do you need?</label><select id="cf-subject" name="subject"><option>A quote</option><option>An emergency call-out</option><option>Something else</option></select></div>
  <div class="f"><label for="cf-message">Message</label><textarea id="cf-message" name="your-message" rows="5"></textarea></div>
  <button type="submit">Send message</button>
</form>`,
  }),

  neg('h4-neg-07', 'Shopping cart: quantity number boxes for two items and a promo code box with an Apply button.', 'none', ['#qty-1', '#qty-2', '#promo'], {
    title: 'Your cart – Halfmoon Tea',
    css: `
body{margin:0;font:15px "Helvetica Neue",sans-serif;background:#fff}
table{width:700px;margin:40px auto;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}
td input[type=number]{width:60px;padding:5px}
.promo{width:700px;margin:0 auto;display:flex;gap:8px;justify-content:flex-end}
.promo input{padding:8px;width:200px;text-transform:uppercase}`,
    body: `
<table>
  <tr><th>Item</th><th>Price</th><th>Qty</th><th>Total</th></tr>
  <tr><td>Smoky lapsang, 100 g</td><td>$14.00</td><td><input id="qty-1" type="number" name="updates[]" value="1" min="0" aria-label="Quantity for Smoky lapsang"></td><td>$14.00</td></tr>
  <tr><td>Glass teapot</td><td>$38.00</td><td><input id="qty-2" type="number" name="updates[]" value="1" min="0" aria-label="Quantity for Glass teapot"></td><td>$38.00</td></tr>
</table>
<form class="promo" action="#" onsubmit="return false">
  <label for="promo">Promo code</label><input id="promo" name="discount" type="text" autocomplete="off"><button type="submit">Apply</button>
</form>
<p style="width:700px;margin:20px auto;text-align:right"><b>Subtotal $52.00</b><br><button type="button">Check out</button></p>`,
  }),

  neg('h4-neg-08', 'Gift card balance check: a card number box and a PIN box filled from an on-screen keypad (the PIN box is read-only and masked).', 'none', ['#gc-number', '#gc-pin'], {
    title: 'Check your gift card balance – Corner & Co',
    css: `
body{margin:0;font:15px "Gill Sans",sans-serif;background:#f7f3ee}
.c{width:340px;margin:60px auto;background:#fff;border-radius:12px;padding:24px;text-align:center}
.c input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;font-size:18px;text-align:center;letter-spacing:2px;border:1px solid #ccc}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pad button{padding:14px;font-size:20px;border:1px solid #ddd;background:#fafafa;border-radius:8px}`,
    body: `
<div class="c">
  <h2>Gift card balance</h2>
  <label for="gc-number">Gift card number</label>
  <input id="gc-number" name="giftcard" type="text" inputmode="numeric" autocomplete="off">
  <label for="gc-pin">4-digit PIN (scratch the back of the card)</label>
  <input id="gc-pin" name="pin" type="password" readonly>
  <div class="pad" id="pad">
    <button type="button">1</button><button type="button">2</button><button type="button">3</button>
    <button type="button">4</button><button type="button">5</button><button type="button">6</button>
    <button type="button">7</button><button type="button">8</button><button type="button">9</button>
    <button type="button" data-k="clear">C</button><button type="button">0</button><button type="button" data-k="ok">OK</button>
  </div>
</div>`,
    js: `
document.getElementById('pad').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  var pin = document.getElementById('gc-pin');
  var k = b.getAttribute('data-k');
  if (k === 'clear') pin.value = '';
  else if (!k && pin.value.length < 4) pin.value += b.textContent;
});`,
  }),

  neg('h4-neg-09', 'Wi-Fi QR code generator: network name, network password (masked), security select; makes a code for guests to scan.', 'none', ['#ssid', '#wifi-pass', '#enc'], {
    title: 'Wi-Fi QR maker – Toolshed Utilities',
    css: `
body{margin:0;font:15px system-ui,sans-serif;background:#eef2ff}
.c{width:420px;margin:60px auto;background:#fff;border-radius:12px;padding:26px}
.f{margin-bottom:12px}.f label{display:block;font-size:13px}
.f input,.f select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #c7d2fe;border-radius:6px}
.qr{width:160px;height:160px;margin:10px auto;background:repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/20px 20px}`,
    body: `
<div class="c">
  <h1 style="font-size:22px">Make a Wi-Fi QR code</h1>
  <p>Print it and stick it on the fridge so guests can join without asking.</p>
  <form action="#" onsubmit="return false">
    <div class="f"><label for="ssid">Network name (SSID)</label><input id="ssid" name="ssid" type="text" autocomplete="off"></div>
    <div class="f"><label for="wifi-pass">Network password</label><input id="wifi-pass" name="wifi_password" type="password" autocomplete="off"></div>
    <div class="f"><label for="enc">Security</label><select id="enc" name="enc"><option>WPA/WPA2/WPA3</option><option>WEP</option><option>None</option></select></div>
    <label><input type="checkbox" name="hidden_ssid"> Hidden network</label>
    <p><button type="submit">Make QR code</button></p>
  </form>
  <div class="qr" aria-label="QR code preview"></div>
</div>`,
  }),

  neg('h4-neg-10', 'Product page delivery estimator: quantity box, a postcode box and a country select to work out shipping cost.', 'none', ['#qty', '#est-postcode', '#est-country'], {
    title: 'Oak bedside table – Grainline Furniture',
    css: `
body{margin:0;font:15px "Libre Franklin",sans-serif;background:#fff}
.p{display:grid;grid-template-columns:1fr 1fr;gap:40px;max-width:900px;margin:40px auto}
.img{height:360px;background:linear-gradient(135deg,#d7b98e,#a47b4f)}
.est{border:1px solid #ddd;padding:14px;margin-top:20px}
.est input,.est select{padding:7px}`,
    body: `
<div class="p">
  <div class="img" role="img" aria-label="Oak bedside table"></div>
  <div>
    <h1>Oak bedside table</h1>
    <p><b>$349</b></p>
    <label for="qty">Quantity</label> <input id="qty" type="number" min="1" value="1" style="width:60px">
    <p><button type="button">Add to cart</button></p>
    <div class="est">
      <b>Estimate delivery</b>
      <form action="#" onsubmit="return false">
        <label for="est-postcode">Postcode</label> <input id="est-postcode" name="postcode" inputmode="numeric" maxlength="4" style="width:80px">
        <select id="est-country" name="country" aria-label="Country"><option>Australia</option><option>New Zealand</option></select>
        <button type="submit">Calculate</button>
      </form>
    </div>
  </div>
</div>`,
  }),

  neg('h4-neg-11', 'Support chat widget opened in the corner: optional name and email for a transcript, and a message box.', 'none', ['#chat-name', '#chat-email', '#chat-msg'], {
    title: 'Pricing – Ripplefeed',
    css: `
body{margin:0;font:15px "Inter",sans-serif;background:#f9fafb}
.plans{display:flex;gap:20px;justify-content:center;padding:60px}
.plan{width:220px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px}
.chat{position:fixed;right:20px;bottom:20px;width:320px;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.2);overflow:hidden}
.chat header{background:#7c3aed;color:#fff;padding:12px}
.chat .body{padding:12px}
.chat input,.chat textarea{width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:6px}`,
    body: `
<div class="plans"><div class="plan"><h3>Starter</h3><p>$9/mo</p></div><div class="plan"><h3>Team</h3><p>$29/mo</p></div><div class="plan"><h3>Business</h3><p>$79/mo</p></div></div>
<div class="chat" role="complementary" aria-label="Chat with us">
  <header>Hi there 👋 How can we help?</header>
  <div class="body">
    <p style="font-size:13px">We usually reply in a few minutes.</p>
    <input id="chat-name" type="text" placeholder="Your name (optional)">
    <input id="chat-email" type="email" placeholder="Email for a transcript (optional)">
    <textarea id="chat-msg" rows="3" placeholder="Type your message…"></textarea>
    <button type="button">Send</button>
  </div>
</div>`,
  }),

  neg('h4-neg-12', 'Domain name availability checker: a name box and a top-level-domain select with a Search button.', 'search', ['#domain', '#tld'], {
    title: 'Find your domain – Namecrate',
    css: `
body{margin:0;font:16px "Nunito Sans",sans-serif;background:linear-gradient(#0f766e,#115e59);color:#fff;min-height:100vh}
.c{max-width:640px;margin:0 auto;padding-top:120px;text-align:center}
form{display:flex;gap:6px;margin-top:20px}
#domain{flex:1;padding:14px;font-size:18px;border:0;border-radius:8px}
#tld{padding:14px;border:0;border-radius:8px}`,
    body: `
<div class="c">
  <h1>Find the perfect domain</h1>
  <form action="#" role="search" onsubmit="return false">
    <input id="domain" name="domain" type="text" placeholder="yourbusiness" autocomplete="off" aria-label="Domain name">
    <select id="tld" name="tld" aria-label="Ending"><option>.com</option><option>.net</option><option>.io</option><option>.com.au</option></select>
    <button type="submit">Search</button>
  </form>
</div>`,
  }),

  neg('h4-neg-13', 'Age gate in front of a winery site: day, month and year selects for the date of birth and a country select.', 'none', ['#dob-day', '#dob-month', '#dob-year', '#age-country'], {
    title: 'Welcome – Ironstone Ridge Wines',
    css: `
body{margin:0;height:100vh;background:#3b0d0c;color:#f5e6d3;font:16px "Cormorant Garamond",serif;display:grid;place-items:center}
.gate{text-align:center}.gate select{padding:8px;margin:4px;font-size:16px}`,
    body: `
<div class="gate" role="dialog" aria-labelledby="g-title">
  <h1 id="g-title">Are you of legal drinking age?</h1>
  <p>Please enter your date of birth.</p>
  <form action="#" onsubmit="return false">
    <select id="dob-day" name="day" aria-label="Day"><option value="">Day</option><option>1</option><option>2</option><option>3</option><option>15</option><option>28</option></select>
    <select id="dob-month" name="month" aria-label="Month"><option value="">Month</option><option>January</option><option>June</option><option>December</option></select>
    <select id="dob-year" name="year" aria-label="Year"><option value="">Year</option><option>1960</option><option>1985</option><option>2000</option></select><br>
    <select id="age-country" name="country" aria-label="Country"><option>Australia</option><option>United Kingdom</option><option>Other</option></select>
    <p><label><input type="checkbox" name="remember"> Remember me</label></p>
    <button type="submit">Enter</button>
  </form>
</div>`,
  }),

  neg('h4-neg-14', 'Developer settings page that has just created an access token: a read-only box shows the new token, next to boxes for another token\'s name and expiry.', 'none', ['#new-token', '#token-name', '#token-exp'], {
    title: 'Access tokens – Brookline Deploy',
    css: `
body{margin:0;font:14px ui-sans-serif,system-ui,sans-serif;background:#fff;color:#111}
main{max-width:700px;margin:30px auto}
.ok{background:#ecfdf5;border:1px solid #6ee7b7;padding:14px;border-radius:8px}
.ok input{width:100%;box-sizing:border-box;padding:8px;font-family:monospace;border:1px solid #6ee7b7;background:#fff}
.f{margin:12px 0}.f label{display:block;font-weight:600}
.f input,.f select{padding:7px;width:300px}`,
    body: `
<main>
  <h1>Access tokens</h1>
  <div class="ok">
    <p><b>Token created.</b> Copy it now. You won't be able to see it again.</p>
    <input id="new-token" type="text" readonly value="bkd_pat_9f3c1a77e0b24d6aa1c8f5e2d4b7a901" aria-label="New personal access token">
    <button type="button">Copy</button>
  </div>
  <h2>Create another token</h2>
  <form action="#" onsubmit="return false">
    <div class="f"><label for="token-name">Token name</label><input id="token-name" name="name" type="text" placeholder="ci-deploys"></div>
    <div class="f"><label for="token-exp">Expiration</label><select id="token-exp" name="expires"><option>30 days</option><option>90 days</option><option>No expiration</option></select></div>
    <fieldset><legend>Scopes</legend><label><input type="checkbox" name="scope" value="read"> read</label> <label><input type="checkbox" name="scope" value="deploy"> deploy</label></fieldset>
    <p><button type="submit">Generate token</button></p>
  </form>
</main>`,
  }),

  neg('h4-neg-15', 'Create-a-poll form in a team app: question, three answer options and a closing date.', 'none', ['#poll-q', '#opt-1', '#opt-2', '#opt-3', '#poll-close'], {
    title: 'New poll – Huddleboard',
    css: `
body{margin:0;font:15px "Inter",sans-serif;background:#f3f4f6}
form{width:460px;margin:50px auto;background:#fff;padding:24px;border-radius:10px}
input{display:block;width:100%;box-sizing:border-box;padding:9px;margin:6px 0 12px;border:1px solid #d1d5db;border-radius:6px}`,
    body: `
<form action="#" onsubmit="return false">
  <h2>Create a poll</h2>
  <label for="poll-q">Question</label><input id="poll-q" name="question" type="text" placeholder="Where should we have the team lunch?">
  <label>Options</label>
  <input id="opt-1" name="options[]" type="text" placeholder="Option 1">
  <input id="opt-2" name="options[]" type="text" placeholder="Option 2">
  <input id="opt-3" name="options[]" type="text" placeholder="Option 3">
  <label for="poll-close">Closes on</label><input id="poll-close" name="closes" type="date">
  <label style="display:flex;gap:6px"><input type="checkbox" name="anon" style="width:auto;margin:0"> Anonymous votes</label>
  <button type="submit">Post poll</button>
</form>`,
  }),

  neg('h4-neg-16', 'Order tracking page for guests: order number and the email used at checkout, no account involved.', 'none', ['#order-no', '#track-email'], {
    title: 'Track your order – Saltbush Supply',
    css: `
body{margin:0;font:15px "Barlow",sans-serif;background:#f6f5f2}
.c{width:400px;margin:70px auto;background:#fff;padding:26px;border:1px solid #e2ded5}
.c label{display:block;margin-top:12px;font-size:13px}
.c input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #c8c2b4}`,
    body: `
<div class="c">
  <h1 style="font-size:22px">Track your order</h1>
  <p>No account needed. Enter the details from your confirmation email.</p>
  <form action="#" onsubmit="return false">
    <label for="order-no">Order number</label><input id="order-no" name="order_number" type="text" placeholder="SB-104233">
    <label for="track-email">Email used at checkout</label><input id="track-email" name="email" type="email">
    <p><button type="submit">Track</button></p>
  </form>
</div>`,
  }),
];
