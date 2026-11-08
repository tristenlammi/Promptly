// Sign-in pages in other languages, mostly without autocomplete hints so the words matter.
import { doc, fxLive, step, x } from './kit.mjs';

export default [
  {
    id: 'h4-lang-01',
    category: 'language',
    description: 'French insurer customer area: "Identifiant" and "Mot de passe", no autocomplete hints, "Se souvenir de moi" tick.',
    steps: [step('signin', [x('#identifiant', 'username'), x('#motdepasse', 'password')])],
    html: doc({
      title: 'Espace client – Mutuelle Coquelicot',
      lang: 'fr',
      css: `
body{margin:0;font:15px "Marianne",Arial,sans-serif;background:#fff5f5;color:#3a0a0a}
.bandeau{background:#c0392b;color:#fff;padding:14px 32px;font-size:20px}
.bloc{width:420px;margin:50px auto;background:#fff;border:1px solid #f0caca;padding:28px}
.champ{margin-bottom:16px}.champ label{display:block;font-weight:bold;margin-bottom:4px}
.champ input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #b88}
.btn{background:#c0392b;color:#fff;border:0;padding:10px 22px}`,
      body: `
<div class="bandeau">Mutuelle Coquelicot</div>
<div class="bloc">
  <h1 style="font-size:22px">Accéder à mon espace</h1>
  <form action="#" method="post" onsubmit="return false">
    <div class="champ"><label for="identifiant">Identifiant</label><input id="identifiant" name="identifiant" type="text"><small>Votre numéro d'adhérent ou votre adresse e-mail</small></div>
    <div class="champ"><label for="motdepasse">Mot de passe</label><input id="motdepasse" name="mdp" type="password"></div>
    <label><input type="checkbox" name="souvenir"> Se souvenir de moi</label>
    <p><button class="btn" type="submit">Se connecter</button></p>
    <a href="#">Mot de passe oublié ?</a> · <a href="#">Première connexion</a>
  </form>
</div>`,
      js: fxLive({ username: '#identifiant', password: '#motdepasse' }),
    }),
  },

  {
    id: 'h4-lang-02',
    category: 'language',
    description: 'Spanish marketplace: "Correo electrónico" and "Contraseña" with "Iniciar sesión", a product search box in the header.',
    steps: [step('signin', [x('input[name="correo"]', 'username'), x('input[name="clave"]', 'password')], ['#buscar'])],
    html: doc({
      title: 'Iniciar sesión | Mercadillo Azul',
      lang: 'es',
      css: `
body{margin:0;font:15px Helvetica,sans-serif;background:#eef4fb}
header{background:#1565c0;padding:12px 30px;display:flex;gap:20px;align-items:center;color:#fff}
header input{flex:1;padding:8px;border:0;border-radius:4px}
.caja{width:380px;margin:50px auto;background:#fff;border-radius:8px;padding:28px}
.caja label{display:block;margin:12px 0 4px;font-size:14px}
.caja input[type=email],.caja input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #9bb5d6;border-radius:6px}
.boton{margin-top:18px;width:100%;padding:11px;background:#1565c0;color:#fff;border:0;border-radius:6px}`,
      body: `
<header><b>Mercadillo Azul</b><input type="search" id="buscar" placeholder="Buscar productos, marcas y más…"></header>
<div class="caja">
  <h1 style="font-size:21px">¡Hola! Ingresa tu correo y contraseña</h1>
  <form action="#" onsubmit="return false">
    <label>Correo electrónico<input type="email" name="correo"></label>
    <label>Contraseña<input type="password" name="clave"></label>
    <button class="boton" type="submit">Iniciar sesión</button>
  </form>
  <p><a href="#">¿Olvidaste tu contraseña?</a><br><a href="#">Crear cuenta</a></p>
</div>`,
      js: fxLive({ username: 'input[name="correo"]', password: 'input[name="clave"]' }),
    }),
  },

  {
    id: 'h4-lang-03',
    category: 'language',
    description: 'German utility customer portal: "Benutzername" and "Kennwort", "Angemeldet bleiben", labels in a definition-list layout.',
    steps: [step('signin', [x('#feld-benutzer', 'username'), x('#feld-kennwort', 'password')])],
    html: doc({
      title: 'Kundenportal – Stadtwerke Lindenau',
      lang: 'de',
      css: `
body{margin:0;font:15px "Frutiger",Arial,sans-serif;background:#f3f6f3;color:#1d2b1d}
.kopf{background:#2e7d32;color:#fff;padding:14px 32px}
.inhalt{width:460px;margin:40px auto;background:#fff;padding:26px;border:1px solid #cfdccf}
dl{display:grid;grid-template-columns:140px 1fr;gap:10px 12px;align-items:center}
dd{margin:0}dd input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #9ab09a}
.knopf{background:#2e7d32;color:#fff;border:0;padding:9px 20px}`,
      body: `
<div class="kopf">Stadtwerke Lindenau · Kundenportal</div>
<div class="inhalt">
  <h1 style="font-size:21px">Anmeldung</h1>
  <p>Melden Sie sich an, um Zählerstände zu melden und Rechnungen einzusehen.</p>
  <form action="#" onsubmit="return false">
    <dl>
      <dt><label for="feld-benutzer">Benutzername</label></dt><dd><input id="feld-benutzer" name="benutzer" type="text"></dd>
      <dt><label for="feld-kennwort">Kennwort</label></dt><dd><input id="feld-kennwort" name="kennwort" type="password"></dd>
    </dl>
    <label><input type="checkbox" name="angemeldetBleiben"> Angemeldet bleiben</label>
    <p><button class="knopf" type="submit">Anmelden</button> <a href="#">Kennwort vergessen?</a></p>
  </form>
</div>`,
      js: fxLive({ username: '#feld-benutzer', password: '#feld-kennwort' }),
    }),
  },

  {
    id: 'h4-lang-04',
    category: 'language',
    description: 'Japanese online bookshop: "メールアドレス" and "パスワード", "ログイン状態を保持する", and a keyword search in the header.',
    steps: [step('signin', [x('input[name="mail"]', 'username'), x('input[name="pass"]', 'password')], ['#kw'])],
    html: doc({
      title: 'ログイン｜さくら書房オンライン',
      lang: 'ja',
      css: `
body{margin:0;font:14px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif;background:#fff;color:#333}
header{display:flex;gap:16px;align-items:center;padding:10px 24px;border-bottom:2px solid #e8a0b4}
header input{width:300px;padding:6px}
.login{width:420px;margin:40px auto;border:1px solid #ddd;padding:24px}
table{width:100%}th{text-align:left;width:120px;font-weight:normal}
td input{width:100%;box-sizing:border-box;padding:7px;border:1px solid #bbb}
.btn{display:block;width:100%;margin-top:16px;padding:10px;background:#d6336c;color:#fff;border:0}`,
      body: `
<header><b>さくら書房</b><input type="text" id="kw" name="keyword" placeholder="キーワードで探す"><a href="#">カート</a></header>
<div class="login">
  <h1 style="font-size:18px">ログイン</h1>
  <form action="#" method="post" onsubmit="return false">
    <table>
      <tr><th>メールアドレス</th><td><input type="text" name="mail"></td></tr>
      <tr><th>パスワード</th><td><input type="password" name="pass"></td></tr>
    </table>
    <label><input type="checkbox" name="keep"> ログイン状態を保持する</label>
    <button class="btn" type="submit">ログイン</button>
  </form>
  <p><a href="#">パスワードをお忘れの方</a>｜<a href="#">新規会員登録</a></p>
</div>`,
      js: fxLive({ username: 'input[name="mail"]', password: 'input[name="pass"]' }),
    }),
  },

  {
    id: 'h4-lang-05',
    category: 'language',
    description: 'Brazilian Portuguese store: "CPF ou e-mail" as the identifier, "Senha", "Entrar" and "Esqueci minha senha".',
    steps: [step('signin', [x('#login-cpf-email', 'username'), x('#login-senha', 'password')])],
    html: doc({
      title: 'Entrar – Loja Jabuticaba',
      lang: 'pt-BR',
      css: `
body{margin:0;font:15px "Open Sans",sans-serif;background:#f6f0fa;color:#2d1b3d}
.topo{background:#5e2b7e;color:#fff;padding:14px 30px}
.cartao{width:380px;margin:50px auto;background:#fff;border-radius:10px;padding:26px}
.campo{margin-bottom:14px}.campo label{display:block;font-size:13px;margin-bottom:4px}
.campo input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c7a8dc;border-radius:6px}
.entrar{width:100%;padding:11px;background:#5e2b7e;color:#fff;border:0;border-radius:6px}`,
      body: `
<div class="topo">Loja Jabuticaba</div>
<div class="cartao">
  <h1 style="font-size:20px">Acesse sua conta</h1>
  <form action="#" onsubmit="return false">
    <div class="campo"><label for="login-cpf-email">CPF ou e-mail</label><input id="login-cpf-email" name="login" type="text"></div>
    <div class="campo"><label for="login-senha">Senha</label><input id="login-senha" name="senha" type="password"></div>
    <button class="entrar" type="submit">Entrar</button>
  </form>
  <p><a href="#">Esqueci minha senha</a> · <a href="#">Criar conta</a></p>
</div>`,
      js: fxLive({ username: '#login-cpf-email', password: '#login-senha' }),
    }),
  },
];
