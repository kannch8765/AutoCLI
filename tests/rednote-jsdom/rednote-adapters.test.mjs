import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function extractEvaluate(relativeUrl) {
  const yaml = readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
  const marker = '\n  - evaluate: |\n';
  const start = yaml.indexOf(marker);
  assert.notEqual(start, -1, `evaluate block missing in ${relativeUrl}`);
  const lines = [];
  for (const line of yaml.slice(start + marker.length).split(/\r?\n/)) {
    if (line.startsWith('  - ')) break;
    if (!line.trim()) {
      lines.push('');
      continue;
    }
    assert.ok(line.startsWith('      '), `unexpected evaluate indentation: ${line}`);
    lines.push(line.slice(6));
  }
  return lines.join('\n').trim();
}

const NOTE_EVALUATE = extractEvaluate('../../adapters/rednote/note.yaml');
const COMMENTS_TEMPLATE = extractEvaluate('../../adapters/rednote/comments.yaml');

function renderCommentsEvaluate({ withReplies = false, limit = 20 } = {}) {
  return COMMENTS_TEMPLATE
    .replace('${{ args.with_replies | default(false) | json }}', JSON.stringify(withReplies))
    .replace('${{ args.limit | default(20) | json }}', JSON.stringify(limit));
}

function makeDom(html, { url = 'https://www.rednote.com/explore/abc123?xsec_token=test' } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const stats = { timeouts: 0, scrolls: 0 };

  Object.defineProperty(window.document.body, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; },
  });

  window.scrollTo = () => { stats.scrolls += 1; };
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    stats.scrolls += 1;
  };
  window.setTimeout = (fn, _ms, ...args) => {
    stats.timeouts += 1;
    fn(...args);
    return stats.timeouts;
  };
  window.clearTimeout = () => {};

  return { dom, window, stats };
}

async function runEvaluate(source, html, options) {
  const ctx = makeDom(html, options);
  try {
    const value = ctx.window.eval(source);
    return { ...ctx, value: await value };
  } catch (error) {
    ctx.dom.window.close();
    throw error;
  }
}

async function runNote(html, options) {
  const result = await runEvaluate(NOTE_EVALUATE, html, options);
  return result;
}

async function runComments(html, { withReplies = false, limit = 20, url } = {}) {
  const result = await runEvaluate(renderCommentsEvaluate({ withReplies, limit }), html, { url });
  return {
    ...result,
    value: Array.from(result.value, (row, index) => ({
      rank: index + 1,
      ...JSON.parse(JSON.stringify(row)),
    })),
  };
}

function fields(rows) {
  return Object.fromEntries(rows.map(({ field, value }) => [field, value]));
}

function topComment({ author, text, likes = '0', time = 'now', extra = '', replies = '' }) {
  return `
    <div class="parent-comment">
      <div class="comment-item">
        <div class="author-wrapper"><span class="name">${author}</span></div>
        <div class="content">${text}</div>
        <span class="count">${likes}</span>
        <span class="date">${time}</span>
        ${extra}
      </div>
      ${replies}
    </div>`;
}

function reply({ author, text, likes = '0', replyTo = '' }) {
  const marker = replyTo ? `<span class="nickname">${replyTo}</span>` : '';
  return `
    <div class="comment-item-sub">
      <span class="name">${author}</span>
      <div class="content">${marker}${text}</div>
      <span class="count">${likes}</span>
      <span class="date">reply-time</span>
    </div>`;
}

// note A — normal note
test('note A: extracts normal note fields and counts', async () => {
  const { value, dom } = await runNote(`
    <div id="noteContainer">
      <div id="detail-title">Title A</div>
      <span class="username">Alice</span>
      <div id="detail-desc">Body A</div>
    </div>
    <div class="interact-container">
      <div class="like-wrapper"><span class="count">12</span></div>
      <div class="collect-wrapper"><span class="count">3</span></div>
      <div class="chat-wrapper"><span class="count">4</span></div>
    </div>`);
  assert.deepEqual(fields(value), {
    title: 'Title A', author: 'Alice', content: 'Body A', likes: '12', collects: '3', comments: '4',
  });
  dom.window.close();
});

// note B — recommendation-feed contamination
test('note B: does not steal a recommendation title when the note is untitled', async () => {
  const { value, dom } = await runNote(`
    <div id="noteContainer"><span class="username">Alice</span><div id="detail-desc">Body</div></div>
    <section class="recommendation"><div class="title">WRONG TITLE</div></section>`);
  assert.equal(fields(value).title, '');
  dom.window.close();
});

// note C — comment-count contamination
test('note C: interaction counts stay scoped to the post bar', async () => {
  const { value, dom } = await runNote(`
    <div class="comments"><div class="like-wrapper"><span class="count">999</span></div><div class="chat-wrapper"><span class="count">888</span></div></div>
    <div id="noteContainer"><div id="detail-title">Scoped</div><span class="username">Alice</span></div>
    <div class="interact-container">
      <div class="like-wrapper"><span class="count">7</span></div>
      <div class="collect-wrapper"><span class="count">8</span></div>
      <div class="chat-wrapper"><span class="count">9</span></div>
    </div>`);
  const data = fields(value);
  assert.equal(data.likes, '7');
  assert.equal(data.collects, '8');
  assert.equal(data.comments, '9');
  dom.window.close();
});

// note D — zero counts
test('note D: placeholder count labels normalize to zero', async () => {
  const { value, dom } = await runNote(`
    <div id="noteContainer"><div id="detail-title">Zero</div><span class="username">Alice</span></div>
    <div class="interact-container">
      <div class="like-wrapper"><span class="count">赞</span></div>
      <div class="collect-wrapper"><span class="count">收藏</span></div>
      <div class="chat-wrapper"><span class="count">评论</span></div>
    </div>`);
  const data = fields(value);
  assert.equal(data.likes, '0');
  assert.equal(data.collects, '0');
  assert.equal(data.comments, '0');
  dom.window.close();
});

// note E/F/G/H — page states and precedence
test('note E: login wall throws LOGIN_REQUIRED', async () => {
  await assert.rejects(() => runNote('<main>请登录</main>'), /LOGIN_REQUIRED/);
});

test('note F: not-found page throws NOT_FOUND', async () => {
  await assert.rejects(() => runNote('<main>页面不见了</main>'), /NOT_FOUND/);
});

test('note G: body security block wins over login and not-found signals', async () => {
  await assert.rejects(() => runNote('<main>安全限制 请登录 页面不见了</main>'), /SECURITY_BLOCK/);
});

test('note G: error_code URL alone triggers SECURITY_BLOCK', async () => {
  await assert.rejects(
    () => runNote('<main>neutral</main>', { url: 'https://www.rednote.com/website-login/error?error_code=300017' }),
    /SECURITY_BLOCK/,
  );
});

test('note H: blank page throws EMPTY_RESULT', async () => {
  await assert.rejects(() => runNote('<main></main>'), /EMPTY_RESULT/);
});

// comments A — top-level only
test('comments A: top-level rows preserve order and rank', async () => {
  const html = topComment({ author: 'A', text: 'first', likes: '1' })
    + topComment({ author: 'B', text: 'second', likes: '2' })
    + topComment({ author: 'C', text: 'third', likes: '3' });
  const { value, dom } = await runComments(html, { limit: 3 });
  assert.deepEqual(value.map(({ rank, author, text, is_reply }) => ({ rank, author, text, is_reply })), [
    { rank: 1, author: 'A', text: 'first', is_reply: false },
    { rank: 2, author: 'B', text: 'second', is_reply: false },
    { rank: 3, author: 'C', text: 'third', is_reply: false },
  ]);
  dom.window.close();
});

// comments B — like-count formats
test('comments B: parses compact and punctuated like counts', async () => {
  const counts = ['2.1w', '1.5万', '1.2k', '1,234', '500+', '赞'];
  const html = counts.map((likes, i) => topComment({ author: `U${i}`, text: `T${i}`, likes })).join('');
  const { value, dom } = await runComments(html, { limit: counts.length });
  assert.deepEqual(value.map(row => row.likes), [21000, 15000, 1200, 1234, 500, 0]);
  dom.window.close();
});

// comments C — nested reply_to semantics
test('comments C: nested reply_to uses direct nickname then falls back to root author', async () => {
  const replies = `<div class="reply-container">
    ${reply({ author: 'Carol', text: ' reply to reply', replyTo: 'Bob' })}
    ${reply({ author: 'Dave', text: ' direct root reply' })}
  </div>`;
  const { value, dom } = await runComments(topComment({ author: 'Alice', text: 'root', replies }), {
    withReplies: true,
    limit: 1,
  });
  assert.equal(value[1].reply_to, 'Bob');
  assert.equal(value[2].reply_to, 'Alice');
  dom.window.close();
});

// comments D — limit counts top-level only
test('comments D: with_replies limit counts roots while retaining their replies', async () => {
  const thread = (root, child) => topComment({
    author: root,
    text: `${root}-root`,
    replies: `<div class="reply-container">${reply({ author: child, text: `${child}-reply` })}</div>`,
  });
  const { value, dom } = await runComments(thread('A', 'a') + thread('B', 'b') + thread('C', 'c'), {
    withReplies: true,
    limit: 2,
  });
  assert.deepEqual(value.map(row => [row.author, row.is_reply]), [
    ['A', false], ['a', true], ['B', false], ['b', true],
  ]);
  dom.window.close();
});

// comments E — image filtering and lazy placeholders
test('comments E: emits only real comment photos, dedupes, and ignores data placeholders', async () => {
  const extra = `
    <img class="avatar-item" src="https://img.example/avatar.jpg">
    <div class="comment-pic"><img src="data:image/gif;base64,AAAA" data-src="https://img.example/photo.jpg"></div>
    <div class="comment-pic"><img src="https://img.example/photo.jpg"></div>
    <div class="comment-pic"><img src="data:image/gif;base64,BBBB"></div>`;
  const html = topComment({
    author: 'A',
    text: 'body <img src="https://img.example/emoji.png">',
    extra,
  });
  const { value, dom } = await runComments(html, { limit: 1 });
  assert.deepEqual(value[0].images, ['https://img.example/photo.jpg']);
  dom.window.close();
});

// comments F — scroll termination
test('comments F: stalled scroll exits after six rounds rather than the 60-round cap', async () => {
  const { value, stats, dom } = await runComments(topComment({ author: 'A', text: 'only one' }), { limit: 4 });
  assert.equal(value.length, 1);
  assert.equal(stats.timeouts, 6);
  assert.ok(stats.timeouts < 60);
  dom.window.close();
});

// comments G — defensive validator helpers are unreachable from normal DOM construction,
// so expose the exact inlined helpers in the test realm and exercise them directly.
test('comments G: defensive row validator rejects blank text, negative likes, bad boolean, and credential URLs', async () => {
  const source = renderCommentsEvaluate({ limit: 1 }).replace(
    'const results = []',
    'globalThis.__validateRow = validateRow; globalThis.__validateImages = validateImages; const results = []',
  );
  assert.notEqual(source, renderCommentsEvaluate({ limit: 1 }));
  const { window, dom } = await runEvaluate(source, '<div class="parent-comment"></div>');

  assert.throws(() => window.__validateRow({ text: ' ', likes: 0, is_reply: false, images: [] }), /text is required/);
  assert.throws(() => window.__validateRow({ text: 'ok', likes: -1, is_reply: false, images: [] }), /non-negative integer/);
  assert.throws(() => window.__validateRow({ text: 'ok', likes: 0, is_reply: 'false', images: [] }), /is_reply must be boolean/);
  assert.throws(
    () => window.__validateRow({ text: 'ok', likes: 0, is_reply: false, images: ['https://user:pass@img.example/x.jpg'] }),
    /unsafe image URL/,
  );
  dom.window.close();
});

test('comments rejects out-of-range limit before extraction', async () => {
  await assert.rejects(() => runComments('<main></main>', { limit: 0 }), /ARGUMENT/);
  await assert.rejects(() => runComments('<main></main>', { limit: 51 }), /ARGUMENT/);
  await assert.rejects(() => runComments('<main></main>', { limit: 1.5 }), /ARGUMENT/);
});

test('comments SECURITY_BLOCK takes precedence over LOGIN_REQUIRED', async () => {
  await assert.rejects(
    () => runComments('<main>安全限制 请登录</main>', { limit: 1 }),
    /SECURITY_BLOCK/,
  );
});
