/**
 * POLÍTICAS IA — legal-pages engine
 * ------------------------------------------------------------------
 * Brief (business inputs) → BYOK LLM → strict JSON of THREE coherent
 * documents (Política de Privacidade LGPD, Termos de Uso, Política de
 * Cookies) → rendered as publish-ready "Diário Oficial" sheets →
 * export as self-contained HTML + print-to-PDF + copy + localStorage
 * library. BYOK only; no company key; browser talks to no backend
 * except the shared n8n gate (loaded elsewhere).
 */
(function () {
  'use strict';

  var STORAGE_PREFIX = 'politicas-ia_';
  var LIB_STORE = STORAGE_PREFIX + 'library_v1';

  var DOCS = ['privacidade', 'termos', 'cookies'];
  var DOC_LABEL = { privacidade: 'Política de Privacidade', termos: 'Termos de Uso', cookies: 'Política de Cookies' };
  var DOC_KICKER = { privacidade: 'PROTEÇÃO DE DADOS · LGPD', termos: 'CONDIÇÕES DE USO', cookies: 'RASTREAMENTO E COOKIES' };

  var current = null;      // { privacidade:{...}, termos:{...}, cookies:{...}, brief:{...}, ts }
  var activeDoc = 'privacidade';
  var wired = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // COR-015: normalize LLM null-like strings to empty
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }

  function todayBR() {
    var d = new Date();
    var mm = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    return d.getDate() + ' de ' + mm[d.getMonth()] + ' de ' + d.getFullYear();
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 250); }, 2600);
  }

  // ================= chips =================
  function initChips(groupId) {
    var g = $(groupId);
    if (!g) return;
    var single = g.getAttribute('data-single');
    g.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (single) { g.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); }); chip.classList.add('active'); }
        else { chip.classList.toggle('active'); }
      });
    });
  }
  function chipsValues(groupId) {
    var g = $(groupId); if (!g) return [];
    return Array.prototype.map.call(g.querySelectorAll('.chip.active'), function (c) { return c.getAttribute('data-v'); });
  }
  function chipSingle(groupId) { var v = chipsValues(groupId); return v[0] || ''; }

  // ================= LLM =================
  function friendlyHttp(status, txt) {
    var detail = '';
    try { var j = JSON.parse(txt); detail = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
    if (status === 401) return 'Chave de API inválida ou ausente. Verifique sua chave BYOK.';
    if (status === 402) return 'Créditos insuficientes na sua conta do provedor de IA.';
    if (status === 403) { if (/exhausted balance|insufficient|quota/i.test(detail)) return 'Créditos esgotados na sua chave. Recarregue no provedor.'; return 'Acesso negado pelo provedor. ' + (detail || 'Verifique permissões/faturamento.'); }
    if (status === 429) return 'Muitas requisições ou limite atingido. Aguarde alguns segundos e tente novamente.';
    if (status >= 500) return 'O provedor de IA está instável agora. Tente novamente em instantes.';
    return 'Erro do provedor (' + status + ')' + (detail ? ': ' + detail : '') + '.';
  }

  function fetchContent(messages, active, temperature, noReasoning) {
    var model = ApiKeyManager.getModel();
    var url, headers, body;
    if (active.service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers = {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://politicasia.maestrosdaia.com',
        'X-Title': 'Politicas IA'
      };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: 16000 };
      var isDeepSeek = model.indexOf('deepseek/') === 0; // COR-035: DeepSeek empties content when reasoning is on
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034
    } else {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Authorization': 'Bearer ' + active.key, 'Content-Type': 'application/json' };
      var oaModel = (model.indexOf('openai/') === 0) ? model.slice(7) : 'gpt-5.5-pro';
      body = { model: oaModel, messages: messages, temperature: temperature, max_tokens: 16000 };
    }
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) { var e = new Error(friendlyHttp(res.status, txt)); e.status = res.status; throw e; }
          var data; try { data = JSON.parse(txt); } catch (_) { throw new Error('Resposta inesperada do provedor.'); }
          var choice = (data.choices && data.choices[0]) || {};
          var content = choice.message && choice.message.content;
          if (!content || !String(content).trim()) { var e2 = new Error('Resposta vazia do modelo.'); e2.emptyContent = true; throw e2; }
          return String(content);
        });
      });
  }

  // COR-035: retry once without reasoning if content came back empty
  function fetchResilient(messages, active, temperature) {
    return fetchContent(messages, active, temperature, false).catch(function (e) {
      if (e && e.emptyContent) return fetchContent(messages, active, temperature, true);
      throw e;
    });
  }

  // ---- JSON extraction + repair ladder (COR-032/COR-015/COR-041) ----
  function stripToObject(s) {
    var a = s.indexOf('{'); var b = s.lastIndexOf('}');
    if (a === -1 || b === -1 || b < a) return s;
    return s.slice(a, b + 1);
  }
  function tryParse(s) {
    var cand = stripToObject(String(s));
    // remove code fences and control bytes (COR-041: escape text, not literal bytes)
    cand = cand.replace(/```json/gi, '').replace(/```/g, '').replace(/[\x00-\x1f]+/g, ' ');
    try { return JSON.parse(cand); } catch (e) {}
    var noTrail = cand.replace(/,\s*([}\]])/g, '$1'); // trailing commas
    try { return JSON.parse(noTrail); } catch (e) {}
    return null;
  }

  function generateJSON(messages, active) {
    return fetchResilient(messages, active, 0.6).then(function (txt) {
      var obj = tryParse(txt);
      if (obj) return obj;
      // COR-032: auto-reroll ONCE, stricter, lower temperature
      var stricter = messages.concat([{ role: 'user', content: 'Sua resposta anterior não era um JSON válido. Responda APENAS com o objeto JSON solicitado, sem texto fora do JSON e sem cercas de código.' }]);
      return fetchResilient(stricter, active, 0.4).then(function (txt2) {
        var obj2 = tryParse(txt2);
        if (obj2) return obj2;
        throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
      });
    });
  }

  // ================= prompt =================
  function buildBrief() {
    return {
      nome: clean($('in-nome').value),
      site: clean($('in-site').value),
      razao: clean($('in-razao').value),
      atividade: clean($('in-atividade').value),
      dados: chipsValues('chips-dados'),
      cookies: chipsValues('chips-cookies'),
      contato: clean($('in-contato').value),
      foro: clean($('in-foro').value),
      tom: chipSingle('chips-tom')
    };
  }

  function briefValid(b) {
    var miss = [];
    if (!b.nome) miss.push('nome do negócio');
    if (!b.site) miss.push('site');
    if (!b.atividade) miss.push('o que o negócio oferece');
    if (!b.contato) miss.push('e-mail de contato');
    return miss;
  }

  function docSchemaHint() {
    return '{"privacidade":{"titulo":"Política de Privacidade","intro":"...","secoes":[{"titulo":"...","paragrafos":["..."],"itens":["..."]}],"rodape":"..."},'
      + '"termos":{"titulo":"Termos de Uso","intro":"...","secoes":[{"titulo":"...","paragrafos":["..."],"itens":["..."]}],"rodape":"..."},'
      + '"cookies":{"titulo":"Política de Cookies","intro":"...","secoes":[{"titulo":"...","paragrafos":["..."],"itens":["..."]}],"rodape":"..."}}';
  }

  function buildMessages(b) {
    var sys = 'Você é um advogado brasileiro especialista em direito digital, LGPD (Lei 13.709/2018) e Marco Civil da Internet. '
      + 'Redige documentos jurídicos claros, completos e prontos para publicar em sites e apps. '
      + 'Responda SEMPRE em português do Brasil e SOMENTE com um objeto JSON válido no formato exato solicitado — sem texto fora do JSON, sem cercas de código.';

    var dados = b.dados.length ? b.dados.join(', ') : 'nome e e-mail';
    var cookies = b.cookies.length ? b.cookies.join(', ') : 'cookies essenciais';

    var user = 'Gere TRÊS documentos legais coerentes entre si para o negócio abaixo, cada um com 7 a 10 seções bem desenvolvidas (parágrafos objetivos; use a lista "itens" quando fizer sentido enumerar dados, direitos ou finalidades).\n\n'
      + 'NEGÓCIO:\n'
      + '- Nome/marca: ' + b.nome + '\n'
      + '- Site/app: ' + b.site + '\n'
      + (b.razao ? ('- Razão social/CNPJ: ' + b.razao + '\n') : '')
      + '- Atividade: ' + b.atividade + '\n'
      + '- Dados pessoais coletados: ' + dados + '\n'
      + '- Ferramentas/cookies: ' + cookies + '\n'
      + '- Contato/Encarregado (DPO): ' + b.contato + '\n'
      + (b.foro ? ('- Foro: ' + b.foro + '\n') : '')
      + '- Tom da redação: ' + (b.tom || 'Formal jurídico') + '\n\n'
      + 'REQUISITOS:\n'
      + '1) POLÍTICA DE PRIVACIDADE conforme a LGPD: quais dados são coletados e como, finalidades e bases legais (art. 7º), compartilhamento, direitos do titular (art. 18), segurança, retenção, cookies (resumo), como exercer direitos via o contato informado, e alterações.\n'
      + '2) TERMOS DE USO: aceitação, descrição do serviço, cadastro e conta, obrigações do usuário, condições de pagamento/assinatura quando aplicável, propriedade intelectual, condutas proibidas, limitação de responsabilidade, cancelamento, e foro (use a cidade informada ou "comarca do titular").\n'
      + '3) POLÍTICA DE COOKIES: o que são cookies, tipos usados (essenciais, analíticos, marketing) citando as ferramentas informadas, finalidade de cada tipo, como gerenciar/desativar no navegador, e consentimento.\n'
      + 'Use o nome do negócio ao longo dos textos. NÃO invente CNPJ nem endereço não informados. Mantenha coerência entre os três documentos.\n\n'
      + 'Responda EXATAMENTE neste formato JSON (preencha o conteúdo):\n' + docSchemaHint();

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // ================= render =================
  function normalizeDoc(d, fallbackTitle) {
    d = d || {};
    var secoes = Array.isArray(d.secoes) ? d.secoes : [];
    secoes = secoes.map(function (s) {
      s = s || {};
      var paras = Array.isArray(s.paragrafos) ? s.paragrafos : (s.paragrafo ? [s.paragrafo] : []);
      var itens = Array.isArray(s.itens) ? s.itens : [];
      return {
        titulo: clean(s.titulo),
        paragrafos: paras.map(clean).filter(Boolean),
        itens: itens.map(clean).filter(Boolean)
      };
    }).filter(function (s) { return s.titulo || s.paragrafos.length || s.itens.length; });
    return {
      titulo: clean(d.titulo) || fallbackTitle,
      intro: clean(d.intro),
      secoes: secoes,
      rodape: clean(d.rodape)
    };
  }

  function renderDoc(docKey) {
    var sheet = $('doc-sheet');
    if (!current || !current[docKey]) { return; }
    var d = current[docKey];
    var b = current.brief || {};
    var html = '';
    html += '<div class="stamp">MODELO</div>';
    html += '<div class="doc-masthead">';
    html += '<div class="doc-kicker">' + esc(DOC_KICKER[docKey]) + '</div>';
    html += '<h1 class="doc-h1">' + esc(d.titulo || DOC_LABEL[docKey]) + '</h1>';
    html += '<div class="doc-meta">' + esc(b.nome || '') + (b.site ? ' · ' + esc(b.site) : '') + ' — última atualização: ' + esc(current.dateLabel || todayBR()) + '</div>';
    html += '</div>';
    if (d.intro) html += '<p class="doc-intro">' + esc(d.intro) + '</p>';
    d.secoes.forEach(function (s, i) {
      html += '<h2 class="doc-h2"><span class="sec-n">' + (i + 1) + '.</span>' + esc(s.titulo) + '</h2>';
      s.paragrafos.forEach(function (p) { html += '<p class="doc-p">' + esc(p) + '</p>'; });
      if (s.itens.length) {
        html += '<ul class="doc-ul">';
        s.itens.forEach(function (it) { html += '<li>' + esc(it) + '</li>'; });
        html += '</ul>';
      }
    });
    var foot = d.rodape || 'Este documento é um modelo-base gerado com auxílio de inteligência artificial e não constitui aconselhamento jurídico. Recomenda-se revisão por um advogado antes da publicação.';
    html += '<div class="doc-foot">' + esc(foot) + '</div>';
    sheet.innerHTML = html;
    sheet.style.display = 'block';
    $('doc-empty').style.display = 'none';
  }

  function setActiveDoc(docKey) {
    activeDoc = docKey;
    document.querySelectorAll('.doc-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-doc') === docKey);
    });
    if (current) renderDoc(docKey);
  }

  function setActionsEnabled(on) {
    ['btn-copy', 'btn-html', 'btn-pdf', 'btn-save', 'btn-regen'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = !on;
    });
  }

  // ================= generate =================
  function generate() {
    var b = buildBrief();
    var miss = briefValid(b);
    if (miss.length) { toast('Preencha: ' + miss.join(', ')); return; }
    var active = ApiKeyManager.getActiveKey();
    if (!active) { toast('Configure sua chave de API (BYOK) primeiro.'); MembershipGate.showScreen('key-screen'); return; }
    if (typeof RateLimiter !== 'undefined' && RateLimiter.executeWithLimit) {
      RateLimiter.executeWithLimit('generate', function () { return runGenerate(b, active); }).catch(showErr);
    } else {
      runGenerate(b, active).catch(showErr);
    }
  }

  function showErr(e) {
    setBusy(false);
    toast((e && e.message) ? e.message : 'Falha ao gerar. Tente novamente.');
  }

  function setBusy(on, label) {
    var btn = $('btn-generate');
    if (!btn) return;
    if (on) {
      btn._old = btn._old || btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>' + (label || 'Emitindo documentos...');
      btn.classList.add('is-busy');
    } else {
      btn.classList.remove('is-busy');
      if (btn._old) btn.textContent = btn._old;
    }
  }

  function runGenerate(b, active) {
    setBusy(true);
    var messages = buildMessages(b);
    return generateJSON(messages, active).then(function (obj) {
      current = {
        privacidade: normalizeDoc(obj.privacidade, 'Política de Privacidade'),
        termos: normalizeDoc(obj.termos, 'Termos de Uso'),
        cookies: normalizeDoc(obj.cookies, 'Política de Cookies'),
        brief: b,
        dateLabel: todayBR(),
        ts: Date.now()
      };
      setBusy(false);
      setActionsEnabled(true);
      setActiveDoc(activeDoc || 'privacidade');
      toast('Documentos emitidos. Revise cada aba e exporte.');
    });
  }

  function regenerateCurrent() {
    var b = current ? current.brief : buildBrief();
    var active = ApiKeyManager.getActiveKey();
    if (!active) { toast('Configure sua chave de API primeiro.'); return; }
    var docKey = activeDoc;
    var btn = $('btn-regen');
    if (btn) { btn.disabled = true; btn.textContent = 'Refazendo...'; }
    var only = 'Refaça APENAS o documento "' + DOC_LABEL[docKey] + '" para o mesmo negócio, com uma redação nova e igualmente completa (7 a 10 seções). Responda com o MESMO formato JSON completo dos três documentos, mas capriche no documento solicitado.';
    var messages = buildMessages(b).concat([{ role: 'user', content: only }]);
    generateJSON(messages, active).then(function (obj) {
      var nd = normalizeDoc(obj[docKey], DOC_LABEL[docKey]);
      if (nd.secoes.length) current[docKey] = nd;
      renderDoc(docKey);
      toast('Documento refeito.');
    }).catch(showErr).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Refazer'; }
    });
  }

  // ================= exports =================
  function docPlainText(docKey) {
    var d = current[docKey]; var b = current.brief || {};
    var out = (d.titulo || DOC_LABEL[docKey]) + '\n' + (b.nome || '') + (b.site ? ' · ' + b.site : '') + '\nÚltima atualização: ' + (current.dateLabel || todayBR()) + '\n\n';
    if (d.intro) out += d.intro + '\n\n';
    d.secoes.forEach(function (s, i) {
      out += (i + 1) + '. ' + s.titulo + '\n';
      s.paragrafos.forEach(function (p) { out += p + '\n'; });
      s.itens.forEach(function (it) { out += '  • ' + it + '\n'; });
      out += '\n';
    });
    if (d.rodape) out += d.rodape + '\n';
    return out;
  }

  function copyCurrent() {
    var txt = docPlainText(activeDoc);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Texto copiado.'); }, function () { fallbackCopy(txt); });
    } else { fallbackCopy(txt); }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Texto copiado.'); } catch (e) { toast('Copie manualmente.'); }
    ta.remove();
  }

  // build a self-contained, hostable HTML document for the current doc
  function buildStandaloneHTML(docKey) {
    var d = current[docKey]; var b = current.brief || {};
    var body = '';
    if (d.intro) body += '<p class="intro">' + esc(d.intro) + '</p>';
    d.secoes.forEach(function (s, i) {
      body += '<h2><span>' + (i + 1) + '.</span> ' + esc(s.titulo) + '</h2>';
      s.paragrafos.forEach(function (p) { body += '<p>' + esc(p) + '</p>'; });
      if (s.itens.length) { body += '<ul>'; s.itens.forEach(function (it) { body += '<li>' + esc(it) + '</li>'; }); body += '</ul>'; }
    });
    var foot = d.rodape || 'Modelo-base gerado com auxílio de IA. Não constitui aconselhamento jurídico.';
    var css = 'body{font-family:Georgia,"Times New Roman",serif;color:#1c1a15;max-width:820px;margin:0 auto;padding:48px 22px;line-height:1.7}'
      + '.kicker{font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a227;font-weight:700;text-align:center}'
      + 'h1{color:#1a2b4a;text-align:center;font-size:28px;margin:6px 0 4px}'
      + '.meta{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6a6350;text-align:center;border-bottom:2px solid#1a2b4a;padding-bottom:16px;margin-bottom:24px}'
      + '.intro{font-size:16px}h2{color:#1a2b4a;font-size:19px;margin:26px 0 8px}h2 span{color:#c9a227;font-family:Arial,sans-serif;font-size:13px}'
      + 'p{font-size:15.5px}ul{margin:6px 0 14px 22px}li{margin-bottom:6px}'
      + '.foot{margin-top:32px;padding-top:16px;border-top:1px dashed#b3a988;font-family:Arial,sans-serif;font-size:12px;color:#6a6350;text-align:center}';
    return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + esc(d.titulo || DOC_LABEL[docKey]) + ' — ' + esc(b.nome || '') + '</title><style>' + css + '</style></head><body>'
      + '<div class="kicker">' + esc(DOC_KICKER[docKey]) + '</div>'
      + '<h1>' + esc(d.titulo || DOC_LABEL[docKey]) + '</h1>'
      + '<div class="meta">' + esc(b.nome || '') + (b.site ? ' · ' + esc(b.site) : '') + ' — última atualização: ' + esc(current.dateLabel || todayBR()) + '</div>'
      + body + '<div class="foot">' + esc(foot) + '</div></body></html>';
  }

  function downloadHTML() {
    var html = buildStandaloneHTML(activeDoc);
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (current.brief.nome || 'politicas').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + activeDoc + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('HTML baixado — pronto para hospedar no seu site.');
  }

  // print-to-PDF via a hidden iframe (real PDF through the browser's print dialog)
  function printPDF() {
    var html = buildStandaloneHTML(activeDoc);
    var iframe = document.createElement('iframe');
    iframe.style.position = 'fixed'; iframe.style.right = '0'; iframe.style.bottom = '0';
    iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
    document.body.appendChild(iframe);
    var doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(function () {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch (e) { toast('Não foi possível abrir a impressão. Use "Baixar HTML".'); }
      setTimeout(function () { iframe.remove(); }, 1500);
    }, 350);
    toast('Salve como PDF na janela de impressão.');
  }

  // ================= library =================
  function loadLib() { try { return JSON.parse(localStorage.getItem(LIB_STORE) || '[]'); } catch (e) { return []; } }
  function saveLibArr(a) { try { localStorage.setItem(LIB_STORE, JSON.stringify(a.slice(0, 40))); } catch (e) {} }

  function saveCurrent() {
    if (!current) return;
    var a = loadLib();
    a.unshift({
      id: 'p' + current.ts,
      nome: current.brief.nome || 'Sem nome',
      site: current.brief.site || '',
      dateLabel: current.dateLabel,
      docs: { privacidade: current.privacidade, termos: current.termos, cookies: current.cookies },
      brief: current.brief,
      ts: current.ts
    });
    saveLibArr(a);
    renderLibrary();
    toast('Salvo na biblioteca.');
  }

  function renderLibrary() {
    var a = loadLib();
    var wrap = $('library'); var grid = $('library-grid');
    if (!wrap || !grid) return;
    if (!a.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    grid.innerHTML = '';
    a.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'lib-card';
      card.innerHTML = '<button class="lib-del" title="Excluir">&times;</button>'
        + '<h4>' + esc(item.nome) + '</h4>'
        + '<div class="lib-meta">' + esc(item.site || '') + ' · ' + esc(item.dateLabel || '') + '</div>'
        + '<div class="lib-tags"><span class="lib-tag">Privacidade</span><span class="lib-tag">Termos</span><span class="lib-tag">Cookies</span></div>';
      card.querySelector('.lib-del').addEventListener('click', function (e) {
        e.stopPropagation();
        var arr = loadLib().filter(function (x) { return x.id !== item.id; });
        saveLibArr(arr); renderLibrary();
      });
      card.addEventListener('click', function () { reopen(item); });
      grid.appendChild(card);
    });
  }

  function reopen(item) {
    current = {
      privacidade: normalizeDoc(item.docs.privacidade, 'Política de Privacidade'),
      termos: normalizeDoc(item.docs.termos, 'Termos de Uso'),
      cookies: normalizeDoc(item.docs.cookies, 'Política de Cookies'),
      brief: item.brief || {}, dateLabel: item.dateLabel, ts: item.ts
    };
    setActionsEnabled(true);
    setActiveDoc('privacidade');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Documento reaberto da biblioteca.');
  }

  // ================= wire =================
  function wire() {
    if (wired) return;
    var app = $('app-screen');
    if (!app) return;
    wired = true;

    // greet name if available
    try { var nm = (window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession()); } catch (e) {}

    initChips('chips-dados'); initChips('chips-cookies'); initChips('chips-tom');

    var g = $('btn-generate'); if (g) g.addEventListener('click', generate);
    var tabs = $('doc-tabs');
    if (tabs) tabs.querySelectorAll('.doc-tab').forEach(function (t) {
      t.addEventListener('click', function () { setActiveDoc(t.getAttribute('data-doc')); });
    });
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', copyCurrent);
    var bh = $('btn-html'); if (bh) bh.addEventListener('click', downloadHTML);
    var bp = $('btn-pdf'); if (bp) bp.addEventListener('click', printPDF);
    var bs = $('btn-save'); if (bs) bs.addEventListener('click', saveCurrent);
    var br = $('btn-regen'); if (br) br.addEventListener('click', regenerateCurrent);

    renderLibrary();
  }

  // ---- init: 3 idempotent triggers (COR-008 + COR-044) ----
  window.addEventListener('maestria:app-ready', wire);
  document.addEventListener('DOMContentLoaded', function () {
    var app = $('app-screen');
    if (app && app.classList.contains('active')) wire();
    // COR-044: observe app-screen becoming active on the first-login key→continue path
    if (app && 'MutationObserver' in window) {
      var obs = new MutationObserver(function () {
        if (app.classList.contains('active')) { wire(); }
      });
      obs.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
