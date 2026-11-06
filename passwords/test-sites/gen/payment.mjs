import { childRelay, fx, noise, parentMerge } from './kit.mjs';

const r = (selector, role, frame) => ({ selector, role, frame });
const months = `<option value="">Month</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}`;
const years = `<option value="">Year</option>${[2026, 2027, 2028, 2029, 2030, 2031].map((y) => `<option value="${y}">${y}</option>`).join('')}`;
const summary = (b) => `<aside class="box"><h3>Order summary</h3><p>1 &times; Annual plan <span style="float:right">96.00</span></p><p class="muted">Billed by ${b}. Cancel any time.</p><p><input id="promo" name="promo_code" placeholder="Promo code" aria-label="Promo code"> <button type="button">Apply</button></p></aside>`;

const cc = 'card';

fx({
  id: 'card-01', category: cc, brand: 'Sable Notes', theme: 'slate', header: 'bar', footer: 'legal',
  description: 'Clean checkout: autocomplete cc-* attributes, labels by for, combined expiry MM/YY and a promo box in the sidebar.',
  title: 'Upgrade to Sable Pro',
  main: `<div class="split"><form class="box" onsubmit="return false"><h1>Payment details</h1><div class="row"><label for="cc-name">Name on card</label><input id="cc-name" name="ccname" autocomplete="cc-name"></div><div class="row"><label for="cc-num">Card number</label><input id="cc-num" name="cardnumber" autocomplete="cc-number" inputmode="numeric"></div><div class="row"><label for="cc-exp">Expiry (MM/YY)</label><input id="cc-exp" name="cc-exp" autocomplete="cc-exp" placeholder="MM/YY"></div><div class="row"><label for="cc-cvc">Security code</label><input id="cc-cvc" name="cvc" autocomplete="cc-csc" inputmode="numeric" maxlength="4"></div><button>Pay 96.00</button></form>${summary('Sable Notes')}</div>`,
  state: { 'card-name': '#cc-name', 'card-number': '#cc-num', 'card-exp': '#cc-exp', 'card-cvv': '#cc-cvc' },
  steps: [{ kind: 'card', expected: [r('#cc-name', 'card-name'), r('#cc-num', 'card-number'), r('#cc-exp', 'card-exp'), r('#cc-cvc', 'card-cvv')], honeypots: ['#promo'] }],
});

fx({
  id: 'card-02', category: cc, brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'news',
  description: 'Separate month and year selects, no autocomplete, a CVV input of type=password, plus an email for the receipt that is not a card field.',
  title: 'Secure checkout',
  main: `<form class="narrow box" onsubmit="return false"><h1>Pay by card</h1><div class="row"><label for="ch">Cardholder</label><input id="ch" name="holder"></div><div class="row"><label for="pan">Card number</label><input id="pan" name="pan" maxlength="19"></div><div class="row"><span class="lbl">Expires</span><select id="exp-m" name="exp_month" aria-label="Expiry month">${months}</select> <select id="exp-y" name="exp_year" aria-label="Expiry year">${years}</select></div><div class="row"><label for="cv">CVV</label><input id="cv" name="cvv" type="password" maxlength="4" style="width:90px"></div><div class="row"><label for="rcpt">Email for receipt</label><input id="rcpt" name="receipt_email" type="email"></div><button>Place order</button></form>`,
  state: { 'card-name': '#ch', 'card-number': '#pan', 'card-exp-month': '#exp-m', 'card-exp-year': '#exp-y', 'card-cvv': '#cv' },
  steps: [{ kind: 'card', expected: [r('#ch', 'card-name'), r('#pan', 'card-number'), r('#exp-m', 'card-exp-month'), r('#exp-y', 'card-exp-year'), r('#cv', 'card-cvv')], honeypots: ['#rcpt'] }],
});

fx({
  id: 'card-03', category: cc, brand: 'Ombrelle Travel', theme: 'corp', header: 'navbar', footer: 'links',
  description: 'Masked card number grouped in fours and masked MM / YY, with the app model holding digits only; name is last, in a table layout.',
  title: 'Pay for your trip',
  css: `.pay td{padding:6px 6px 6px 0}`,
  main: `<h1>Pay for your trip</h1><form onsubmit="return false"><table class="pay"><tr><td><label for="m-num">Card number</label></td><td><input id="m-num" name="card_no" placeholder="0000 0000 0000 0000" maxlength="19" inputmode="numeric" style="width:220px"></td></tr><tr><td><label for="m-exp">Valid until</label></td><td><input id="m-exp" name="valid_until" placeholder="MM / YY" maxlength="7" inputmode="numeric"></td></tr><tr><td><label for="m-sec">CVC</label></td><td><input id="m-sec" name="csc" maxlength="3" inputmode="numeric" style="width:70px"></td></tr><tr><td><label for="m-name">Name as on card</label></td><td><input id="m-name" name="nameoncard"></td></tr></table><p><button>Pay now</button></p></form>`,
  script: `var M={num:'',exp:'',cvc:'',name:''};var n=document.getElementById('m-num'),e=document.getElementById('m-exp'),c=document.getElementById('m-sec'),a=document.getElementById('m-name');
n.addEventListener('input',function(){M.num=n.value.replace(/[^0-9]/g,'').slice(0,16);n.value=M.num.replace(/(.{4})(?=.)/g,'$1 ');});
e.addEventListener('input',function(){var d=e.value.replace(/[^0-9]/g,'').slice(0,4);M.exp=d;e.value=d.length>2?d.slice(0,2)+' / '+d.slice(2):d;});
c.addEventListener('input',function(){M.cvc=c.value;});a.addEventListener('input',function(){M.name=a.value;});
window.__fixture={state:function(){return {'card-number':M.num,'card-exp':M.exp,'card-cvv':M.cvc,'card-name':M.name};}};`,
  steps: [{ kind: 'card', expected: [r('#m-num', 'card-number'), r('#m-exp', 'card-exp'), r('#m-sec', 'card-cvv'), r('#m-name', 'card-name')] }],
});

fx({
  id: 'card-04', category: cc, brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal',
  description: 'Hosted fields: each card input lives in its own cross-origin iframe (different port), like payment-processor widgets; name stays in the top document.',
  title: 'Billing',
  css: `.hf{height:44px;width:100%;border:1px solid var(--line);border-radius:4px;background:var(--card)}`,
  main: `<div class="narrow box"><h1>Add a card</h1><div class="row"><label for="hf-name">Name on card</label><input id="hf-name" name="billing_name"></div><div class="row"><span class="lbl">Card number</span><iframe id="hf-number" class="hf" title="Secure card number" src="http://localhost:__OTHER_PORT__/fixtures/_frames/card-04-number.html"></iframe></div><div class="row"><span class="lbl">Expiration</span><iframe id="hf-exp" class="hf" title="Secure expiration" src="http://localhost:__OTHER_PORT__/fixtures/_frames/card-04-exp.html"></iframe></div><div class="row"><span class="lbl">Security code</span><iframe id="hf-cvc" class="hf" title="Secure CVC" src="http://localhost:__OTHER_PORT__/fixtures/_frames/card-04-cvc.html"></iframe></div><button type="button">Save card</button></div>`,
  pages: [
    ['number', 'cardnumber', 'cc-number', 'Card number', 'card-number'],
    ['exp', 'exp-date', 'cc-exp', 'MM / YY', 'card-exp'],
    ['cvc', 'cvc', 'cc-csc', 'CVC', 'card-cvv'],
  ].map(([n, name, ac, ph, key]) => ({
    path: `_frames/card-04-${n}.html`, header: 'none', footer: 'none', title: 'Secure field', bare: true,
    css: `html,body{background:transparent;margin:0}input{width:100%;height:42px;border:0;outline:0;background:transparent}`,
    main: `<input id="f" name="${name}" autocomplete="${ac}" placeholder="${ph}" inputmode="numeric" aria-label="${ph}">`,
    script: childRelay({ [key]: '#f' }),
  })),
  script: parentMerge({ 'card-name': '', 'card-number': '', 'card-exp': '', 'card-cvv': '' }) + `
(function(){var parentState=window.__fixture.state;var el=document.getElementById('hf-name');window.__fixture={state:function(){var s=parentState();s['card-name']=el.value;return s;}};})();`,
  steps: [{ kind: 'card', expected: [
    r('#hf-name', 'card-name'),
    r('#f', 'card-number', ['#hf-number']),
    r('#f', 'card-exp', ['#hf-exp']),
    r('#f', 'card-cvv', ['#hf-cvc']),
  ] }],
});

fx({
  id: 'card-05', category: cc, brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal',
  description: 'Real-world split: first and last name on card as one full-name box, no form element, data-testid hooks; expiry in two short text boxes MM and YY, with a gift code box alongside.',
  title: 'Buy credits',
  css: `.exp2{display:flex;gap:6px}.exp2 input{width:70px}`,
  main: `<div class="narrow box"><h1>Buy 500 credits</h1><div class="row"><div id="l-card">Card</div><input data-testid="card-input" aria-labelledby="l-card" inputmode="numeric"></div><div class="row"><div id="l-exp">Expiry</div><div class="exp2"><input data-testid="exp-m" aria-labelledby="l-exp" placeholder="MM" maxlength="2"><input data-testid="exp-y" aria-labelledby="l-exp" placeholder="YY" maxlength="2"></div></div><div class="row"><div id="l-sec">Security code</div><input data-testid="sec" aria-labelledby="l-sec" maxlength="4" style="width:90px"></div><div class="row"><div id="l-nm">Cardholder name</div><input data-testid="holder" aria-labelledby="l-nm"></div><button type="button">Buy now</button><hr><div class="row"><label for="gift">Have a gift code?</label><input id="gift" name="gift_code"></div></div>`,
  state: { 'card-number': '[data-testid="card-input"]', 'card-exp-month': '[data-testid="exp-m"]', 'card-exp-year': '[data-testid="exp-y"]', 'card-cvv': '[data-testid="sec"]', 'card-name': '[data-testid="holder"]' },
  steps: [{ kind: 'card', expected: [r('[data-testid="card-input"]', 'card-number'), r('[data-testid="exp-m"]', 'card-exp-month'), r('[data-testid="exp-y"]', 'card-exp-year'), r('[data-testid="sec"]', 'card-cvv'), r('[data-testid="holder"]', 'card-name')], honeypots: ['#gift'] }],
});

fx({
  id: 'card-06', category: cc, brand: 'Dunmarrow Energy', theme: 'sun', header: 'utility', footer: 'links',
  description: 'Bill payment on a retro bank-style form with non-English-looking names (kartennummer, gueltig) in an otherwise English page, and an account reference field to leave alone.',
  title: 'Pay your bill',
  main: `<h1>Pay your bill</h1><form class="box" style="max-width:520px" onsubmit="return false"><div class="row"><label for="ref">Account reference</label><input id="ref" name="account_ref" value="DE-204-8841" readonly></div><div class="row"><label for="amt">Amount</label><input id="amt" name="amount" value="64.20"></div><div class="row"><label for="kn">Card number</label><input id="kn" name="kartennummer"></div><div class="row"><label for="gu">Expiry date</label><input id="gu" name="gueltig" placeholder="MM/YYYY"></div><div class="row"><label for="pz">Card verification</label><input id="pz" name="pruefziffer" maxlength="4"></div><div class="row"><label for="ki">Card holder</label><input id="ki" name="karteninhaber"></div><button>Pay bill</button></form>`,
  state: { 'card-number': '#kn', 'card-exp': '#gu', 'card-cvv': '#pz', 'card-name': '#ki' },
  steps: [{ kind: 'card', expected: [r('#kn', 'card-number'), r('#gu', 'card-exp'), r('#pz', 'card-cvv'), r('#ki', 'card-name')], honeypots: ['#ref', '#amt'] }],
});

fx({
  id: 'card-07', category: cc, brand: 'Acme Harvest', theme: 'forest', header: 'bar', footer: 'newsdiv',
  description: 'Payment step of a checkout with a saved-card radio set above a New card panel; the panel opens when its radio is selected.',
  title: 'Choose how to pay',
  main: `<form class="narrow box" onsubmit="return false"><h1>How would you like to pay?</h1><p><label><input type="radio" name="pm" id="pm-saved" checked> Card ending 4242</label></p><p><label><input type="radio" name="pm" id="pm-new"> Use a new card</label></p><fieldset id="new-card" hidden><legend>New card</legend><div class="row"><label for="nc-num">Card number</label><input id="nc-num" name="new_card_number" autocomplete="cc-number"></div><div class="row"><label for="nc-exp">Expiry</label><input id="nc-exp" name="new_card_exp" autocomplete="cc-exp"></div><div class="row"><label for="nc-cvv">CVV</label><input id="nc-cvv" name="new_card_cvv" autocomplete="cc-csc"></div><div class="row"><label for="nc-name">Name on card</label><input id="nc-name" name="new_card_name" autocomplete="cc-name"></div></fieldset><button>Pay</button></form>`,
  script: `document.querySelectorAll('input[name=pm]').forEach(function(x){x.addEventListener('change',function(){document.getElementById('new-card').hidden=!document.getElementById('pm-new').checked;});});`,
  state: { 'card-number': '#nc-num', 'card-exp': '#nc-exp', 'card-cvv': '#nc-cvv', 'card-name': '#nc-name' },
  steps: [
    { kind: 'none', expected: [], advance: { click: '#pm-new' } },
    { kind: 'card', wait: '#new-card:not([hidden])', expected: [r('#nc-num', 'card-number'), r('#nc-exp', 'card-exp'), r('#nc-cvv', 'card-cvv'), r('#nc-name', 'card-name')] },
  ],
});

// ---------------------------------------------------------------- identity

const id = 'identity';

fx({
  id: 'identity-01', category: id, brand: 'Mossgrove Outfitters', theme: 'forest', header: 'shop', footer: 'news',
  description: 'Shipping details with standard autocomplete tokens: first, last, address lines, city, state, postcode, country select and phone.',
  title: 'Where should we send it?',
  css: `.g2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}`,
  main: `<form class="narrow box" onsubmit="return false"><h1>Delivery details</h1><div class="g2"><div class="row"><label for="ship-fn">First name</label><input id="ship-fn" name="first_name" autocomplete="given-name"></div><div class="row"><label for="ship-ln">Last name</label><input id="ship-ln" name="last_name" autocomplete="family-name"></div></div><div class="row"><label for="ship-a1">Address line 1</label><input id="ship-a1" name="address1" autocomplete="address-line1"></div><div class="row"><label for="ship-a2">Address line 2 (optional)</label><input id="ship-a2" name="address2" autocomplete="address-line2"></div><div class="g2"><div class="row"><label for="ship-city">City</label><input id="ship-city" name="city" autocomplete="address-level2"></div><div class="row"><label for="ship-st">State</label><input id="ship-st" name="state" autocomplete="address-level1"></div></div><div class="g2"><div class="row"><label for="ship-pc">Postcode</label><input id="ship-pc" name="zip" autocomplete="postal-code"></div><div class="row"><label for="ship-co">Country</label><select id="ship-co" name="country" autocomplete="country" style="width:100%"><option value="">Select</option><option value="AU">Australia</option><option value="NZ">New Zealand</option><option value="GB">United Kingdom</option><option value="US">United States</option></select></div></div><div class="row"><label for="ship-tel">Phone</label><input id="ship-tel" name="phone" type="tel" autocomplete="tel"></div><button>Continue to payment</button></form>`,
  state: { 'first-name': '#ship-fn', 'last-name': '#ship-ln', address1: '#ship-a1', address2: '#ship-a2', city: '#ship-city', state: '#ship-st', postcode: '#ship-pc', country: '#ship-co', phone: '#ship-tel' },
  steps: [{ kind: 'identity', expected: [r('#ship-fn', 'first-name'), r('#ship-ln', 'last-name'), r('#ship-a1', 'address1'), r('#ship-a2', 'address2'), r('#ship-city', 'city'), r('#ship-st', 'state'), r('#ship-pc', 'postcode'), r('#ship-co', 'country'), r('#ship-tel', 'phone')] }],
});

fx({
  id: 'identity-02', category: id, brand: 'Sundial Payroll', theme: 'sun', header: 'utility', footer: 'links',
  description: 'Employee onboarding with a single Full name box, company, placeholders only and opaque field_N names; some text is misleading (Mailing address, Suburb).',
  title: 'Employee details',
  main: `<form class="narrow box" onsubmit="return false"><h1>Your details</h1><div class="row"><input id="e1" name="field_1" placeholder="Full legal name"></div><div class="row"><input id="e2" name="field_2" placeholder="Employer / company"></div><div class="row"><input id="e3" name="field_3" placeholder="Mailing address"></div><div class="row"><input id="e4" name="field_4" placeholder="Suburb or town"></div><div class="row"><input id="e5" name="field_5" placeholder="Post code"></div><div class="row"><input id="e6" name="field_6" placeholder="Mobile phone" type="tel"></div><button>Save</button></form>`,
  state: { 'full-name': '#e1', company: '#e2', address1: '#e3', city: '#e4', postcode: '#e5', phone: '#e6' },
  steps: [{ kind: 'identity', expected: [r('#e1', 'full-name'), r('#e2', 'company'), r('#e3', 'address1'), r('#e4', 'city'), r('#e5', 'postcode'), r('#e6', 'phone')] }],
});

fx({
  id: 'identity-03', category: id, brand: 'Stonebarrow Council Services', theme: 'corp', header: 'utility', footer: 'table',
  description: 'Government-style table: Given names, Family name, street address, State dropdown of short codes and phone, with an unrelated Reference number box.',
  title: 'Update your contact details',
  css: `.tb td{padding:5px 8px}`,
  main: `<h1>Update your contact details</h1><p><label for="refno">Rates notice reference</label> <input id="refno" name="ref"></p><form onsubmit="return false"><table class="tb"><tr><td><label for="gv">Given names</label></td><td><input id="gv" name="givenNames"></td></tr><tr><td><label for="fam">Family name</label></td><td><input id="fam" name="familyName"></td></tr><tr><td><label for="str">Street address</label></td><td><input id="str" name="streetAddress"></td></tr><tr><td><label for="sub">Town</label></td><td><input id="sub" name="town"></td></tr><tr><td><label for="regn">State</label></td><td><select id="regn" name="regionCode"><option value="">-</option><option value="NSW">NSW</option><option value="VIC">VIC</option><option value="QLD">QLD</option><option value="WA">WA</option></select></td></tr><tr><td><label for="pc">Postcode</label></td><td><input id="pc" name="pcode" size="6"></td></tr><tr><td><label for="dph">Daytime phone</label></td><td><input id="dph" name="dayPhone"></td></tr></table><p><input type="submit" value="Submit changes"></p></form>`,
  state: { 'first-name': '#gv', 'last-name': '#fam', address1: '#str', city: '#sub', state: '#regn', postcode: '#pc', phone: '#dph' },
  steps: [{ kind: 'identity', expected: [r('#gv', 'first-name'), r('#fam', 'last-name'), r('#str', 'address1'), r('#sub', 'city'), r('#regn', 'state'), r('#pc', 'postcode'), r('#dph', 'phone')], honeypots: ['#refno'] }],
});

fx({
  id: 'identity-04', category: id, brand: 'Ombrelle Travel', theme: 'grape', header: 'navbar', footer: 'links',
  description: 'Lead traveller details with wrapped labels, no form element and React-ish BEM classes; includes a passport number box and special-requests textarea that are not identity-fill targets.',
  title: 'Lead traveller',
  css: `.tr__f{display:block;margin-bottom:10px}.tr__f input,.tr__f textarea{display:block;width:100%}`,
  main: `<div class="narrow box"><h1>Lead traveller</h1>${noise.status()}<label class="tr__f">Title and full name<input id="lt-name" class="tr__in"></label><label class="tr__f">Phone (with country code)<input id="lt-tel" class="tr__in" type="tel"></label><label class="tr__f">Home address<input id="lt-addr" class="tr__in"></label><label class="tr__f">City<input id="lt-city" class="tr__in"></label><label class="tr__f">Zip / postal code<input id="lt-zip" class="tr__in"></label><label class="tr__f">Country<input id="lt-country" class="tr__in"></label><label class="tr__f">Passport number<input id="lt-pass" class="tr__in"></label><label class="tr__f">Special requests<textarea id="lt-notes" class="tr__in" rows="2"></textarea></label><button type="button">Continue</button></div>`,
  state: { 'full-name': '#lt-name', phone: '#lt-tel', address1: '#lt-addr', city: '#lt-city', postcode: '#lt-zip', country: '#lt-country' },
  steps: [{ kind: 'identity', expected: [r('#lt-name', 'full-name'), r('#lt-tel', 'phone'), r('#lt-addr', 'address1'), r('#lt-city', 'city'), r('#lt-zip', 'postcode'), r('#lt-country', 'country')], honeypots: ['#lt-pass', '#lt-notes'] }],
});
