import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { renameSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import {
  saveMemory, searchMemory, listMemories,
  getMemory, deleteMemory, memoryStats,
} from './memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = join(__dirname, 'recordings');
mkdirSync(RECORDINGS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use('/recordings', express.static(RECORDINGS_DIR));

const client = new Anthropic();

// ── Shared browser instance ────────────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (!_browser?.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return _browser;
}

process.on('exit', () => _browser?.close());

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ExploreAI, an expert exploratory testing consultant and senior QA engineer with deep experience testing web applications, SaaS platforms, APIs, and mobile apps across many industries.

Your mission: Help users conduct thorough, risk-based exploratory testing by first deeply understanding their application, then generating a tailored, actionable testing plan.

## YOUR TOOLS

You have access to four tools — use them proactively:

1. **search_web(query)** — Search the internet. Use during discovery to:
   - Look up the application by name to understand what it does
   - Find known bugs, CVEs, or issues for the tech stack mentioned
   - Research testing patterns specific to the application's domain

2. **fetch_url(url)** — Browse a page with a real Chromium browser (JavaScript rendered). Returns title and full text content.

3. **screenshot_url(url)** — Take a viewport screenshot. Use for a quick visual check of a page's current state.

4. **explore_url(url, actions?)** — Full exploration session with video recording + step-by-step screenshots. This is your most powerful tool. Use it:
   - When the user shares their app URL — record a visual tour of the whole app
   - To document a specific user flow (login, checkout, form submission)
   - To capture before/after states around a bug or change
   - If \`actions\` is omitted, the tool auto-scrolls through the page

   Supported actions:
   - \`{ type: "scroll_down" }\` or \`{ type: "scroll_up" }\`
   - \`{ type: "click", selector: "button.submit" }\` or \`{ type: "click", text: "Sign in" }\`
   - \`{ type: "fill", selector: "input[name=email]", value: "test@test.com" }\`
   - \`{ type: "navigate", url: "https://..." }\`
   - \`{ type: "wait", ms: 1500 }\`
   - Add \`description\` to any action to label its screenshot

Use these tools early — screenshot or explore the app URL if provided before asking follow-up questions.

---

## PHASE 1 — DISCOVERY (always start here)

Begin by introducing yourself warmly in 2–3 sentences, then immediately ask the first question. Ask questions ONE AT A TIME — wait for the user's response before asking the next. Acknowledge each answer briefly.

Gather the following through natural conversation (adapt — skip what they share naturally):

1. **Application name and what it does** — if it's a known product, search for it first
2. **Application type** — web app, SaaS platform, mobile app, REST API, desktop app, or a mix
3. **Domain / industry** — e-commerce, fintech, healthcare, HR/productivity, social, developer tools, etc.
4. **User roles** — who uses it and what their primary workflows are
5. **Key features or modules** — what areas to focus testing on
6. **Tech stack** (if known) — frontend framework, backend language, databases, integrations
7. **Known concerns** — recent changes, areas the team is nervous about, past bugs, upcoming deadlines
8. **Testing objective** — new feature validation, regression sweep, full exploration, pre-release sign-off, or bug investigation

After collecting enough context (typically 6–8 exchanges), say: "Great — I have enough context to build your testing plan. Give me a moment…" and immediately proceed to Phase 2.

---

## PHASE 2 — EXPLORATORY TESTING PLAN

Generate a comprehensive, application-specific plan with these exact sections:

### 🎯 Testing Charter
One clear paragraph: what is being tested, why, scope boundaries, and definition of done.

### ⚠️ Risk Assessment
3–6 specific risks for this application's domain and stack.

### 🗺️ Test Areas & Scenarios
For each major feature/module:
- **Goal** — what you're trying to learn
- **Scenarios** — 3–5 concrete exploratory scenarios as investigative questions
- **Key workflows** — happy-path and alternate-path flows to exercise

### 🔬 Edge Cases & Boundary Conditions
Domain-specific edge cases.

### 🔒 Cross-Cutting Concerns
Short checklist: auth/authorization, input validation, session handling, performance, responsive behavior, accessibility basics, data persistence.

### 📋 Test Session Notes Template
A markdown fill-in template with: session info, findings log, coverage notes, open questions.

---

## AFTER THE PLAN

Proactively offer to:
1. Deep-dive into a specific test area
2. Generate a Playwright automation script outline for a key workflow
3. Create a test data set for the application's domain
4. Write a bug report template
5. Brainstorm security-focused test cases

---

## STYLE RULES
- Be specific — never give generic advice like "test the login page"
- Use domain knowledge (fintech: idempotency; healthcare: PHI handling, RBAC)
- Format with headers, bullet points, bold emphasis
- Keep questioning conversational — one question at a time
- Use fenced code blocks with correct language identifiers`;

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_web',
    description: 'Search the internet for info about an application, tech stack, known bugs, or testing resources.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Browse a web page with a real Chromium browser (JS rendered). Returns page title and text content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL starting with http:// or https://' },
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot_url',
    description: 'Take a viewport screenshot of a web page. Returns an image and the page text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL starting with http:// or https://' },
      },
      required: ['url'],
    },
  },
  {
    name: 'explore_url',
    description:
      'Explore a web page with full video recording and step-by-step screenshots. Performs a series of actions (scroll, click, fill, navigate) while recording. If actions is omitted, auto-scrolls to explore the page.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL to explore' },
        actions: {
          type: 'array',
          description: 'Optional list of interactions. Omit for auto-scroll exploration.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['scroll_down', 'scroll_up', 'click', 'fill', 'navigate', 'wait'],
              },
              selector: { type: 'string', description: 'CSS selector (for click/fill)' },
              text: { type: 'string', description: 'Click by visible text (alternative to selector)' },
              value: { type: 'string', description: 'Text to type (for fill)' },
              url: { type: 'string', description: 'URL to navigate to' },
              ms: { type: 'number', description: 'Milliseconds to wait' },
              description: { type: 'string', description: 'Label for the screenshot taken after this action' },
            },
            required: ['type'],
          },
        },
      },
      required: ['url'],
    },
  },
];

// ── Browser helpers ────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

async function extractPageText(page) {
  return page.evaluate(() => {
    document.querySelectorAll('script,style,noscript,svg').forEach((el) => el.remove());
    return (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  });
}

// ── Tool implementations ───────────────────────────────────────────────────

async function searchWeb(query) {
  if (process.env.BRAVE_API_KEY) {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } }
    );
    if (!res.ok) throw new Error(`Brave Search error: ${res.status}`);
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5);
    return results.length
      ? results.map((r) => `**${r.title}**\n${r.url}\n${r.description || ''}`).join('\n\n---\n\n')
      : 'No results found.';
  }

  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExploreAI/1.0)' } }
  );
  const data = await res.json();
  const parts = [];
  if (data.AbstractText) parts.push(`**Summary:** ${data.AbstractText}\nSource: ${data.AbstractURL}`);
  const topics = (data.RelatedTopics || []).filter((t) => t.Text).slice(0, 6).map((t) => `- ${t.Text}`);
  if (topics.length) parts.push('**Related:**\n' + topics.join('\n'));
  return parts.join('\n\n') || `No results for "${query}". Add BRAVE_API_KEY to .env for full search.`;
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) return 'Error: URL must start with http:// or https://';
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);
    const title = await page.title();
    const text = await extractPageText(page);
    return `Title: ${title}\nURL: ${url}\n\n${text.slice(0, 5000)}`;
  } finally {
    await ctx.close();
  }
}

async function screenshotUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(500);
    const title = await page.title();
    const text = await extractPageText(page);
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    return { base64: buf.toString('base64'), title, text: text.slice(0, 3000) };
  } finally {
    await ctx.close();
  }
}

async function exploreUrl(url, actions = []) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');

  const sessionId = `session-${Date.now()}`;
  const browser = await getBrowser();

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
    recordVideo: { dir: RECORDINGS_DIR, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  const screenshots = [];

  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      screenshots.push({ label, data: buf.toString('base64') });
    } catch { /* ignore mid-navigation snapshots */ }
  };

  let title = 'Untitled', pageText = '';

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(800);
    await snap('Initial view');

    if (actions.length === 0) {
      // Auto-explore: scroll through the page
      for (let i = 1; i <= 4; i++) {
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
        await page.waitForTimeout(600);
        await snap(`Scroll ${i}`);
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await page.waitForTimeout(300);
    } else {
      for (const action of actions) {
        try {
          switch (action.type) {
            case 'click':
              if (action.text) {
                await page.getByText(action.text, { exact: false }).first().click({ timeout: 6000 });
              } else {
                await page.click(action.selector, { timeout: 6000 });
              }
              await page.waitForTimeout(900);
              break;
            case 'fill':
              await page.fill(action.selector, action.value, { timeout: 5000 });
              break;
            case 'navigate':
              await page.goto(action.url, { waitUntil: 'networkidle', timeout: 20000 });
              await page.waitForTimeout(600);
              break;
            case 'scroll_down':
              await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
              await page.waitForTimeout(500);
              break;
            case 'scroll_up':
              await page.evaluate(() => window.scrollBy({ top: -600, behavior: 'smooth' }));
              await page.waitForTimeout(500);
              break;
            case 'wait':
              await page.waitForTimeout(action.ms ?? 1000);
              break;
          }
          await snap(action.description || action.type);
        } catch (err) {
          screenshots.push({ label: `${action.type} failed: ${err.message.slice(0, 60)}`, data: null });
        }
      }
    }

    title = await page.title();
    pageText = await extractPageText(page);
  } catch (err) {
    pageText = `Navigation error: ${err.message}`;
  }

  // Capture video path before closing (video is written on context close)
  const videoSavePath = await page.video()?.path();
  await ctx.close();

  // Rename to predictable filename
  let videoUrl = null;
  if (videoSavePath) {
    try {
      const ext = extname(videoSavePath) || '.webm';
      const finalName = `${sessionId}${ext}`;
      renameSync(videoSavePath, join(RECORDINGS_DIR, finalName));
      videoUrl = `/recordings/${finalName}`;
    } catch {
      videoUrl = `/recordings/${basename(videoSavePath)}`;
    }
  }

  return {
    _exploration: {
      sessionId,
      title,
      url,
      text: pageText.slice(0, 3000),
      screenshots: screenshots.filter((s) => s.data).slice(0, 6),
      videoUrl,
    },
  };
}

// ── Tool dispatcher ────────────────────────────────────────────────────────

async function executeTool(name, input) {
  if (name === 'search_web') return await searchWeb(input.query);
  if (name === 'fetch_url') return await fetchUrl(input.url);
  if (name === 'screenshot_url') return { _screenshot: await screenshotUrl(input.url) };
  if (name === 'explore_url') return await exploreUrl(input.url, input.actions || []);
  return `Unknown tool: ${name}`;
}

// ── Memory helpers ─────────────────────────────────────────────────────────

function formatMemoryContext(memories) {
  if (!memories.length) return '';
  const lines = memories.map((m, i) => {
    const date  = new Date(m.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const label = { exploration: 'Exploration', test_plan: 'Test Plan', test_suite: 'Test Suite' }[m.type] ?? m.type;
    return `${i + 1}. **${m.title}** [${label} · ${date}]
   ${m.summary}
   Keywords: ${(m.keywords ?? []).slice(0, 10).join(', ')}`;
  });
  return `## MEMORY: RELEVANT PREVIOUS SESSIONS\n\nThe following previously saved sessions may be relevant. Build on prior work and avoid redundancy:\n\n${lines.join('\n\n')}`;
}

// ── Chat endpoint ──────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let currentMessages = [...messages];

  // Retrieve relevant memories and inject into system prompt
  const firstText = messages.find(m => m.role === 'user')?.content ?? '';
  const relMemories = typeof firstText === 'string' && firstText.length > 3
    ? searchMemory(firstText, { limit: 3 })
    : [];
  if (relMemories.length) {
    send({ memory_context: relMemories.map(({ _score: _, ...m }) => m) });
  }
  const systemText = relMemories.length
    ? `${SYSTEM_PROMPT}\n\n${formatMemoryContext(relMemories)}`
    : SYSTEM_PROMPT;

  try {
    while (true) {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 8096,
        system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: currentMessages,
      });

      stream.on('text', (text) => send({ text }));
      stream.on('streamEvent', (event) => {
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          send({ tool_start: { name: event.content_block.name } });
        }
      });

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason === 'end_turn') break;

      if (finalMessage.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of finalMessage.content) {
          if (block.type !== 'tool_use') continue;

          send({ tool_running: { name: block.name, input: block.input } });

          let raw;
          try {
            raw = await executeTool(block.name, block.input);
          } catch (err) {
            raw = `Tool error: ${err.message}`;
          }

          send({ tool_done: { name: block.name } });

          // ── Exploration result (video + screenshots) ──────────
          if (raw?._exploration) {
            const { sessionId, title, url, text, screenshots, videoUrl } = raw._exploration;
            send({ exploration: { sessionId, title, url, videoUrl, screenshots } });

            // Auto-save exploration to memory so it's available in TestWriter
            const memContent = [
              `# Exploration: ${title}`,
              `URL: ${url}`,
              videoUrl ? `Video: ${videoUrl}` : '',
              `Screenshots: ${screenshots.length}`,
              '',
              '## Page Content',
              text,
            ].filter(Boolean).join('\n');
            saveMemory({
              type: 'exploration',
              content: memContent,
              metadata: { url, sessionId, videoUrl: videoUrl ?? null, screenshotCount: screenshots.length },
            }).then(entry => send({ memory_saved: { id: entry.id, type: 'exploration', title: entry.title } }))
              .catch(() => {});

            const content = [
              {
                type: 'text',
                text: `Explored: ${title}\nURL: ${url}\nVideo: ${videoUrl ?? 'unavailable'}\n\nPage text:\n${text}`,
              },
              ...screenshots.slice(0, 4).map((ss) => ({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: ss.data },
              })),
            ];
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });

          // ── Screenshot result ─────────────────────────────────
          } else if (raw?._screenshot) {
            const { base64, title, text } = raw._screenshot;
            send({ screenshot: { url: block.input.url, title, data: base64 } });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
                { type: 'text', text: `Title: ${title}\nURL: ${block.input.url}\n\n${text}` },
              ],
            });

          // ── Plain text result ─────────────────────────────────
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: typeof raw === 'string' ? raw : JSON.stringify(raw),
            });
          }
        }

        currentMessages.push({ role: 'assistant', content: finalMessage.content });
        currentMessages.push({ role: 'user', content: toolResults });
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    send({ error: err.message });
    res.end();
  }
});

// ── TestWriter agent ───────────────────────────────────────────────────────

const TEST_WRITER_SYSTEM = `You are TestWriter, a specialist QA engineer who transforms exploratory testing findings into comprehensive, structured, executable test cases.

INPUT: You will receive exploratory testing findings — typically a testing charter, risk assessment, test scenarios, edge cases, and cross-cutting concerns from an exploratory testing session.

OUTPUT: Call the create_test_cases tool with every test case you generate.

## TEST CASE RULES

For each exploratory scenario or risk area, generate:
- At least one **Positive** test (happy path / expected flow)
- At least one **Negative** test (invalid input, missing data, error state)
- Edge case tests for every High-priority risk

**ID**: TC-001, TC-002 … (strictly sequential)

**Title**: Verb + Subject, e.g. "Submit Login Form with Valid Credentials", "Attempt Checkout with Expired Card"

**Category**: The feature module (e.g. "Authentication", "Checkout", "User Profile", "Admin Panel")

**Priority**:
- High   — core user flows, authentication, payment, data integrity, security
- Medium — secondary features, validation, search, filtering
- Low    — cosmetic, minor UX, rarely-used paths

**Type**: Positive | Negative | Edge Case | Security | Performance | Accessibility

**Description**: One sentence — "Verifies that [subject] [does/does not] [behaviour] when [condition]."

**Preconditions**: What must be true before the test starts:
- User account state, role, or permissions
- Specific test data that must exist
- Environment or configuration requirements

**Steps**: Numbered imperative sentences. Be specific:
- Use exact navigation paths (/login, Settings → Security)
- Include concrete test data ("Enter a 256-character string", "Use card number 4000000000000002")
- Separate setup, action, and observation steps clearly

**Expected Results**: Bullet points of observable, verifiable outcomes:
- UI changes (messages, redirects, element visibility)
- Data changes (record created / updated / deleted)
- System state (session, cookies, emails, logs)
- Exact error messages where applicable

Generate a minimum of 15 test cases and cover every major risk area from the findings. Quality over speed — every test case must be immediately executable by a human tester with no ambiguity.`;

const TEST_WRITER_TOOLS = [
  {
    name: 'create_test_cases',
    description: 'Output all generated test cases in structured JSON format.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief paragraph summarising the scope analysed and total test coverage.',
        },
        test_cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:               { type: 'string', description: 'e.g. TC-001' },
              title:            { type: 'string' },
              category:         { type: 'string' },
              priority:         { type: 'string', enum: ['High', 'Medium', 'Low'] },
              type:             { type: 'string', enum: ['Positive', 'Negative', 'Edge Case', 'Security', 'Performance', 'Accessibility'] },
              description:      { type: 'string' },
              preconditions:    { type: 'array', items: { type: 'string' } },
              steps:            { type: 'array', items: { type: 'string' } },
              expected_results: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'title', 'category', 'priority', 'type', 'description', 'preconditions', 'steps', 'expected_results'],
          },
        },
      },
      required: ['summary', 'test_cases'],
    },
  },
];

function buildWriterPrompt(findings, memoryIds = []) {
  let ctx = '';
  if (memoryIds.length) {
    const snippets = memoryIds
      .map(id => getMemory(id))
      .filter(Boolean)
      .map(m => {
        const label = { test_suite: 'Previous Test Suite', test_plan: 'Previous Test Plan', exploration: 'Previous Exploration' }[m.type] ?? m.type;
        return `### ${label}: ${m.title}\n${m.summary}\nKeywords: ${(m.keywords ?? []).join(', ')}\n\nContent (excerpt):\n${m.content.slice(0, 1500)}`;
      });
    if (snippets.length) {
      ctx = `\n\n## MEMORY: RELEVANT PREVIOUS TEST SUITES\n\nReference these for consistency, completeness, and to avoid duplication:\n\n${snippets.join('\n\n---\n\n')}`;
    }
  }
  return `Transform the following exploratory testing findings into a comprehensive, structured test case suite:\n\n${findings}${ctx}`;
}

app.post('/api/write-tests', async (req, res) => {
  const { findings, memoryIds = [] } = req.body;
  if (!findings || typeof findings !== 'string' || !findings.trim()) {
    return res.status(400).json({ error: 'findings text is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Stream input_json_delta events so the client can show a live counter
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: [{ type: 'text', text: TEST_WRITER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TEST_WRITER_TOOLS,
      tool_choice: { type: 'any' }, // always call create_test_cases
      messages: [
        {
          role: 'user',
          content: buildWriterPrompt(findings, memoryIds),
        },
      ],
    }, {
      headers: { 'anthropic-beta': 'output-128k-2025-02-19' },
    });

    // Count TC-### matches as JSON streams to show live progress
    let jsonBuffer = '';
    let tcCount = 0;
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        jsonBuffer += event.delta.partial_json ?? '';
        const matches = (jsonBuffer.match(/"id"\s*:\s*"TC-/g) || []).length;
        if (matches > tcCount) {
          tcCount = matches;
          send({ progress: { count: tcCount } });
        }
      }
    });

    const finalMessage = await stream.finalMessage();
    const toolUse = finalMessage.content.find((b) => b.type === 'tool_use' && b.name === 'create_test_cases');

    if (toolUse) {
      send({ test_cases: toolUse.input });
    } else {
      send({ error: 'Agent did not return structured test cases. Please try again.' });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    send({ error: err.message });
    res.end();
  }
});

// ── PlaywrightCoder agent ──────────────────────────────────────────────────

const PLAYWRIGHT_CODER_SYSTEM = `You are PlaywrightCoder, an expert Playwright test automation engineer specialising in TypeScript.

Given a set of manual test cases, generate production-ready Playwright test code following best practices.

## OUTPUT FILE STRUCTURE

Always generate ALL of these files:
1. **playwright.config.ts** — config with baseURL, timeouts, reporter, and screenshot-on-failure
2. **fixtures/base.ts** — custom test fixtures extending Playwright's base; one fixture per Page Object
3. **pages/<FeaturePage>.ts** — one Page Object Model file per feature area (group related pages)
4. **tests/<category>.spec.ts** — test files grouped by category (one file per unique category)

## PAGE OBJECT MODEL RULES
- Constructor takes \`readonly page: Page\`
- Declare all locators as \`readonly\` class fields using \`page.locator()\`
- Locator priority: data-testid → aria-label/role → visible text → placeholder → CSS → XPath
- Add async action methods that encapsulate multi-step interactions (e.g. \`login(email, password)\`)
- Add \`async goto()\` for navigation to the page's primary URL
- Never add assertions inside POMs — keep them in tests

## TEST RULES
- Each test must be fully independent — no shared mutable state
- Use \`test.describe('Category Name', () => { ... })\` to group tests from the same category
- Title format: \`'TC-XXX: Exact title from test case'\`
- Always use fixtures (never \`new PageObject(page)\` inside tests)
- Use \`test.beforeEach\` for navigation when all tests in a describe start on the same page
- Map each expected_result to a specific \`expect()\` assertion
- For Security tests requiring a proxy tool: add \`test.skip(true, 'Manual step: requires Burp Suite or similar')\` with a comment block explaining the manual steps
- For Performance tests: use \`page.waitForLoadState('networkidle')\` and check timing via \`page.evaluate(() => performance.timing)\`
- For Accessibility tests: add an import comment for @axe-core/playwright; use \`expect(locator)\` checks as the implementation

## TYPESCRIPT STYLE
- Use TypeScript with strict mode implied
- Import types from '@playwright/test'
- No \`any\` types
- Prefer \`async/await\` over promise chains

Generate complete, immediately runnable code. Call generate_playwright_code with all files.`;

const PLAYWRIGHT_CODER_TOOLS = [
  {
    name: 'generate_playwright_code',
    description: 'Output all generated Playwright TypeScript files.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary: number of files, page objects, and tests generated.',
        },
        install_note: {
          type: 'string',
          description: 'npm install command needed to run the tests (e.g. playwright, axe-core if used).',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path:    { type: 'string', description: 'Relative path e.g. playwright.config.ts or pages/LoginPage.ts' },
              content: { type: 'string', description: 'Full file content, ready to save and run' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['summary', 'files'],
    },
  },
];

app.post('/api/generate-playwright', async (req, res) => {
  const { testCases, appUrl } = req.body;
  if (!testCases || !Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'testCases array is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const casesText = testCases.map(tc => [
      `### ${tc.id}: ${tc.title}`,
      `Category: ${tc.category} | Priority: ${tc.priority} | Type: ${tc.type}`,
      `Description: ${tc.description}`,
      tc.preconditions?.length ? `Preconditions:\n${tc.preconditions.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}` : '',
      `Steps:\n${tc.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
      `Expected Results:\n${tc.expected_results.map(r => `  - ${r}`).join('\n')}`,
    ].filter(Boolean).join('\n')).join('\n\n---\n\n');

    const prompt = `Generate complete Playwright TypeScript test code for the ${testCases.length} test case(s) below.

Application base URL: ${appUrl || 'http://localhost:3000'}

## TEST CASES

${casesText}`;

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: [{ type: 'text', text: PLAYWRIGHT_CODER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: PLAYWRIGHT_CODER_TOOLS,
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { 'anthropic-beta': 'output-128k-2025-02-19' },
    });

    let pwFileCount = 0;
    let pwJsonBuf = '';
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        pwJsonBuf += event.delta.partial_json ?? '';
        const cnt = (pwJsonBuf.match(/"path"\s*:\s*"/g) || []).length;
        if (cnt > pwFileCount) {
          pwFileCount = cnt;
          send({ progress: { files: pwFileCount } });
        }
      }
    });

    const finalMessage = await stream.finalMessage();
    const toolUse = finalMessage.content.find(b => b.type === 'tool_use' && b.name === 'generate_playwright_code');

    if (toolUse) {
      send({ playwright_code: toolUse.input });
    } else {
      send({ error: 'Agent did not return code. Please try again.' });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    send({ error: err.message });
    res.end();
  }
});

// ── Memory REST endpoints ──────────────────────────────────────────────────

app.get('/api/memory/stats', (_req, res) => res.json(memoryStats()));

app.get('/api/memory', (req, res) => {
  const { type, limit } = req.query;
  res.json(listMemories({ type: type || null, limit: parseInt(limit) || 100 }));
});

app.post('/api/memory/search', (req, res) => {
  const { query = '', type, limit } = req.body;
  res.json(searchMemory(query, { type: type || null, limit: parseInt(limit) || 5 }));
});

app.post('/api/memory/save', async (req, res) => {
  const { type, content, metadata } = req.body;
  if (!type || !content) return res.status(400).json({ error: 'type and content are required' });
  try {
    const entry = await saveMemory({ type, content, metadata: metadata ?? {} });
    res.json({ id: entry.id, title: entry.title, summary: entry.summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/:id', (req, res) => {
  const entry = getMemory(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

app.delete('/api/memory/:id', (req, res) => {
  res.json({ deleted: deleteMemory(req.params.id) });
});

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nExploreAI   → http://localhost:${PORT}/testing-agent.html`);
  console.log(`TestWriter  → http://localhost:${PORT}/test-writer.html`);
  console.log(`Recordings  → ${RECORDINGS_DIR}\n`);
  if (!process.env.BRAVE_API_KEY) {
    console.log('  Tip: set BRAVE_API_KEY in .env for full web search.\n');
  }
});
