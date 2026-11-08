// Card and address forms.
import { doc, fxLive, step, x } from './kit.mjs';

const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => `<option value="${m}">${m}</option>`).join('');
const years = Array.from({ length: 10 }, (_, i) => 2026 + i).map((y) => `<option value="${y}">${y}</option>`).join('');

export default [
  {
    id: 'h4-card-01',
    category: 'card',
    description: 'Outdoor shop checkout: name on card, a number box that groups digits as you type, month and year selects, CVC, and a coupon box in the order summary.',
    steps: [step('card', [x('#cc-name', 'card-name'), x('#cc-number', 'card-number'), x('#cc-exp-month', 'card-exp-month'), x('#cc-exp-year', 'card-exp-year'), x('#cc-csc', 'card-cvv')], ['#coupon'])],
    html: doc({
      title: 'Checkout – Juniper Outfitters',
      css: `
body{margin:0;font:14px "Helvetica Neue",sans-serif;background:#f5f5f0}
.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:30px;max-width:920px;margin:40px auto}
.pane{background:#fff;padding:24px;border:1px solid #ddd}
.f{margin-bottom:12px}.f label{display:block;font-size:12px;text-transform:uppercase;color:#666;margin-bottom:4px}
.f input,.f select{padding:9px;border:1px solid #bbb;width:100%;box-sizing:border-box}
.two{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.pay{background:#2f5233;color:#fff;border:0;padding:12px 24px}`,
      body: `
<div class="grid">
  <div class="pane">
    <h2>Payment</h2>
    <form id="payment" action="#" onsubmit="return false">
      <div class="f"><label for="cc-name">Name on card</label><input id="cc-name" name="cardholder" autocomplete="cc-name"></div>
      <div class="f"><label for="cc-number">Card number</label><input id="cc-number" name="card_number" inputmode="numeric" maxlength="19" placeholder="1234 1234 1234 1234"></div>
      <div class="two">
        <div class="f"><label for="cc-exp-month">Expiry month</label><select id="cc-exp-month" name="exp_month"><option value="">MM</option>${months}</select></div>
        <div class="f"><label for="cc-exp-year">Expiry year</label><select id="cc-exp-year" name="exp_year"><option value="">YYYY</option>${years}</select></div>
        <div class="f"><label for="cc-csc">CVC</label><input id="cc-csc" name="cvc" inputmode="numeric" maxlength="4"></div>
      </div>
      <button class="pay" type="submit">Pay $184.00</button>
    </form>
  </div>
  <div class="pane">
    <h3>Order summary</h3>
    <p>Trail tent 2P · $159.00<br>Titanium mug · $25.00</p>
    <form action="#" onsubmit="return false"><label for="coupon">Discount code</label><br><input id="coupon" name="coupon" type="text"> <button>Apply</button></form>
  </div>
</div>`,
      js: `
var num = document.getElementById('cc-number');
num.addEventListener('input', function () {
  var d = num.value.replace(/[^0-9]/g, '').slice(0, 16);
  num.value = d.replace(/(.{4})/g, '$1 ').trim();
});
${fxLive({ 'card-name': '#cc-name', 'card-number': '#cc-number', 'card-exp-month': '#cc-exp-month', 'card-exp-year': '#cc-exp-year', 'card-cvv': '#cc-csc' })}`,
    }),
  },

  {
    id: 'h4-card-02',
    category: 'card',
    description: 'Hosted payment fields: the name box is on the shop page, while number, expiry and CVC each sit in their own iframe from another origin and talk to the page by postMessage.',
    steps: [step('card', [
      x('#cardholder', 'card-name'),
      x('input[name="cardnumber"]', 'card-number', ['#cf-number']),
      x('input[name="exp-date"]', 'card-exp', ['#cf-expiry']),
      x('input[name="cvc"]', 'card-cvv', ['#cf-cvc']),
    ], ['#gift-note'], { wait: '#pay-form[data-frames-ready]' })],
    html: doc({
      title: 'Pay – Lattice Coffee Roasters',
      css: `
body{margin:0;font:15px "Avenir Next",sans-serif;background:#faf6f1}
form{width:420px;margin:50px auto;background:#fff;padding:26px;border-radius:10px}
label{display:block;font-size:13px;color:#6b4f3a;margin:12px 0 4px}
#cardholder,#gift-note{width:100%;box-sizing:border-box;padding:9px;border:1px solid #d7c4b0;border-radius:6px}
iframe{display:block;width:100%;height:40px;border:1px solid #d7c4b0;border-radius:6px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{margin-top:18px;width:100%;padding:11px;background:#6b4f3a;color:#fff;border:0;border-radius:6px}`,
      body: `
<form id="pay-form" action="#" onsubmit="return false">
  <h2>Card details</h2>
  <label for="cardholder">Cardholder name</label><input id="cardholder" name="cardholder" autocomplete="cc-name">
  <label>Card number</label><iframe id="cf-number" title="Secure card number input frame" data-field="number"></iframe>
  <div class="row">
    <div><label>Expiry</label><iframe id="cf-expiry" title="Secure expiration date input frame" data-field="expiry"></iframe></div>
    <div><label>CVC</label><iframe id="cf-cvc" title="Secure CVC input frame" data-field="cvc"></iframe></div>
  </div>
  <label for="gift-note">Gift message (optional)</label><input id="gift-note" name="gift_note" type="text">
  <button type="submit">Pay $42.50</button>
</form>`,
      js: `
var relayed = {};
var frames = Array.prototype.slice.call(document.querySelectorAll('iframe[data-field]'));
var other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
var loaded = 0;
function broadcast() {
  var all = Object.assign({ 'card-name': document.getElementById('cardholder').value }, relayed);
  frames.forEach(function (f) { if (f.contentWindow) f.contentWindow.postMessage({ type: 'lattice-all', state: all }, '*'); });
}
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'lattice-field') { relayed[e.data.role] = e.data.value; broadcast(); }
});
document.getElementById('cardholder').addEventListener('input', broadcast);
frames.forEach(function (f) {
  f.addEventListener('load', function () { loaded++; if (loaded === frames.length) document.getElementById('pay-form').setAttribute('data-frames-ready', ''); broadcast(); });
  f.src = location.protocol + '//' + other + ':' + location.port + '/fixtures/_frames/h4-card-02-field.html?f=' + f.getAttribute('data-field');
});
window.__fixture = { state: function () { return Object.assign({ 'card-name': document.getElementById('cardholder').value }, relayed); } };`,
    }),
    files: {
      '_frames/h4-card-02-field.html': doc({
        title: 'Secure field',
        css: `html,body{margin:0;height:100%}input{width:100%;height:100%;box-sizing:border-box;border:0;padding:0 10px;font:15px "Avenir Next",sans-serif;outline:none}`,
        body: `<input id="field" type="text" inputmode="numeric" autocorrect="off" spellcheck="false">`,
        js: `
var kind = new URLSearchParams(location.search).get('f');
var conf = {
  number: { name: 'cardnumber', ac: 'cc-number', ph: '1234 1234 1234 1234', role: 'card-number', label: 'Credit or debit card number' },
  expiry: { name: 'exp-date', ac: 'cc-exp', ph: 'MM / YY', role: 'card-exp', label: 'Credit or debit card expiration date' },
  cvc: { name: 'cvc', ac: 'cc-csc', ph: 'CVC', role: 'card-cvv', label: 'Credit or debit card CVC/CVV' },
}[kind];
var el = document.getElementById('field');
el.name = conf.name; el.autocomplete = conf.ac; el.placeholder = conf.ph; el.setAttribute('aria-label', conf.label);
var all = {};
el.addEventListener('input', function () {
  var d = el.value.replace(/[^0-9]/g, '');
  if (kind === 'number') el.value = d.slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
  if (kind === 'expiry') { d = d.slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d; }
  if (kind === 'cvc') el.value = d.slice(0, 4);
  parent.postMessage({ type: 'lattice-field', role: conf.role, value: el.value }, '*');
});
window.addEventListener('message', function (e) { if (e.data && e.data.type === 'lattice-all') all = e.data.state; });
window.__fixture = { state: function () { var o = Object.assign({}, all); o[conf.role] = el.value; return o; } };`,
      }),
    },
  },

  {
    id: 'h4-card-03',
    category: 'card',
    description: 'Charity donation page: amount buttons and an "other amount" number box, then card number, a combined MM/YY expiry with a slash mask, CVV and name on card.',
    steps: [step('card', [x('#dn-card', 'card-number'), x('#dn-exp', 'card-exp'), x('#dn-cvv', 'card-cvv'), x('#dn-name', 'card-name')], ['#other-amount'])],
    html: doc({
      title: 'Donate – Riverbank Wildlife Rescue',
      css: `
body{margin:0;font:16px "Merriweather Sans",sans-serif;background:#e8f5e9}
.wrap{width:460px;margin:40px auto;background:#fff;border-radius:10px;padding:28px}
.amounts{display:flex;gap:8px;flex-wrap:wrap}.amounts label{border:1px solid #66bb6a;border-radius:6px;padding:6px 12px}
.f{margin:12px 0}.f label{display:block;font-size:13px}
.f input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #a5d6a7;border-radius:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{width:100%;padding:12px;background:#2e7d32;color:#fff;border:0;border-radius:6px}`,
      body: `
<div class="wrap">
  <h1 style="font-size:22px">Help an injured animal today</h1>
  <form action="#" onsubmit="return false">
    <div class="amounts">
      <label><input type="radio" name="amount" value="25"> $25</label>
      <label><input type="radio" name="amount" value="50" checked> $50</label>
      <label><input type="radio" name="amount" value="100"> $100</label>
    </div>
    <div class="f"><label for="other-amount">Other amount ($)</label><input id="other-amount" name="other_amount" type="number" min="2"></div>
    <h3>Card details</h3>
    <div class="f"><label for="dn-card">Card number</label><input id="dn-card" name="ccnum" type="text" inputmode="numeric" autocomplete="cc-number"></div>
    <div class="two">
      <div class="f"><label for="dn-exp">Expiry (MM/YY)</label><input id="dn-exp" name="ccexp" type="text" inputmode="numeric" placeholder="MM/YY" maxlength="5"></div>
      <div class="f"><label for="dn-cvv">CVV</label><input id="dn-cvv" name="cccvv" type="text" inputmode="numeric" maxlength="4"></div>
    </div>
    <div class="f"><label for="dn-name">Name on card</label><input id="dn-name" name="ccname" type="text"></div>
    <label><input type="checkbox" name="giftaid"> Add 25% at no cost to me (Gift Aid)</label>
    <p><button type="submit">Donate</button></p>
  </form>
</div>`,
      js: `
var exp = document.getElementById('dn-exp');
exp.addEventListener('input', function () {
  var d = exp.value.replace(/[^0-9]/g, '').slice(0, 4);
  exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
});
${fxLive({ 'card-number': '#dn-card', 'card-exp': '#dn-exp', 'card-cvv': '#dn-cvv', 'card-name': '#dn-name' })}`,
    }),
  },

  {
    id: 'h4-identity-01',
    category: 'identity',
    description: 'Bakery delivery address without autocomplete hints: full name, two address lines, suburb, state select, postcode, country select, phone, and a delivery-notes box.',
    steps: [step('identity', [
      x('#ship-name', 'full-name'), x('#ship-line1', 'address1'), x('#ship-line2', 'address2'), x('#ship-suburb', 'city'),
      x('#ship-state', 'state'), x('#ship-postcode', 'postcode'), x('#ship-country', 'country'), x('#ship-phone', 'phone'),
    ], ['#ship-notes'])],
    html: doc({
      title: 'Delivery – Kettle & Crumb',
      css: `
body{margin:0;font:15px "Quicksand",sans-serif;background:#fff8f0}
form{width:520px;margin:40px auto;background:#fff;padding:26px;border-radius:10px}
.f{margin-bottom:12px}.f label{display:block;font-size:13px;color:#8d6e63}
.f input,.f select,.f textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #d7ccc8;border-radius:6px}
.three{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}`,
      body: `
<form action="#" onsubmit="return false">
  <h2>Where should we deliver?</h2>
  <div class="f"><label for="ship-name">Recipient name</label><input id="ship-name" name="recipient"></div>
  <div class="f"><label for="ship-line1">Street address</label><input id="ship-line1" name="street1"></div>
  <div class="f"><label for="ship-line2">Apartment, unit, etc. (optional)</label><input id="ship-line2" name="street2"></div>
  <div class="three">
    <div class="f"><label for="ship-suburb">Suburb</label><input id="ship-suburb" name="suburb"></div>
    <div class="f"><label for="ship-state">State</label><select id="ship-state" name="state"><option value="">–</option><option>ACT</option><option>NSW</option><option>NT</option><option>QLD</option><option>SA</option><option>TAS</option><option>VIC</option><option>WA</option></select></div>
    <div class="f"><label for="ship-postcode">Postcode</label><input id="ship-postcode" name="postcode" inputmode="numeric" maxlength="4"></div>
  </div>
  <div class="f"><label for="ship-country">Country</label><select id="ship-country" name="country"><option value="AU">Australia</option><option value="NZ">New Zealand</option></select></div>
  <div class="f"><label for="ship-phone">Mobile (for the driver)</label><input id="ship-phone" name="mobile" type="tel"></div>
  <div class="f"><label for="ship-notes">Delivery notes</label><textarea id="ship-notes" name="notes" rows="2" placeholder="Leave at the side gate"></textarea></div>
  <button type="submit">Continue to payment</button>
</form>`,
      js: fxLive({ 'full-name': '#ship-name', address1: '#ship-line1', address2: '#ship-line2', city: '#ship-suburb', state: '#ship-state', postcode: '#ship-postcode', country: '#ship-country', phone: '#ship-phone' }),
    }),
  },

  {
    id: 'h4-identity-02',
    category: 'identity',
    description: 'Software billing profile with autocomplete hints: first and last name, company, address, city, ZIP, country select and phone, plus a VAT number box.',
    steps: [step('identity', [
      x('#bp-first', 'first-name'), x('#bp-last', 'last-name'), x('#bp-company', 'company'), x('#bp-address', 'address1'),
      x('#bp-city', 'city'), x('#bp-zip', 'postcode'), x('#bp-country', 'country'), x('#bp-phone', 'phone'),
    ], ['#bp-vat'])],
    html: doc({
      title: 'Billing details – Tessellate',
      css: `
body{margin:0;font:14px "Inter",sans-serif;background:#f8f9fb}
.card{width:560px;margin:40px auto;background:#fff;border:1px solid #e1e4ea;border-radius:8px;padding:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.f label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}
.f input,.f select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cdd2db;border-radius:6px}
.full{grid-column:1 / -1}`,
      body: `
<div class="card">
  <h2>Billing details</h2>
  <form action="#" onsubmit="return false">
    <div class="grid">
      <div class="f"><label for="bp-first">First name</label><input id="bp-first" name="first_name" autocomplete="given-name"></div>
      <div class="f"><label for="bp-last">Last name</label><input id="bp-last" name="last_name" autocomplete="family-name"></div>
      <div class="f full"><label for="bp-company">Company</label><input id="bp-company" name="company" autocomplete="organization"></div>
      <div class="f full"><label for="bp-address">Address</label><input id="bp-address" name="address" autocomplete="address-line1"></div>
      <div class="f"><label for="bp-city">City</label><input id="bp-city" name="city" autocomplete="address-level2"></div>
      <div class="f"><label for="bp-zip">ZIP / Postal code</label><input id="bp-zip" name="zip" autocomplete="postal-code"></div>
      <div class="f"><label for="bp-country">Country</label><select id="bp-country" name="country" autocomplete="country"><option value="">Select…</option><option value="CA">Canada</option><option value="IE">Ireland</option><option value="US">United States</option></select></div>
      <div class="f"><label for="bp-phone">Phone</label><input id="bp-phone" name="phone" type="tel" autocomplete="tel"></div>
      <div class="f full"><label for="bp-vat">VAT / Tax ID (optional)</label><input id="bp-vat" name="tax_id"></div>
    </div>
    <p><button type="submit">Save billing details</button></p>
  </form>
</div>`,
      js: fxLive({ 'first-name': '#bp-first', 'last-name': '#bp-last', company: '#bp-company', address1: '#bp-address', city: '#bp-city', postcode: '#bp-zip', country: '#bp-country', phone: '#bp-phone' }),
    }),
  },
];
