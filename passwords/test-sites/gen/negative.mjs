import { fx, noise } from './kit.mjs';

const cat = 'negative';
const neg = (def) => {
  const honeypots = def.fields || [];
  fx({
    category: cat,
    negative: true,
    ...def,
    steps: [{ kind: def.kind || 'none', expected: [], honeypots }],
  });
};

neg({
  id: 'negative-search-01', kind: 'search', brand: 'Acme Atlas', theme: 'slate', header: 'nameless', footer: 'legal', fields: ['#big-search'],
  description: 'Help-center hero search with name=q and type=search; the page has only search boxes.',
  title: 'Help center',
  main: `<section style="text-align:center;padding:50px 0"><h1>How can we help?</h1><form role="search" onsubmit="return false"><input id="big-search" name="q" type="search" placeholder="Search articles" style="width:min(480px,90%)"> <button>Search</button></form></section><div class="split"><div><h3>Getting started</h3><p>Install the app, invite your crew and pin your first job.</p></div><div><h3>Account and billing</h3><p>Change your plan or update your password from Settings.</p></div></div>`,
});

neg({
  id: 'negative-search-02', kind: 'search', brand: 'Dunmarrow County Library', theme: 'paper', header: 'minimal', footer: 'links', fields: ['#cat-input', '#cat-author'],
  description: 'Library catalogue search with no search word in any attribute: names term and author, labels Title and Author, button Find.',
  title: 'Catalogue',
  main: `<form class="narrow box" onsubmit="return false"><h1>Library catalogue</h1><div class="row"><label for="cat-input">Title</label><input id="cat-input" name="term" type="text"></div><div class="row"><label for="cat-author">Author</label><input id="cat-author" name="author" type="text"></div><button>Find</button></form><p class="muted">Sign in to place a hold. Your library card and PIN are required at checkout.</p>`,
});

neg({
  id: 'negative-search-03', kind: 'search', brand: 'Mossgrove Outfitters', theme: 'forest', header: 'shop', footer: 'links', fields: ['#size-filter', '#price-min', '#price-max'],
  description: 'Store listing with a search header plus filter inputs: min and max price, size text. No account fields.',
  title: 'Jackets - Mossgrove',
  main: `<h1>Jackets</h1><aside class="box" style="margin-bottom:20px"><h3>Filter</h3><label for="size-filter">Size</label> <input id="size-filter" name="size" placeholder="e.g. M"> <label for="price-min">From</label> <input id="price-min" name="min" type="number"> <label for="price-max">To</label> <input id="price-max" name="max" type="number"></aside><ul><li>Waxed field jacket, 189</li><li>Canvas chore coat, 129</li><li>Packable shell, 99</li></ul>`,
});

neg({
  id: 'negative-newsletter-01', kind: 'newsletter', brand: 'Marrowbone Press', theme: 'paper', header: 'navbar', footer: 'legal', fields: ['#letter-email'],
  description: 'Standalone newsletter signup with a type=email box and a Subscribe button, mentioning an account elsewhere.',
  title: 'The Sunday Letter',
  main: `<div class="narrow box"><h1>The Sunday Letter</h1><p>Long reads, one email a week. Already a subscriber? <a href="#">Log in</a>.</p><form onsubmit="return false"><div class="row"><label for="letter-email">Email address</label><input id="letter-email" name="email" type="email" autocomplete="email"></div><button>Subscribe</button></form></div>`,
});

neg({
  id: 'negative-newsletter-02', kind: 'newsletter', brand: 'Quillfin', theme: 'grape', header: 'minimal', footer: 'links', fields: ['#waitlist'],
  description: 'Coming-soon page: placeholder Enter your email with a Join the waitlist button, no form element, and name=username as a sloppy attribute.',
  title: 'Quillfin mobile is coming',
  main: `<section style="text-align:center;padding:60px 0"><h1>Quillfin for phones. Soon.</h1><p>Be the first to know when it lands.</p><input id="waitlist" name="username" placeholder="Enter your email" style="width:min(320px,90%)"> <button type="button">Join the waitlist</button></section>`,
});

neg({
  id: 'negative-newsletter-03', kind: 'newsletter', brand: 'Wrenfield Home', theme: 'sun', header: 'none', footer: 'legal', fields: ['#pop-fn', '#pop-em'],
  description: 'Promotional popup asking for first name and email for 10 percent off, wording says Create your discount and Sign up.',
  title: 'Wrenfield Home',
  css: `.promo-pop{border:2px solid var(--accent);border-radius:10px;padding:24px;max-width:380px;margin:40px auto;background:var(--card)}`,
  main: `<h1>Linen for every room</h1><div class="promo-pop" role="dialog" aria-label="Get ten percent off"><h2>10% off your first order</h2><p>Sign up for emails and we will send your code.</p><div class="row"><input id="pop-fn" name="first" placeholder="First name"></div><div class="row"><input id="pop-em" name="email" type="email" placeholder="Email"></div><button type="button">Sign up</button></div>`,
});

neg({
  id: 'negative-contact-01', brand: 'Thistlegate Hosting', theme: 'corp', header: 'bar', footer: 'links', fields: ['#ct-name', '#ct-mail', '#ct-sub', '#ct-msg'],
  description: 'Contact form: name, email, subject and message textarea. The message text talks about forgetting a password.',
  title: 'Contact us',
  main: `<form class="narrow box" onsubmit="return false"><h1>Contact us</h1><p>Forgot your password? You can reset it yourself. For anything else, write to us.</p><div class="row"><label for="ct-name">Your name</label><input id="ct-name" name="name"></div><div class="row"><label for="ct-mail">Your email</label><input id="ct-mail" name="email" type="email"></div><div class="row"><label for="ct-sub">Subject</label><input id="ct-sub" name="subject"></div><div class="row"><label for="ct-msg">Message</label><textarea id="ct-msg" name="message" rows="5" style="width:100%"></textarea></div><button>Send</button></form>`,
});

neg({
  id: 'negative-comment-01', brand: 'Marrowbone Press', theme: 'paper', header: 'navbar', footer: 'legal', fields: ['#c-author', '#c-mail', '#c-url', '#c-body'],
  description: 'Blog comment form: author, email, website, comment. Keywords look like a guest sign-up but nothing here is a login.',
  title: 'The pencil, reconsidered',
  main: `<article><h1>The pencil, reconsidered</h1><p>It began, as these things do, with a shortage of cedar.</p></article><section><h2>Leave a comment</h2><form onsubmit="return false"><p><label for="c-author">Name</label><br><input id="c-author" name="author"></p><p><label for="c-mail">Email (will not be published)</label><br><input id="c-mail" name="email"></p><p><label for="c-url">Website</label><br><input id="c-url" name="url"></p><p><label for="c-body">Comment</label><br><textarea id="c-body" name="comment" rows="4" cols="50"></textarea></p><button>Post comment</button></form></section>`,
});

neg({
  id: 'negative-coupon-01', brand: 'Mossgrove Outfitters', theme: 'forest', header: 'shop', footer: 'links', fields: ['#coupon'],
  description: 'Cart page with a Promo code box named coupon and an Apply button, type=text, close to an order total.',
  title: 'Your cart',
  main: `<h1>Your cart</h1><table border="1" cellpadding="8" style="border-collapse:collapse;width:100%"><tr><td>Waxed field jacket</td><td>189.00</td></tr><tr><td>Delivery</td><td>Free</td></tr></table><form onsubmit="return false" style="margin:14px 0"><label for="coupon">Promo code</label> <input id="coupon" name="coupon"> <button>Apply</button></form><p><a href="#">Check out</a></p>`,
});

neg({
  id: 'negative-giftcard-01', brand: 'Wrenfield Home', theme: 'sun', header: 'shop', footer: 'links', fields: ['#gc-no', '#gc-pin'],
  description: 'Gift card balance check: card number and a PIN in a type=password input. Looks like a login but the card is not an account.',
  title: 'Check your gift card balance',
  main: `<form class="narrow box" onsubmit="return false"><h1>Gift card balance</h1><div class="row"><label for="gc-no">Gift card number</label><input id="gc-no" name="gift_card_number"></div><div class="row"><label for="gc-pin">PIN</label><input id="gc-pin" name="gift_card_pin" type="password" maxlength="4"></div><button>Check balance</button></form>`,
});

neg({
  id: 'negative-address-01', brand: 'Acme Harvest', theme: 'forest', header: 'bar', footer: 'links', fields: ['#adr1', '#adr2', '#adrc', '#adrz'],
  description: 'Checkout address step with street, unit, town and postcode only: no name, no phone, no card, nothing that amounts to an identity form.',
  title: 'Delivery address',
  main: `<form class="narrow box" onsubmit="return false"><p class="muted">Step 1 of 3</p><h1>Where should the seeds go?</h1><div class="row"><label for="adr1">Street</label><input id="adr1" name="street"></div><div class="row"><label for="adr2">Unit</label><input id="adr2" name="unit"></div><div class="row"><label for="adrc">Town</label><input id="adrc" name="town"></div><div class="row"><label for="adrz">Postcode</label><input id="adrz" name="zip"></div><button>Continue</button></form>`,
});

neg({
  id: 'negative-calculator-01', brand: 'Bellwether Trust', theme: 'corp', header: 'utility', footer: 'table', fields: ['#amount', '#rate', '#term'],
  description: 'Loan calculator with three number inputs and a live monthly repayment; heading mentions Log in to apply.',
  title: 'Loan calculator',
  main: `<div class="narrow box"><h1>Loan calculator</h1><div class="row"><label for="amount">Amount</label><input id="amount" type="number" value="20000"></div><div class="row"><label for="rate">Interest rate (%)</label><input id="rate" type="number" value="6.5" step="0.1"></div><div class="row"><label for="term">Term (years)</label><input id="term" type="number" value="5"></div><p>Monthly repayment: <b id="repay"></b></p><p><a href="#">Log in to apply</a></p></div>`,
  script: `function calc(){var a=+document.getElementById('amount').value,r=+document.getElementById('rate').value/1200,n=+document.getElementById('term').value*12;document.getElementById('repay').textContent=r&&n?(a*r/(1-Math.pow(1+r,-n))).toFixed(2):'';}['amount','rate','term'].forEach(function(i){document.getElementById(i).addEventListener('input',calc);});calc();window.__fixture={state:function(){return {};}};`,
});

neg({
  id: 'negative-settings-01', brand: 'Tidewrack Systems', theme: 'corp', header: 'bar', footer: 'links', fields: ['#rows-1', '#rows-2', '#rows-3', '#rows-4'],
  description: 'Table of admin settings, one input per row: session timeout, max login attempts, password minimum length, and token lifetime. Labels are full of credential words but they configure the system.',
  title: 'Security policy',
  main: `<h1>Security policy</h1><table border="1" cellpadding="8" style="border-collapse:collapse;width:100%"><tr><th>Setting</th><th>Value</th></tr><tr><td>Session timeout (minutes)</td><td><input id="rows-1" name="session_timeout" value="30"></td></tr><tr><td>Max login attempts</td><td><input id="rows-2" name="login_attempts" value="5"></td></tr><tr><td>Minimum password length</td><td><input id="rows-3" name="password_min" value="12"></td></tr><tr><td>Access token lifetime (hours)</td><td><input id="rows-4" name="token_lifetime" value="24"></td></tr></table><p><button type="button">Save</button></p>`,
});

neg({
  id: 'negative-captcha-01', brand: 'Ferncastle Forums', theme: 'retro', header: 'table', footer: 'table', fields: ['#capt'],
  description: 'Text captcha alone on a page: inline SVG of letters and a text box Type the characters you see, name=captcha_code.',
  title: 'Are you human?',
  main: `<div class="narrow box"><h2>One moment</h2><p>Please type the characters you see below to continue.</p><svg width="170" height="50" role="img" aria-label="Captcha image" style="background:#ddd"><text x="12" y="34" font-size="28" transform="rotate(-4)">x7Kp2</text></svg><form onsubmit="return false"><p><input id="capt" name="captcha_code" type="text" autocomplete="off"></p><input type="submit" value="Verify"></form></div>`,
});

neg({
  id: 'negative-chat-01', brand: 'Tarnhold Cloud', theme: 'night', header: 'minimal', footer: 'legal', fields: ['#chat-box'],
  description: 'Support chat: a transcript where the agent says enter your password and code to help confuse text scoring; one input at the bottom.',
  title: 'Support chat',
  css: `.bubble{padding:8px 12px;border-radius:10px;background:var(--card);border:1px solid var(--line);margin:6px 0;max-width:70%}`,
  main: `<div class="narrow"><h1>Support chat</h1><div class="bubble">Hi, I can help you reset your password.</div><div class="bubble">Please never share your password or your verification code here.</div><div style="display:flex;gap:6px"><input id="chat-box" name="message" type="text" placeholder="Type a message" style="flex:1"><button type="button">Send</button></div></div>`,
});

neg({
  id: 'negative-share-01', brand: 'Sable Notes', theme: 'slate', header: 'bar', footer: 'links', fields: ['#share-to', '#share-note'],
  description: 'Share dialog: recipient email and an optional message; type=email with autocomplete=email in a Share this note panel.',
  title: 'Share note',
  main: `<div class="narrow box" role="dialog" aria-label="Share this note"><h2>Share &ldquo;Grocery run&rdquo;</h2><div class="row"><label for="share-to">Share by email</label><input id="share-to" type="email" name="recipient" autocomplete="email" placeholder="name@example.test"></div><div class="row"><label for="share-note">Add a message</label><input id="share-note" name="note"></div><button type="button">Send invite</button></div>`,
});

neg({
  id: 'negative-zip-01', brand: 'Dunmarrow Energy', theme: 'sun', header: 'utility', footer: 'links', fields: ['#zip-only'],
  description: 'Zip-code lookup alone: Check if we serve your area, one box named zip, autocomplete=postal-code.',
  title: 'Do we serve your area?',
  main: `<section style="text-align:center;padding:50px 0"><h1>Do we serve your area?</h1><form onsubmit="return false"><label for="zip-only">Enter your postcode</label><br><input id="zip-only" name="zip" autocomplete="postal-code" style="width:160px"> <button>Check</button></form></section>`,
});

neg({
  id: 'negative-template-01', brand: 'Velvetine Cloud', theme: 'night', header: 'navbar', footer: 'legal', fields: [],
  description: 'A sign-in form inside a template element, never instantiated; the password input exists only in inert template content.',
  title: 'Velvetine docs',
  main: `<h1>Deploy guide</h1><p>Push a folder, get a URL. Everything else is optional.</p><template id="tpl-login"><form><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form></template><pre style="background:var(--card);padding:12px;overflow:auto">velvetine deploy ./site --region eu</pre>`,
});

neg({
  id: 'negative-template-02', brand: 'Harrowgate Mutual', theme: 'corp', header: 'utility', footer: 'links', fields: ['#never-u', '#never-p'],
  description: 'Login markup rendered into a display:none block that nothing on the page ever opens: a leftover from an old page layout, permanently hidden.',
  title: 'Branch finder',
  main: `<h1>Find a branch</h1><p>We have 41 branches across the region. Open Monday to Saturday.</p><div id="legacy-login" style="display:none"><form onsubmit="return false"><input id="never-u" name="username"><input id="never-p" name="password" type="password"><button>Log in</button></form></div><ul><li>High Street, open until 5</li><li>Station Road, open until 4</li></ul>`,
});

neg({
  id: 'negative-delete-01', brand: 'Cobalt Ferret Games', theme: 'night', header: 'navbar', footer: 'legal', fields: ['#type-delete'],
  description: 'Delete my account confirmation: type DELETE into a text box. Must never be filled with anything.',
  title: 'Delete your account',
  main: `<div class="narrow box" style="border-color:#c33"><h1>Delete your account</h1><p>This wipes your Player ID, your saves and your credits, and it cannot be undone.</p><form onsubmit="return false"><div class="row"><label for="type-delete">Type DELETE to confirm</label><input id="type-delete" name="confirm" autocomplete="off"></div><button>Delete my account</button></form></div>`,
});

neg({
  id: 'negative-wifi-01', brand: 'Northgale Telecom', theme: 'forest', header: 'utility', footer: 'links', fields: ['#ssid', '#wifi-psk'],
  description: 'Router settings: SSID and a Wi-Fi password in type=password, name=password, describing the home network rather than a site login.',
  title: 'Home hub - Wi-Fi settings',
  main: `<form class="narrow box" onsubmit="return false"><h1>Wi-Fi settings</h1><p>Change the name and password your devices use to join your home network.</p><div class="row"><label for="ssid">Network name (SSID)</label><input id="ssid" name="ssid" value="Northgale-4471"></div><div class="row"><label for="wifi-psk">Wi-Fi password</label><input id="wifi-psk" name="password" type="password" autocomplete="off"></div><button>Save and restart Wi-Fi</button></form>`,
});

neg({
  id: 'negative-wifi-02', brand: 'Thistlegate Hosting', theme: 'corp', header: 'nameless', footer: 'links', fields: ['#share-pass', '#share-exp'],
  description: 'Protect this download with a password: a type=password box that sets a password for someone else, along with an expiry date.',
  title: 'Create a share link',
  main: `<form class="narrow box" onsubmit="return false"><h1>Create a share link</h1><p>report-q3.pdf (2.4 MB)</p><div class="row"><label for="share-pass">Protect with a password (optional)</label><input id="share-pass" name="link_password" type="password" autocomplete="off"></div><div class="row"><label for="share-exp">Expires on</label><input id="share-exp" name="expires" type="date"></div><button>Create link</button></form>`,
});

neg({
  id: 'negative-article-01', brand: 'Larkspur & Vane', theme: 'paper', header: 'bar', footer: 'news', fields: [],
  description: 'Advice article How to pick a strong password, with lots of login vocabulary in prose and a header search and newsletter only.',
  title: 'How to pick a strong password',
  main: `<article><h1>How to pick a strong password</h1><p>Your username is not a secret, but your password should be. Choose four random words, and never reuse the same password on two sites.</p><p>When a site asks you to sign in, check the address first. Turn on two-factor authentication wherever it is offered.</p></article>${noise.faq('Larkspur')}`,
});

neg({
  id: 'negative-poll-01', brand: 'Stonebarrow Council Services', theme: 'forest', header: 'utility', footer: 'links', fields: ['#poll-other', '#poll-age'],
  description: 'Community survey: radio buttons, an Other text box and an age number. Lacks anything an autofill should touch.',
  title: 'Parks survey',
  main: `<form class="narrow box" onsubmit="return false"><h1>Tell us about your local park</h1><p><label><input type="radio" name="use" value="walk"> Walking</label><br><label><input type="radio" name="use" value="sport"> Sport</label><br><label><input type="radio" name="use" value="other"> Other</label></p><div class="row"><label for="poll-other">If other, please say</label><input id="poll-other" name="other"></div><div class="row"><label for="poll-age">Your age (optional)</label><input id="poll-age" name="age" type="number"></div><button>Send</button></form>`,
});

neg({
  id: 'negative-booking-01', brand: 'Ombrelle Travel', theme: 'slate', header: 'bar', footer: 'links', fields: ['#b-from', '#b-to', '#b-date', '#b-ref', '#b-last'],
  description: 'Manage my booking: booking reference plus surname, a two-field pairing that looks like username and password but opens a single trip, next to a flight search.',
  title: 'Manage your trip',
  main: `<div class="split"><form class="box" onsubmit="return false"><h2>Find a trip</h2><div class="row"><label for="b-from">From</label><input id="b-from" name="from"></div><div class="row"><label for="b-to">To</label><input id="b-to" name="to"></div><div class="row"><label for="b-date">Depart</label><input id="b-date" name="depart" type="date"></div><button>Search</button></form><form class="box" onsubmit="return false"><h2>Manage my booking</h2><div class="row"><label for="b-ref">Booking reference</label><input id="b-ref" name="pnr"></div><div class="row"><label for="b-last">Surname</label><input id="b-last" name="surname"></div><button>Retrieve</button></form></div>`,
});
