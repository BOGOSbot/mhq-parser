/* Judge-presentation mockups. One renderer, three arms; the page sets window.ARM.
   Everything here reads window.JUDGE_DATA (real /rules/ask captures, see judge-build.mjs). */
(function () {
  var ARM = Number(window.ARM || 1);
  var DATA = window.JUDGE_DATA;
  // A state is addressable (?s=2&pick=1) so a screenshot and a shared link can
  // name the exact capture.
  var Q = new URLSearchParams(location.search);
  var S = Number(Q.get('s') || 0);
  if (!(S >= 0 && S < (window.JUDGE_DATA.states || []).length)) S = 0;
  var pickFirst = Q.get('pick') === '1';
  var openRows = {};
  var readOpen = false;
  var showAll = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function display() {
    var st = DATA.states[S];
    var rows = st.findings.slice();
    var cited = (st.judge && st.judge.passages) ? st.judge.passages.slice() : [];
    if (pickFirst && cited.length) {
      var at = -1;
      for (var i = 0; i < rows.length; i++) if (rows[i].n === cited[0]) at = i;
      if (at > 0) rows.unshift(rows.splice(at, 1)[0]);
    }
    var map = {};
    for (var k = 0; k < rows.length; k++) map[rows[k].n] = k + 1;
    return { st: st, rows: rows, map: map, cited: cited };
  }
  // The judge names passages by their rank in the list it judged; the list can be
  // reordered on screen, so a citation is printed as the rank the reader can see.
  function chip(d, origN) {
    var disp = d.map[origN];
    if (!disp) return '<span class="cite">[' + origN + ']</span>';
    return '<a class="cite" href="#row-' + disp + '" data-row="' + disp + '">[' + disp + ']</a>';
  }
  function chips(d, list) {
    var src = list || d.cited;
    var out = [];
    for (var i = 0; i < src.length; i++) out.push(chip(d, src[i]));
    return out.join(' ');
  }
  // The model reaches for markdown; the only formatting rendered is bold, italic
  // and the [n] markers, which become the same chips the rows carry.
  function inline(d, text) {
    var re = /(~~[^~]+~~|\*\*[^*]+\*\*|\*[^*]+\*|\[\d+\])/g, last = 0, m, out = [];
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(esc(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.slice(0, 2) === '~~') out.push('<s class="untraced">' + esc(tok.slice(2, -2)) + '</s>');
      else if (tok.charAt(0) === '*') out.push('<' + (tok.slice(0, 2) === '**' ? 'b' : 'i') + '>' + esc(tok.replace(/\*/g, '')) + '</' + (tok.slice(0, 2) === '**' ? 'b' : 'i') + '>');
      else out.push(chip(d, parseInt(tok.slice(1, -1), 10)));
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(esc(text.slice(last)));
    return out.join('');
  }
  function whyBox(st) {
    var j = st.judge || {};
    if (!j.why) return '';
    var out = ['<details class="why"><summary>why</summary><div class="body">'];
    out.push(esc(j.why));
    out.push('</div>');
    var meta = [];
    if (j.confidence) meta.push('confidence ' + esc(j.confidence));
    if (st.judge2) meta.push('second judge: ' + (st.judge2.answered ? 'would answer' : 'would not answer') + (st.judge2.reasoning === 'none' ? ', without reasoning' : ''));
    if (st.note) meta.push(esc(st.note));
    if (meta.length) out.push('<div class="meta">' + meta.join(' &middot; ') + '</div>');
    out.push('</details>');
    return out.join('');
  }

  // --- arm 1: the recommendation ------------------------------------------
  // No model sentence reaches the screen at rest. The judge says where to look
  // and marks the rows; that is a recommendation, so it cannot be confidently
  // wrong - a bad pick costs one tap, not a wrong answer.
  function arm1(d) {
    var st = d.st, out = ['<div class="judge">'];
    if (st.kind === 'answered') out.push('<p class="lead">start with ' + chips(d) + '</p>');
    else if (st.kind === 'refused') out.push('<p class="lead">nothing here states it outright <span class="sub">&mdash; the closest are first</span></p>');
    else if (st.kind === 'notq') out.push('<p class="lead">this is not a rules question <span class="sub">&mdash; the closest pages are below</span></p>');
    else if (st.kind === 'split') out.push('<p class="lead">start with ' + chips(d) + ' <span class="sub">&mdash; a second judge would not answer from these</span></p>');
    out.push(whyBox(st));
    out.push('</div>');
    return out.join('');
  }

  // --- arm 2: the rule itself ---------------------------------------------
  // Nothing is generated and nothing is summarised: the judge only decides which
  // passage opens. The answer on screen is the rulebook's own words.
  function arm2(d) {
    var st = d.st;
    if (st.kind === 'answered' || st.kind === 'split') return '';
    var out = ['<div class="judge">'];
    if (st.kind === 'refused') out.push('<p class="lead">nothing here states it outright <span class="sub">&mdash; the closest are first</span></p>');
    else out.push('<p class="lead">this is not a rules question <span class="sub">&mdash; the closest pages are below</span></p>');
    out.push(whyBox(st));
    out.push('</div>');
    return out.join('');
  }

  // --- arm 3: the reading --------------------------------------------------
  // One to three sentences, in the interface voice and never in the rulebook
  // face, with the passages it came from and what the trace check dropped.
  function arm3(d) {
    var st = d.st, j = st.judge || {}, out = ['<div class="judge">'];
    if (st.kind === 'notq') {
      out.push('<p class="read' + (readOpen ? ' open' : '') + '">' + inline(d, j.why || '') + '</p>');
      out.push('<p class="attr">not a rules question &mdash; no rulebook passage is cited</p>');
    } else if (st.kind === 'refused') {
      out.push('<p class="read' + (readOpen ? ' open' : '') + '">' + inline(d, j.why || '') + '</p>');
      out.push('<p class="attr">nothing in these passages states it &mdash; this is what the search was missing</p>');
    } else {
      out.push('<p class="read' + (readOpen ? ' open' : '') + '">' + inline(d, j.why || '') + '</p>');
      out.push('<p class="attr">a summary, not the rule &mdash; from ' + chips(d) + '</p>');
      // The trace check is silent while it passes; it speaks only when it drops
      // something, because that is the moment the reader has to be told.
      if (st.trace && st.trace.dropped > 0) {
        out.push('<p class="trace bad">' + st.trace.dropped + ' of ' + st.trace.total
          + ' claims could not be traced to the passages cited &mdash; struck through above</p>');
      }
      if (st.kind === 'split') out.push('<p class="attr">&middot; a second judge would not answer from these</p>');
    }
    if ((j.why || '').length > 220) out.push('<button class="more" data-read="1">' + (readOpen ? 'less' : 'the whole reading') + '</button>');
    out.push(whyBox(st));
    out.push('</div>');
    return out.join('');
  }

  function rowHtml(d, f, disp, isPick) {
    var cited = d.cited.indexOf(f.n) !== -1;
    var cls = 'num' + (isPick ? ' pick' : (cited ? ' on' : ''));
    var out = ['<li class="fitem" id="row-' + disp + '">'];
    out.push('<div class="frow"><span class="' + cls + '">[' + disp + ']</span><span class="ftitle">' + esc(f.title) + '</span></div>');
    if (f.crumb) out.push('<div class="fcrumb">' + esc(f.crumb) + '</div>');
    if (ARM === 2 && isPick) {
      var open = openRows[disp] === true;
      out.push('<div class="fpassage' + (open ? ' open' : '') + '">' + esc(f.passage) + '</div>');
      out.push('<button class="fmore" data-open="' + disp + '">' + (open ? 'fold it back' : 'the whole passage') + '</button>');
    } else {
      out.push('<div class="ftext">' + esc(f.excerpt) + '</div>');
    }
    out.push('</li>');
    return out.join('');
  }

  function render() {
    var d = display(), st = d.st, out = [];
    out.push('<div class="wrap">');
    out.push('<div class="qrecap"><span class="qt">\u201c' + esc(st.question) + '\u201d</span></div>');
    out.push(ARM === 1 ? arm1(d) : ARM === 2 ? arm2(d) : arm3(d));
    out.push('<div class="fhead"><h2>Findings</h2><span class="cnt">' + d.rows.length + ' ranked' + (d.cited.length ? ' &middot; ' + d.cited.length + ' used by the judge' : '') + '</span></div>');
    out.push('<ol class="cites">');
    var window = 5, seen = {};
    for (var i = 0; i < d.rows.length; i++) {
      var isPick = d.cited.length > 0 && d.rows[i].n === d.cited[0];
      if (!showAll && i >= window && !isPick) continue;
      if (!showAll && i >= window && isPick) out.push('<li class="gap">\u2026</li>');
      seen[i] = true;
      out.push(rowHtml(d, d.rows[i], i + 1, isPick));
    }
    out.push('</ol>');
    if (!showAll && d.rows.length > window) out.push('<button class="moref" data-all="1">the other ' + (d.rows.length - window) + ' findings</button>');
    out.push('<p class="note"><b>' + esc(st.answerKind) + '</b> ' + esc(st.note) + '</p>');
    out.push('</div>');
    document.getElementById('page').innerHTML = out.join('');
    wire();
  }

  function wire() {
    var i, nodes;
    nodes = document.querySelectorAll('.cite[data-row]');
    for (i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function (ev) {
      ev.preventDefault();
      var t = document.getElementById('row-' + this.getAttribute('data-row'));
      if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    nodes = document.querySelectorAll('[data-open]');
    for (i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function () {
      var k = this.getAttribute('data-open');
      openRows[k] = !openRows[k];
      render();
    });
    nodes = document.querySelectorAll('[data-all]');
    for (i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function () {
      showAll = true; render();
    });
    nodes = document.querySelectorAll('[data-read]');
    for (i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function () {
      readOpen = !readOpen; render();
    });
  }

  function dock() {
    var arms = [1, 2, 3], i, out = [];
    out.push('<div class="dock">');
    out.push('<div class="row arms"><span class="lab">arm</span>');
    for (i = 0; i < arms.length; i++) out.push('<button data-arm="' + arms[i] + '"' + (arms[i] === ARM ? ' class="on"' : '') + '>J' + arms[i] + '</button>');
    out.push('<button data-pick="1"' + (pickFirst ? ' class="on"' : '') + '>pick first</button>');
    out.push('</div>');
    out.push('<div class="row"><span class="lab">state</span>');
    for (i = 0; i < DATA.states.length; i++) {
      out.push('<button data-state="' + i + '"' + (i === S ? ' class="on"' : '') + '>' + esc(DATA.states[i].label) + '</button>');
    }
    out.push('</div></div>');
    return out.join('');
  }

  function paintDock() {
    document.getElementById('dock').innerHTML = dock();
    var nodes = document.querySelectorAll('#dock [data-arm]');
    for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener('click', function () {
      location.href = 'j' + this.getAttribute('data-arm') + '.html';
    });
    nodes = document.querySelectorAll('#dock [data-state]');
    for (var j = 0; j < nodes.length; j++) nodes[j].addEventListener('click', function () {
      S = Number(this.getAttribute('data-state')); readOpen = false; openRows = {}; render(); paintDock();
    });
    nodes = document.querySelectorAll('#dock [data-pick]');
    for (var k = 0; k < nodes.length; k++) nodes[k].addEventListener('click', function () {
      pickFirst = !pickFirst; render(); paintDock();
    });
  }

  document.getElementById('note').innerHTML = '<span class="vbadge">' + DATA.arms[ARM - 1].badge + '</span><p><b>'
    + DATA.arms[ARM - 1].name + '</b> &mdash; ' + DATA.arms[ARM - 1].pitch + '</p>';
  document.title = 'Judge mockup ' + DATA.arms[ARM - 1].badge + ' - mhq rules';
  render();
  paintDock();
})();
