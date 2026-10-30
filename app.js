// InfoBrasil \u2014 servidor \u00fanico (Node 18+, sem depend\u00eancias).
// Vari\u00e1veis de ambiente opcionais no Render:
//   TURNSTILE_SITEKEY / TURNSTILE_SECRET  -> captcha gr\u00e1tis (Cloudflare Turnstile)
//   ADSENSE_CLIENT (ca-pub-XXXXXXXXXXXXXXXX) / ADSENSE_SLOT -> an\u00fancios (Google AdSense)
const http = require('http');

const PORT = process.env.PORT || 3000;
const SITEKEY = process.env.TURNSTILE_SITEKEY || '';
const SECRET = process.env.TURNSTILE_SECRET || '';
const ADS_CLIENT = process.env.ADSENSE_CLIENT || '';
const ADS_SLOT = process.env.ADSENSE_SLOT || '';

const TSE = 'https://divulgacandcontas.tse.jus.br/divulga/rest/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; InfoBrasil/1.0)', Accept: 'application/json,text/html;q=0.9' };
const HORA = 36e5;

const erro = (status, msg) => Object.assign(new Error(msg), { status });

async function getJSON(url) {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { upstream: r.status });
    return r.json();
}

const cache = new Map();
async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && c.exp > Date.now()) return c.val;
    const val = await fn();
    cache.set(key, { val, exp: Date.now() + ttl });
    return val;
}

// ---------- TSE (DivulgaCandContas) ----------
const CARGOS = { presidente: 1, governador: 3, senador: 5, prefeito: 11 };
const NOMES = { presidente: 'Presidente', governador: 'Governador', senador: 'Senador', prefeito: 'Prefeito' };

async function eleicoesDoAno(ano) {
    const lista = await cached('ordinarias', 6 * HORA, () => getJSON(TSE + '/eleicao/ordinarias'));
    return lista.filter((e) => String(e.ano) === String(ano)).map((e) => String(e.codigo || e.id));
}

async function candidato(q) {
    const cargo = q.get('cargo');
    const ano = (q.get('ano') || '').trim();
    const numero = (q.get('numero') || '').trim();
    const uf = (q.get('uf') || '').toUpperCase();
    const mun = (q.get('municipio') || '').trim();
    if (!CARGOS[cargo] || !/^\d{4}$/.test(ano) || !/^\d{2,5}$/.test(numero)) {
        throw erro(400, 'Informe o cargo, o ano (4 d\u00edgitos) e o n\u00famero do candidato.');
    }
    const ue = cargo === 'presidente' ? 'BR' : cargo === 'prefeito' ? mun : uf;
    if (!/^[A-Z0-9]{2,6}$/.test(ue)) throw erro(400, 'Escolha o estado e, para prefeito, o munic\u00edpio.');

    for (const cod of await eleicoesDoAno(ano)) {
        let lista;
        try {
            lista = await getJSON(`${TSE}/candidatura/listar/${ano}/${ue}/${cod}/${CARGOS[cargo]}/candidatos`);
        } catch { continue; }
        const achados = (lista.candidatos || []).filter((c) => String(c.numero) === numero);
        if (!achados.length) continue;
        const c = achados.find((x) => /^eleito/i.test(x.descricaoTotalizacao || '')) || achados[0];
        const d = await getJSON(`${TSE}/candidatura/buscar/${ano}/${ue}/${cod}/candidato/${c.id}`).catch(() => ({}));
        const p = d.partido || c.partido || {};
        const foto = d.fotoUrl || `${TSE.replace('/v1', '')}/arquivo/img/${cod}/${c.id}/${ue}`;
        return {
            nome: d.nomeCompleto || c.nomeCompleto,
            urna: d.nomeUrna || c.nomeUrna,
            numero,
            cargo: NOMES[cargo],
            ano,
            ue,
            partido: p.sigla || '',
            partidoNome: p.nome || '',
            situacao: d.descricaoTotalizacao || c.descricaoTotalizacao || '',
            registro: d.descricaoSituacao || c.descricaoSituacao || '',
            foto: '/api/foto?u=' + encodeURIComponent(foto),
        };
    }
    throw erro(404, 'Nenhum candidato encontrado com esse n\u00famero, cargo e ano. Confira os dados.');
}

async function municipios(uf, ano) {
    if (!/^[A-Za-z]{2}$/.test(uf || '')) throw erro(400, 'UF inv\u00e1lida.');
    return cached('mun' + uf + ano, 24 * HORA, async () => {
        for (const cod of await eleicoesDoAno(ano)) {
            try {
                const d = await getJSON(`${TSE}/eleicao/buscar/${uf.toUpperCase()}/${cod}/municipios`);
                const l = (d.municipios || []).map((m) => ({ codigo: m.codigo, nome: m.nome }));
                if (l.length) return l;
            } catch { /* tenta a pr\u00f3xima elei\u00e7\u00e3o do ano */ }
        }
        throw erro(404, 'Munic\u00edpios n\u00e3o encontrados para esse ano.');
    });
}

async function foto(u) {
    const url = new URL(u);
    if (!/(^|\.)tse\.jus\.br$/.test(url.hostname)) throw erro(400, 'Origem n\u00e3o permitida.');
    url.protocol = 'https:';
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw erro(404, 'Foto indispon\u00edvel.');
    return { tipo: r.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await r.arrayBuffer()) };
}

// ---------- CNPJ (BrasilAPI, dados da Receita Federal) ----------
async function cnpj(raw) {
    // aceita tamb\u00e9m o CNPJ alfanum\u00e9rico (14 caracteres)
    const id = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (id.length !== 14) throw erro(400, 'O CNPJ precisa ter 14 caracteres.');
    try {
        const d = await getJSON('https://brasilapi.com.br/api/cnpj/v1/' + id);
        return {
            existe: true,
            cnpj: id,
            razaoSocial: d.razao_social,
            fantasia: d.nome_fantasia,
            situacao: d.descricao_situacao_cadastral,
            desde: d.data_situacao_cadastral,
            motivo: d.descricao_motivo_situacao_cadastral,
            situacaoEspecial: d.situacao_especial,
            abertura: d.data_inicio_atividade,
            atividade: d.cnae_fiscal_descricao,
            natureza: d.natureza_juridica,
            porte: d.porte,
            capital: d.capital_social,
            local: [d.municipio, d.uf].filter(Boolean).join(' / '),
            tipo: d.descricao_identificador_matriz_filial,
        };
    } catch (e) {
        if (e.upstream === 404 || e.upstream === 400) return { existe: false, cnpj: id };
        throw e;
    }
}

// ---------- Ex\u00e9rcito (l\u00ea a descri\u00e7\u00e3o das p\u00e1ginas oficiais; usa texto de reserva se falhar) ----------
const EB = [
    ['Alistamento militar', 'https://alistamento.eb.mil.br/', 'Alistamento online, prazos e documentos do servi\u00e7o militar obrigat\u00f3rio.'],
    ['Ingresso e recrutamento', 'https://www.eb.mil.br/', 'Formas de ingresso na carreira, servi\u00e7o tempor\u00e1rio, col\u00e9gios militares e concursos.'],
    ['Oficiais de carreira (EsPCEx)', 'https://www.espcex.eb.mil.br/', 'Escola Preparat\u00f3ria de Cadetes do Ex\u00e9rcito, porta de entrada para a forma\u00e7\u00e3o de oficiais.'],
    ['Sargentos (ESA)', 'https://www.esa.eb.mil.br/', 'Escola de Sargentos das Armas: forma\u00e7\u00e3o de sargentos de carreira.'],
    ['Engenharia militar (IME)', 'https://www.ime.eb.mil.br/', 'Instituto Militar de Engenharia: forma\u00e7\u00e3o de engenheiros militares.'],
];

const limpa = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function metaDesc(h) {
    for (const t of h.match(/<meta\b[^>]*>/gi) || []) {
        if (/(name|property)\s*=\s*["'](og:)?description["']/i.test(t)) {
            const m = t.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
            if (m) return limpa(m[1] || m[2] || '');
        }
    }
    return '';
}

const exercito = () => Promise.all(EB.map(async ([titulo, url, texto]) => {
    let descricao = texto, aoVivo = false;
    try {
        const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        const b = Buffer.from(await r.arrayBuffer());
        let h = b.toString('utf8');
        if (h.includes('\uFFFD')) h = b.toString('latin1');
        const d = metaDesc(h);
        if (r.ok && d.length > 30) { descricao = d.slice(0, 280); aoVivo = true; }
    } catch { /* usa o texto de reserva */ }
    return { titulo, url, descricao, aoVivo };
}));

// ---------- Captcha e limite de uso ----------
async function captchaOk(token, ip) {
    if (!SECRET) return true; // sem chave configurada, o captcha fica desligado
    if (!token) return false;
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: SECRET, response: token, remoteip: ip }),
    });
    return (await r.json()).success === true;
}

const hits = new Map();
function limitado(ip) {
    const agora = Date.now();
    const a = (hits.get(ip) || []).filter((t) => agora - t < 60000);
    a.push(agora);
    hits.set(ip, a);
    return a.length > 30;
}

// Remove da memoria os IPs inativos, para a lista nao crescer sem parar.
setInterval(() => {
    const agora = Date.now();
    for (const [ip, t] of hits) if (!t.some((x) => agora - x < 60000)) hits.delete(ip);
}, 60000).unref();

// IP real do visitante. No Render o trafego passa pelo Cloudflare, que escreve o
// cabecalho CF-Connecting-IP e ignora o valor que o visitante tentar enviar.
// O X-Forwarded-For NAO e usado: o visitante consegue escrever nele e fingir ser outro IP.
const ipDe = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').trim();

// ---------- P\u00e1gina ----------
const cap = () => (SITEKEY ? '<div class="cf-turnstile" data-sitekey="' + SITEKEY + '"></div>' : '');

function pagina() {
    const adsHead = ADS_CLIENT
        ? '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADS_CLIENT + '" crossorigin="anonymous"></script>'
        : '';
    const tsHead = SITEKEY ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '';
    const adUnit = ADS_CLIENT && ADS_SLOT
        ? '<ins class="adsbygoogle" style="display:block" data-ad-client="' + ADS_CLIENT + '" data-ad-slot="' + ADS_SLOT + '" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>'
        : '<!-- An\u00fancio: defina ADSENSE_CLIENT e ADSENSE_SLOT no Render -->';

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InfoBrasil \u2014 consultas em fontes oficiais</title>
<meta name="description" content="Ex\u00e9rcito Brasileiro, candidatos e CNPJ com dados de fontes oficiais.">
${adsHead}
${tsHead}
<style>
:root{--ink:#10283a;--verde:#007a3d;--amarelo:#ffcc00;--azul:#1b3f94;--papel:#eef3ef;--linha:#cfdad2;--mudo:#4a5f6e}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--papel);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{background:var(--verde);border-bottom:6px solid var(--amarelo);padding:18px 16px;display:flex;align-items:center;justify-content:center;gap:14px;color:#fff}
.top svg{width:66px;height:auto;box-shadow:0 0 0 2px #fff;border-radius:3px}
.top h1{margin:0;font:700 clamp(32px,7vw,46px)/1 Georgia,"Times New Roman",serif;letter-spacing:.5px}
main{max-width:760px;margin:0 auto;padding:22px 16px 20px}
.lead{margin:0 0 18px;font-size:18px}
.tile{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--linha);border-left:10px solid var(--c);border-radius:6px;padding:18px;margin-bottom:14px;cursor:pointer;font:inherit;color:inherit}
.tile b{display:block;font:700 22px Georgia,serif}
.tile span{color:var(--mudo)}
.tile:hover{background:#f8fbf8}
.t-eb{--c:var(--verde)}.t-gov{--c:var(--azul)}.t-cnpj{--c:var(--amarelo)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--azul);outline-offset:2px}
.voltar{background:none;border:0;color:var(--azul);font:inherit;font-weight:700;cursor:pointer;padding:6px 0;margin-bottom:6px}
h2{font:700 28px Georgia,serif;margin:4px 0 14px}
form{background:#fff;border:1px solid var(--linha);border-radius:6px;padding:16px;display:grid;gap:12px}
label{display:grid;gap:4px;font-weight:600;font-size:14px}
input,select{font:inherit;padding:10px;border:1px solid #9fb2a6;border-radius:4px;background:#fff;color:inherit;width:100%}
.go{background:var(--verde);color:#fff;border:0;border-radius:4px;padding:12px;font:700 16px system-ui,sans-serif;cursor:pointer}
.go:disabled{opacity:.6;cursor:wait}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:520px){.row{grid-template-columns:1fr}.res.cand{flex-direction:column}}
.res{margin-top:16px;background:#fff;border:1px solid var(--linha);border-radius:6px;padding:16px}
.res.cand{display:flex;gap:16px}
.res img{width:120px;height:160px;object-fit:cover;border-radius:4px;background:#dfe7e1;flex:none}
.res h3{margin:0 0 8px;font:700 21px Georgia,serif}
dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}
dt{color:var(--mudo)}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.badge{display:inline-block;padding:4px 12px;border-radius:99px;font-weight:700;margin-bottom:10px}
.ok{background:#d8f1e0;color:#0b5a2b}.bad{background:#fde0dc;color:#8a1c10}
.msg{margin-top:12px;padding:12px;border-radius:4px;background:#fde0dc;color:#8a1c10}
.nota{font-size:14px;color:var(--mudo);margin:12px 0 0}
.card{background:#fff;border:1px solid var(--linha);border-left:6px solid var(--verde);border-radius:6px;padding:14px 16px;margin-bottom:12px}
.card h3{margin:0 0 4px;font:700 19px Georgia,serif}
.card p{margin:0 0 8px}
.ad{max-width:760px;margin:0 auto;padding:0 16px 30px}
footer{text-align:center;color:var(--mudo);font-size:13px;padding:0 16px 30px}
</style>
</head>
<body>
<header class="top">
  <svg viewBox="0 0 72 50" role="img" aria-label="Bandeira do Brasil"><rect width="72" height="50" fill="#009c3b"/><polygon points="36,5 67,25 36,45 5,25" fill="#ffdf00"/><circle cx="36" cy="25" r="10.5" fill="#002776"/><path d="M26 22.5Q36 18 46 24" stroke="#fff" stroke-width="2" fill="none"/></svg>
  <h1>InfoBrasil</h1>
</header>

<main>
  <section id="v-home">
    <p class="lead">Consulte dados p\u00fablicos direto de fontes oficiais.</p>
    <button class="tile t-eb" data-go="eb"><b>Ex\u00e9rcito Brasileiro</b><span>Alistamento, ingresso e forma\u00e7\u00e3o</span></button>
    <button class="tile t-gov" data-go="gov"><b>Governo</b><span>Presidente, governador, senador e prefeito</span></button>
    <button class="tile t-cnpj" data-go="cnpj"><b>CNPJ</b><span>Se existe, situa\u00e7\u00e3o cadastral e dados da empresa</span></button>
  </section>

  <section id="v-eb" hidden>
    <button class="voltar" data-go="home">&larr; Voltar</button>
    <h2>Ex\u00e9rcito Brasileiro</h2>
    <p class="nota" style="margin:0 0 14px">Conte\u00fado lido dos sites oficiais do Ex\u00e9rcito. O \u00fanico endere\u00e7o oficial de alistamento \u00e9 alistamento.eb.mil.br; desconfie de sites que cobram taxa.</p>
    <div id="eb-list"></div>
  </section>

  <section id="v-gov" hidden>
    <button class="voltar" data-go="home">&larr; Voltar</button>
    <h2>Governo</h2>
    <form id="gov">
      <label>Cargo
        <select name="cargo" required>
          <option value="presidente">Presidente</option>
          <option value="governador">Governador</option>
          <option value="senador">Senador</option>
          <option value="prefeito">Prefeito</option>
        </select>
      </label>
      <div class="row">
        <label>Ano da elei\u00e7\u00e3o <input name="ano" type="number" inputmode="numeric" min="1998" max="2030" placeholder="2022" required></label>
        <label>N\u00famero do candidato <input name="numero" inputmode="numeric" maxlength="5" placeholder="13" required></label>
      </div>
      <label id="f-uf" hidden>Estado <select name="uf"><option value="">Escolha\u2026</option></select></label>
      <label id="f-mun" hidden>Munic\u00edpio <input name="municipio" list="mun-list" autocomplete="off" placeholder="Digite o nome da cidade"><datalist id="mun-list"></datalist></label>
      ${cap()}
      <button class="go" type="submit">Consultar candidato</button>
    </form>
    <div id="gov-out"></div>
    <p class="nota">Fonte: Tribunal Superior Eleitoral (DivulgaCandContas). Presidente usa o n\u00famero nacional; os demais cargos dependem do estado ou munic\u00edpio.</p>
  </section>

  <section id="v-cnpj" hidden>
    <button class="voltar" data-go="home">&larr; Voltar</button>
    <h2>Consulta de CNPJ</h2>
    <form id="cnpj">
      <label>CNPJ <input name="doc" inputmode="text" maxlength="18" placeholder="00.000.000/0000-00" required></label>
      ${cap()}
      <button class="go" type="submit">Consultar CNPJ</button>
    </form>
    <div id="cnpj-out"></div>
    <p class="nota">Fonte: cadastro da Receita Federal, via BrasilAPI.</p>
  </section>
</main>

<aside class="ad">${adUnit}</aside>
<footer>InfoBrasil n\u00e3o \u00e9 um site do governo. Os dados v\u00eam de fontes p\u00fablicas oficiais e podem ter atraso.</footer>

<script>
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var VIEWS = ['home', 'eb', 'gov', 'cnpj'], ebLoaded = false, MUN = [];

  function go(v) {
    VIEWS.forEach(function (x) { $('#v-' + x).hidden = x !== v; });
    if (v === 'eb') loadEB();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-go]');
    if (b) go(b.dataset.go);
  });

  function el(t, c, x) {
    var n = document.createElement(t);
    if (c) n.className = c;
    if (x != null) n.textContent = x;
    return n;
  }
  function dl(pairs) {
    var d = el('dl');
    pairs.forEach(function (p) { if (p[1]) d.append(el('dt', null, p[0]), el('dd', null, p[1])); });
    return d;
  }
  function dt(s) { return s && /^\\d{4}-\\d\\d-\\d\\d/.test(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : (s || ''); }
  function brl(v) { return v == null || v === '' ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

  async function api(path, form) {
    var h = {}, t = form && form.querySelector('[name="cf-turnstile-response"]');
    if (t) h['x-captcha'] = t.value;
    var r = await fetch(path, { headers: h });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.erro || 'Erro na consulta.');
    return d;
  }

  async function submit(form, out, run) {
    var btn = form.querySelector('.go');
    out.replaceChildren();
    btn.disabled = true;
    try { out.append(await run()); }
    catch (e) { out.append(el('div', 'msg', e.message)); }
    btn.disabled = false;
    var w = form.querySelector('.cf-turnstile');
    if (w && window.turnstile) window.turnstile.reset(w);
  }

  // ----- Ex\u00e9rcito -----
  async function loadEB() {
    if (ebLoaded) return;
    var box = $('#eb-list');
    box.textContent = 'Carregando\u2026';
    try {
      var lista = await api('/api/exercito');
      box.replaceChildren();
      lista.forEach(function (i) {
        var c = el('div', 'card');
        var a = el('a', null, 'Abrir site oficial');
        a.href = i.url; a.target = '_blank'; a.rel = 'noopener';
        c.append(el('h3', null, i.titulo), el('p', null, i.descricao), a);
        box.append(c);
      });
      ebLoaded = true;
    } catch (e) { box.replaceChildren(el('div', 'msg', e.message)); }
  }

  // ----- Governo -----
  var g = $('#gov');
  'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').forEach(function (u) {
    var o = el('option', null, u); o.value = u; g.uf.append(o);
  });
  async function loadMun() {
    MUN = [];
    $('#mun-list').replaceChildren();
    if (g.cargo.value !== 'prefeito' || !g.uf.value || !/^\\d{4}$/.test(g.ano.value)) return;
    try {
      MUN = await api('/api/municipios?uf=' + g.uf.value + '&ano=' + g.ano.value);
      MUN.forEach(function (m) { var o = el('option'); o.value = m.nome; $('#mun-list').append(o); });
    } catch (e) { /* o erro aparece ao consultar */ }
  }
  function syncGov() {
    var c = g.cargo.value;
    $('#f-uf').hidden = c === 'presidente';
    $('#f-mun').hidden = c !== 'prefeito';
    loadMun();
  }
  g.cargo.onchange = syncGov; g.uf.onchange = loadMun; g.ano.onchange = loadMun;

  g.onsubmit = function (e) {
    e.preventDefault();
    submit(g, $('#gov-out'), async function () {
      var c = g.cargo.value;
      var q = 'cargo=' + c + '&ano=' + g.ano.value + '&numero=' + encodeURIComponent(g.numero.value);
      if (c !== 'presidente') q += '&uf=' + g.uf.value;
      if (c === 'prefeito') {
        var n = g.municipio.value.trim().toLowerCase();
        var m = MUN.find(function (x) { return x.nome.toLowerCase() === n; });
        if (!m) throw new Error('Escolha o munic\u00edpio na lista de sugest\u00f5es.');
        q += '&municipio=' + m.codigo;
      }
      var d = await api('/api/candidato?' + q, g);
      var box = el('div', 'res cand'), info = el('div');
      var img = el('img');
      img.src = d.foto; img.alt = 'Foto de ' + d.urna;
      img.onerror = function () { img.remove(); };
      info.append(el('h3', null, d.nome), dl([
        ['Nome na urna', d.urna],
        ['N\u00famero', d.numero],
        ['Partido', d.partido + (d.partidoNome ? ' \u2014 ' + d.partidoNome : '')],
        ['Cargo', d.cargo + ' (' + d.ano + ')'],
        ['Resultado', d.situacao],
        ['Registro', d.registro]
      ]));
      box.append(img, info);
      return box;
    });
  };

  // ----- CNPJ -----
  var f = $('#cnpj');
  f.onsubmit = function (e) {
    e.preventDefault();
    submit(f, $('#cnpj-out'), async function () {
      var d = await api('/api/cnpj?n=' + encodeURIComponent(f.doc.value), f);
      var box = el('div', 'res');
      if (!d.existe) {
        box.append(el('span', 'badge bad', 'CNPJ n\u00e3o encontrado'), el('p', null, 'N\u00e3o h\u00e1 empresa com esse n\u00famero na base da Receita Federal. Confira os d\u00edgitos.'));
        return box;
      }
      var ativa = /^ativa$/i.test(d.situacao || '');
      box.append(el('span', 'badge ' + (ativa ? 'ok' : 'bad'), 'Situa\u00e7\u00e3o: ' + d.situacao), el('h3', null, d.razaoSocial));
      box.append(dl([
        ['Nome fantasia', d.fantasia],
        ['CNPJ', d.cnpj],
        ['Situa\u00e7\u00e3o desde', dt(d.desde)],
        ['Motivo', d.motivo && !/sem motivo/i.test(d.motivo) ? d.motivo : ''],
        ['Situa\u00e7\u00e3o especial', d.situacaoEspecial],
        ['Abertura', dt(d.abertura)],
        ['Tipo', d.tipo],
        ['Atividade principal', d.atividade],
        ['Natureza jur\u00eddica', d.natureza],
        ['Porte', d.porte],
        ['Capital social', brl(d.capital)],
        ['Local', d.local]
      ]));
      if (!ativa) box.append(el('div', 'msg', 'Aten\u00e7\u00e3o: a empresa n\u00e3o est\u00e1 com situa\u00e7\u00e3o ativa na Receita Federal.'));
      var n = el('p', 'nota', 'D\u00edvidas e pend\u00eancias fiscais n\u00e3o aparecem nesta consulta. Para saber se h\u00e1 d\u00e9bitos, emita a certid\u00e3o oficial: ');
      var a = el('a', null, 'Certid\u00e3o da Receita Federal e PGFN');
      a.href = 'https://solucoes.receita.fazenda.gov.br/Servicos/certidaointernet/PJ/Emitir'; a.target = '_blank'; a.rel = 'noopener';
      n.append(a);
      box.append(n);
      return box;
    });
  };
})();
</script>
</body>
</html>`;
}

// ---------- Servidor ----------
function enviar(res, status, body, tipo) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': tipo || 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
}

http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const ip = ipDe(req);
    try {
        if (u.pathname === '/') return enviar(res, 200, pagina(), 'text/html; charset=utf-8');
        if (u.pathname === '/healthz') return enviar(res, 200, 'ok', 'text/plain');
        if (u.pathname.startsWith('/api/')) {
            if (limitado(ip)) throw erro(429, 'Muitas consultas seguidas. Espere um minuto.');
            const q = u.searchParams;
            if (u.pathname === '/api/exercito') return enviar(res, 200, await cached('eb', 6 * HORA, exercito));
            if (u.pathname === '/api/municipios') return enviar(res, 200, await municipios(q.get('uf'), q.get('ano')));
            if (u.pathname === '/api/foto') {
                const f = await foto(q.get('u'));
                return enviar(res, 200, f.buf, f.tipo);
            }
            if (u.pathname === '/api/candidato' || u.pathname === '/api/cnpj') {
                if (!(await captchaOk(req.headers['x-captcha'], ip))) throw erro(403, 'Confirme o captcha antes de consultar.');
                return enviar(res, 200, u.pathname === '/api/cnpj' ? await cnpj(q.get('n')) : await candidato(q));
            }
        }
        enviar(res, 404, { erro: 'P\u00e1gina n\u00e3o encontrada.' });
    } catch (e) {
        console.error(u.pathname, e.message);
        enviar(res, e.status || 502, { erro: e.status ? e.message : 'A fonte oficial n\u00e3o respondeu agora. Tente de novo em instantes.' });
    }
}).listen(PORT, () => console.log('InfoBrasil rodando na porta ' + PORT));