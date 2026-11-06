import { fx } from './kit.mjs';

// All visible text and attribute text on these pages is in the page's language, so
// each carries its own chrome instead of the English shared headers and footers.
const cat = 'language';
const r = (selector, role) => ({ selector, role });

const top = (brand, links, searchHtml = '') =>
  `<header style="display:flex;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center"><b>${brand}</b>${links.map((l) => `<a href="#">${l}</a>`).join('')}${searchHtml ? `<span style="margin-inline-start:auto">${searchHtml}</span>` : ''}</header>`;
const bottom = (txt) => `<footer class="muted" style="padding:24px;text-align:center">${txt}</footer>`;

fx({
  id: 'language-es', category: cat, brand: 'Tienda Alcaraván', lang: 'es', theme: 'sun',
  description: 'Spanish sign-in with name=usuario and name=contraseña (non-ASCII attribute), labels Usuario and Contraseña, Recordarme and ¿Olvidaste tu contraseña?.',
  title: 'Iniciar sesión',
  chromeTop: top('Tienda Alcaraván', ['Ofertas', 'Novedades', 'Ayuda'], '<input id="buscar" name="buscar" type="search" placeholder="Buscar productos" aria-label="Buscar">'),
  chromeBottom: bottom('© 2026 Tienda Alcaraván. Todos los derechos reservados.'),
  main: `<form class="narrow box" onsubmit="return false"><h1>Iniciar sesión</h1><div class="row"><label for="u">Usuario</label><input id="u" name="usuario"></div><div class="row"><label for="c">Contraseña</label><input id="c" name="contraseña" type="password"></div><label style="font-weight:400"><input type="checkbox" name="recordarme"> Recordarme</label><p><button>Entrar</button> <a href="#">¿Olvidaste tu contraseña?</a></p></form>`,
  state: { username: '#u', password: 'input[name="contraseña"]' },
  steps: [{ kind: 'signin', expected: [r('#u', 'username'), r('input[name="contraseña"]', 'password')], honeypots: ['#buscar'] }],
});

fx({
  id: 'language-fr', category: cat, brand: 'Maison Ormeraie', lang: 'fr', theme: 'paper',
  description: 'French sign-in with names identifiant and motdepasse, labels Adresse e-mail and Mot de passe, placed in a table.',
  title: 'Connexion à votre espace',
  chromeTop: top('Maison Ormeraie', ['Collections', 'Boutiques', 'Contact']),
  chromeBottom: bottom('Maison Ormeraie — Mentions légales — Politique de confidentialité'),
  css: `.t td{padding:6px}`,
  main: `<h1>Connexion à votre espace</h1><form onsubmit="return false"><table class="t"><tr><td><label for="identifiant">Adresse e-mail</label></td><td><input id="identifiant" name="identifiant" type="text"></td></tr><tr><td><label for="mdp">Mot de passe</label></td><td><input id="mdp" name="motdepasse" type="password"></td></tr><tr><td></td><td><button>Se connecter</button></td></tr></table></form><p><a href="#">Mot de passe oublié ?</a> &middot; <a href="#">Créer un compte</a></p>`,
  state: { username: '#identifiant', password: '#mdp' },
  steps: [{ kind: 'signin', expected: [r('#identifiant', 'username'), r('#mdp', 'password')] }],
});

fx({
  id: 'language-de', category: cat, brand: 'Stadtwerke Grünwiesel', lang: 'de', theme: 'corp',
  description: 'German utility portal with name=benutzername and name=kennwort, labels Benutzername and Kennwort, Anmelden button and Passwort vergessen link.',
  title: 'Kundenportal Anmeldung',
  chromeTop: top('Stadtwerke Grünwiesel', ['Strom', 'Gas', 'Wasser', 'Kundenservice'], '<input id="suche" name="suchbegriff" placeholder="Suche" aria-label="Suche">'),
  chromeBottom: bottom('Impressum · Datenschutz · AGB'),
  main: `<div class="narrow box"><h1>Kundenportal</h1><form onsubmit="return false"><div class="row"><label for="bn">Benutzername</label><input id="bn" name="benutzername" type="text"></div><div class="row"><label for="kw">Kennwort</label><input id="kw" name="kennwort" type="password"></div><label style="font-weight:400"><input type="checkbox"> Angemeldet bleiben</label><p><button>Anmelden</button></p><p><a href="#">Passwort vergessen?</a></p></form></div>`,
  state: { username: '#bn', password: '#kw' },
  steps: [{ kind: 'signin', expected: [r('#bn', 'username'), r('#kw', 'password')], honeypots: ['#suche'] }],
});

fx({
  id: 'language-pt', category: cat, brand: 'Banco Sabiá', lang: 'pt-BR', theme: 'forest',
  description: 'Brazilian Portuguese sign-in with name=cpf as login (national ID number used as username) and name=senha, inside wrapped labels.',
  title: 'Acesse sua conta',
  chromeTop: top('Banco Sabiá', ['Conta', 'Cartões', 'Empréstimos']),
  chromeBottom: bottom('Banco Sabiá. Ouvidoria 0800 000 0000.'),
  main: `<form class="narrow box" onsubmit="return false"><h1>Acesse sua conta</h1><label class="lbl">CPF <input class="cpf" name="cpf" inputmode="numeric" style="display:block;width:100%;font-weight:400"></label><br><label class="lbl">Senha <input class="senha" name="senha" type="password" style="display:block;width:100%;font-weight:400"></label><p><button>Entrar</button> <a href="#">Esqueci minha senha</a></p></form>`,
  state: { username: 'input.cpf', password: 'input.senha' },
  steps: [{ kind: 'signin', expected: [r('input.cpf', 'username'), r('input.senha', 'password')] }],
});

fx({
  id: 'language-it', category: cat, brand: 'Ferramenta Lodola', lang: 'it', theme: 'sun',
  description: 'Italian sign-up with nome, cognome, email, parola d\'ordine and conferma, a mix of id-only inputs and name attributes in Italian.',
  title: 'Crea il tuo account',
  chromeTop: top('Ferramenta Lodola', ['Catalogo', 'Negozi', 'Accedi']),
  chromeBottom: bottom('© 2026 Ferramenta Lodola. Tutti i diritti riservati.'),
  main: `<form class="narrow box" onsubmit="return false"><h1>Crea il tuo account</h1><div class="row"><label for="nome">Nome</label><input id="nome" name="nome"></div><div class="row"><label for="cognome">Cognome</label><input id="cognome" name="cognome"></div><div class="row"><label for="posta">Indirizzo e-mail</label><input id="posta" name="posta_elettronica" type="email"></div><div class="row"><label for="pc1">Parola d'ordine</label><input id="pc1" name="parola_chiave" type="password"></div><div class="row"><label for="pc2">Conferma la parola d'ordine</label><input id="pc2" name="conferma_parola" type="password"></div><button>Registrati</button></form>`,
  state: { 'first-name': '#nome', 'last-name': '#cognome', username: '#posta', 'new-password': '#pc1', 'confirm-password': '#pc2' },
  steps: [{ kind: 'signup', expected: [r('#nome', 'first-name'), r('#cognome', 'last-name'), r('#posta', 'username'), r('#pc1', 'new-password'), r('#pc2', 'confirm-password')] }],
});

fx({
  id: 'language-nl', category: cat, brand: 'Gemeente Waterhoven', lang: 'nl', theme: 'slate',
  description: 'Dutch sign-in with names gebruikersnaam and wachtwoord, labels only via aria-label, and a Wachtwoord vergeten link.',
  title: 'Inloggen',
  chromeTop: top('Gemeente Waterhoven', ['Diensten', 'Afval', 'Contact'], '<input id="zoek" name="zoekterm" type="text" placeholder="Zoeken" aria-label="Zoeken">'),
  chromeBottom: bottom('Gemeente Waterhoven · Privacyverklaring · Toegankelijkheid'),
  main: `<div class="narrow box"><h1>Inloggen</h1><form onsubmit="return false"><div class="row"><input id="gn" name="gebruikersnaam" aria-label="Gebruikersnaam" placeholder="Gebruikersnaam"></div><div class="row"><input id="ww" name="wachtwoord" type="password" aria-label="Wachtwoord" placeholder="Wachtwoord"></div><button>Inloggen</button> <a href="#">Wachtwoord vergeten?</a></form></div>`,
  state: { username: '#gn', password: '#ww' },
  steps: [{ kind: 'signin', expected: [r('#gn', 'username'), r('#ww', 'password')], honeypots: ['#zoek'] }],
});

fx({
  id: 'language-ja', category: cat, brand: '北斗ストア', lang: 'ja', theme: 'corp',
  description: 'Japanese sign-in with labels メールアドレス and パスワード, the same words again as name attributes, and a ログイン submit.',
  title: 'ログイン',
  chromeTop: top('北斗ストア', ['商品一覧', 'お問い合わせ', '新規会員登録']),
  chromeBottom: bottom('© 2026 北斗ストア プライバシーポリシー'),
  main: `<div class="narrow box"><h1>ログイン</h1><form onsubmit="return false"><div class="row"><label for="j1">メールアドレス</label><input id="j1" name="メールアドレス" type="email"></div><div class="row"><label for="j2">パスワード</label><input id="j2" name="パスワード" type="password"></div><label style="font-weight:400"><input type="checkbox"> ログイン状態を保持する</label><p><button>ログイン</button></p><p><a href="#">パスワードをお忘れの方</a></p></form></div>`,
  state: { username: '#j1', password: '#j2' },
  steps: [{ kind: 'signin', expected: [r('#j1', 'username'), r('#j2', 'password')] }],
});

fx({
  id: 'language-zh', category: cat, brand: '青禾书店', lang: 'zh-CN', theme: 'paper',
  description: 'Simplified Chinese sign-in with no name attributes at all; placeholders 手机号/邮箱 and 密码, and a 忘记密码 link.',
  title: '登录',
  chromeTop: top('青禾书店', ['首页', '新书', '帮助中心'], '<input id="sou" type="search" placeholder="搜索图书" aria-label="搜索">'),
  chromeBottom: bottom('© 2026 青禾书店 隐私政策'),
  main: `<div class="narrow box"><h1>账号登录</h1><div class="zh-login"><div class="row"><input class="zh-a" type="text" placeholder="手机号/邮箱"></div><div class="row"><input class="zh-b" type="password" placeholder="密码"></div><button type="button">登录</button> <a href="#">忘记密码</a> <a href="#">立即注册</a></div></div>`,
  state: { username: '.zh-a', password: '.zh-b' },
  steps: [{ kind: 'signin', expected: [r('.zh-a', 'username'), r('.zh-b', 'password')], honeypots: ['#sou'] }],
});

fx({
  id: 'language-ko', category: cat, brand: '솔바람 쇼핑', lang: 'ko', theme: 'grape',
  description: 'Korean sign-up: 아이디, 비밀번호 and 비밀번호 확인 plus 이름 and 이메일, with Korean name attributes and neutral ids.',
  title: '회원가입',
  chromeTop: top('솔바람 쇼핑', ['베스트', '이벤트', '고객센터', '로그인']),
  chromeBottom: bottom('© 2026 솔바람 쇼핑. 개인정보처리방침'),
  main: `<form class="narrow box" onsubmit="return false"><h1>회원가입</h1><div class="row"><label for="k1">아이디</label><input id="k1" name="아이디"></div><div class="row"><label for="k2">비밀번호</label><input id="k2" name="비밀번호" type="password"></div><div class="row"><label for="k3">비밀번호 확인</label><input id="k3" name="비밀번호확인" type="password"></div><div class="row"><label for="k4">이름</label><input id="k4" name="이름"></div><div class="row"><label for="k5">이메일</label><input id="k5" name="이메일" type="email"></div><button>가입하기</button></form>`,
  state: { username: '#k1', 'new-password': '#k2', 'confirm-password': '#k3', 'full-name': '#k4', email: '#k5' },
  steps: [{ kind: 'signup', expected: [r('#k1', 'username'), r('#k2', 'new-password'), r('#k3', 'confirm-password'), r('#k4', 'full-name'), r('#k5', 'email')] }],
});

fx({
  id: 'language-ru', category: cat, brand: 'Ладья Банк', lang: 'ru', theme: 'slate',
  description: 'Russian sign-in with Cyrillic attribute names логин and пароль, labels Логин and Пароль, and a Забыли пароль link.',
  title: 'Вход в интернет-банк',
  chromeTop: top('Ладья Банк', ['Вклады', 'Кредиты', 'Карты', 'Поддержка']),
  chromeBottom: bottom('© 2026 Ладья Банк. Все права защищены.'),
  main: `<div class="narrow box"><h1>Вход в интернет-банк</h1><form onsubmit="return false"><div class="row"><label for="логин">Логин</label><input id="логин" name="логин"></div><div class="row"><label for="пароль">Пароль</label><input id="пароль" name="пароль" type="password"></div><label style="font-weight:400"><input type="checkbox"> Запомнить меня</label><p><button>Войти</button> <a href="#">Забыли пароль?</a></p></form></div>`,
  state: { username: 'input[name="логин"]', password: 'input[name="пароль"]' },
  steps: [{ kind: 'signin', expected: [r('input[name="логин"]', 'username'), r('input[name="пароль"]', 'password')] }],
});

fx({
  id: 'language-ar', category: cat, brand: 'سوق الواحة', lang: 'ar', dir: 'rtl', theme: 'sun',
  description: 'Arabic sign-in with dir=rtl, label text only in Arabic, no name attributes, and an email input with dir=ltr inside the RTL page.',
  title: 'تسجيل الدخول',
  chromeTop: top('سوق الواحة', ['العروض', 'الأقسام', 'اتصل بنا'], '<input id="bahth" type="search" placeholder="ابحث في المتجر" aria-label="بحث">'),
  chromeBottom: bottom('© 2026 سوق الواحة. جميع الحقوق محفوظة.'),
  main: `<form class="narrow box" onsubmit="return false"><h1>تسجيل الدخول</h1><div class="row"><label for="ar1">البريد الإلكتروني</label><input id="ar1" type="email" dir="ltr"></div><div class="row"><label for="ar2">كلمة المرور</label><input id="ar2" type="password"></div><label style="font-weight:400"><input type="checkbox"> تذكرني</label><p><button>دخول</button> <a href="#">هل نسيت كلمة المرور؟</a></p></form>`,
  state: { username: '#ar1', password: '#ar2' },
  steps: [{ kind: 'signin', expected: [r('#ar1', 'username'), r('#ar2', 'password')], honeypots: ['#bahth'] }],
});

fx({
  id: 'language-hi', category: cat, brand: 'गंगा सेवा पोर्टल', lang: 'hi', theme: 'forest',
  description: 'Hindi sign-in: labels उपयोगकर्ता नाम and पासवर्ड, Devanagari-only text with transliterated names upyogkarta and kutshabd.',
  title: 'लॉगिन करें',
  chromeTop: top('गंगा सेवा पोर्टल', ['सेवाएँ', 'सहायता', 'संपर्क']),
  chromeBottom: bottom('© 2026 गंगा सेवा पोर्टल। सर्वाधिकार सुरक्षित।'),
  main: `<div class="narrow box"><h1>लॉगिन करें</h1><form onsubmit="return false"><div class="row"><label for="hu">उपयोगकर्ता नाम</label><input id="hu" name="upyogkarta"></div><div class="row"><label for="hp">पासवर्ड</label><input id="hp" name="kutshabd" type="password"></div><button>लॉगिन</button> <a href="#">पासवर्ड भूल गए?</a></form></div>`,
  state: { username: '#hu', password: '#hp' },
  steps: [{ kind: 'signin', expected: [r('#hu', 'username'), r('#hp', 'password')] }],
});
