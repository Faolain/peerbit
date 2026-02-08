/**
 * Playwright test for timeline slider state replay.
 * Run: node docs/test-timeline-playwright.mjs
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else { console.log('  OK:', msg); }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  const filePath = resolve(__dirname, 'architecture-viz.html');
  await page.goto('file://' + filePath);
  await page.waitForTimeout(500);

  // --- Test: Page loads without JS errors ---
  console.log('\n--- Test: Page loads without errors ---');
  assert(consoleErrors.length === 0, 'No console errors on load: ' + (consoleErrors.length > 0 ? consoleErrors.join('; ') : 'clean'));

  // --- Load scenario ---
  console.log('\n--- Test: Load scenario ---');
  const options = await page.evaluate(() => {
    const sel = document.getElementById('scenario-select');
    return [...sel.options].map((o, i) => ({ index: i, value: o.value, text: o.text }));
  });
  console.log('  Scenarios:', options.map(o => o.text).join(', '));

  if (options.length > 1) {
    await page.selectOption('#scenario-select', options[1].value);
  }
  await page.waitForTimeout(3000); // Wait for scenario events

  const eventCount = await page.evaluate(() => engine.eventLog.length);
  console.log('  Events after scenario:', eventCount);
  assert(eventCount > 3, 'Scenario generated events (got ' + eventCount + ')');

  const stateHistoryLen = await page.evaluate(() => engine.stateHistory.length);
  console.log('  stateHistory.length:', stateHistoryLen);
  assert(stateHistoryLen === eventCount, 'stateHistory.length (' + stateHistoryLen + ') matches eventLog.length (' + eventCount + ')');

  // --- Test: Slider max ---
  console.log('\n--- Test: Slider max matches events ---');
  const sliderMax = await page.evaluate(() => +document.getElementById('timeline-slider').max);
  assert(sliderMax === eventCount - 1, 'slider.max (' + sliderMax + ') === eventCount-1 (' + (eventCount - 1) + ')');

  // --- Record full state for comparison ---
  const fullNodeCount = await page.evaluate(() => engine.nodes.size);
  const fullConnCount = await page.evaluate(() => engine.connections.size);
  console.log('  Full state: ' + fullNodeCount + ' nodes, ' + fullConnCount + ' connections');

  // --- Test: seekTo(0) ---
  console.log('\n--- Test: seekTo(0) restores first event state ---');
  consoleErrors.length = 0;

  await page.evaluate(() => timeline.seekTo(0));

  const seek0Errors = [...consoleErrors];
  const seek0Nodes = await page.evaluate(() => engine.nodes.size);
  const seek0Conns = await page.evaluate(() => engine.connections.size);
  const seek0Counter = await page.evaluate(() => document.getElementById('event-counter').textContent);
  const seek0Desc = await page.evaluate(() => document.getElementById('event-description').textContent);
  const seek0Index = await page.evaluate(() => timeline.currentIndex);

  console.log('  Errors:', seek0Errors.length > 0 ? seek0Errors.join('; ') : 'none');
  console.log('  currentIndex:', seek0Index);
  console.log('  Counter text:', seek0Counter);
  console.log('  Description:', seek0Desc);
  console.log('  Nodes:', seek0Nodes, ' Connections:', seek0Conns);

  assert(seek0Errors.length === 0, 'No errors during seekTo(0)');
  assert(seek0Index === 0, 'currentIndex is 0');
  assert(seek0Counter.includes('1 /'), 'Counter shows event 1 (got: ' + seek0Counter + ')');
  assert(seek0Desc.length > 5, 'Description is not empty');
  assert(seek0Nodes <= 1, 'At event 0, at most 1 node (got ' + seek0Nodes + ')');
  assert(seek0Conns === 0, 'At event 0, 0 connections (got ' + seek0Conns + ')');

  // --- Test: seekTo(end) restores full state ---
  console.log('\n--- Test: seekTo(end) restores full state ---');
  consoleErrors.length = 0;

  await page.evaluate(() => timeline.seekTo(engine.eventLog.length - 1));

  const endNodes = await page.evaluate(() => engine.nodes.size);
  const endConns = await page.evaluate(() => engine.connections.size);

  assert(endNodes === fullNodeCount, 'End nodes (' + endNodes + ') === full (' + fullNodeCount + ')');
  assert(endConns === fullConnCount, 'End conns (' + endConns + ') === full (' + fullConnCount + ')');
  assert(consoleErrors.length === 0, 'No errors during seekTo(end)');

  // --- Test: Slider input event ---
  console.log('\n--- Test: Slider oninput triggers seekTo ---');
  consoleErrors.length = 0;

  await page.evaluate(() => {
    const slider = document.getElementById('timeline-slider');
    slider.value = '0';
    slider.dispatchEvent(new Event('input'));
  });

  const inputIndex = await page.evaluate(() => timeline.currentIndex);
  const inputNodes = await page.evaluate(() => engine.nodes.size);
  const inputCounter = await page.evaluate(() => document.getElementById('event-counter').textContent);

  assert(inputIndex === 0, 'Slider input set currentIndex to 0 (got ' + inputIndex + ')');
  assert(inputNodes <= 1, 'Slider input restored state (nodes=' + inputNodes + ')');
  assert(inputCounter.includes('1 /'), 'Counter updated from slider (got: ' + inputCounter + ')');
  assert(consoleErrors.length === 0, 'No errors from slider input: ' + consoleErrors.join('; '));

  // --- Test: stepForward / stepBack ---
  console.log('\n--- Test: Step forward/back ---');
  await page.evaluate(() => timeline.seekTo(0));
  await page.evaluate(() => timeline.stepForward());
  const fwdIndex = await page.evaluate(() => timeline.currentIndex);
  assert(fwdIndex === 1, 'stepForward → index 1 (got ' + fwdIndex + ')');

  await page.evaluate(() => timeline.stepBack());
  const backIndex = await page.evaluate(() => timeline.currentIndex);
  assert(backIndex === 0, 'stepBack → index 0 (got ' + backIndex + ')');

  // --- Test: Sidebar highlighting ---
  console.log('\n--- Test: Sidebar event highlighting ---');
  await page.evaluate(() => timeline.seekTo(3));
  const activeCount = await page.evaluate(() => document.querySelectorAll('.event-row.active').length);
  const activeIdx = await page.evaluate(() => {
    const rows = document.getElementById('event-list').children;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].classList.contains('active')) return i;
    }
    return -1;
  });
  assert(activeCount === 1, 'Exactly 1 active event row (got ' + activeCount + ')');
  assert(activeIdx === 3, 'Active row is index 3 (got ' + activeIdx + ')');

  // --- Test: State increases monotonically through events ---
  console.log('\n--- Test: Node count increases through early events ---');
  let prevNodes = 0;
  let monotonicOk = true;
  for (let i = 0; i < Math.min(eventCount, 5); i++) {
    await page.evaluate((idx) => timeline.seekTo(idx), i);
    const n = await page.evaluate(() => engine.nodes.size);
    if (n < prevNodes) { monotonicOk = false; console.log('  Event ' + i + ': nodes=' + n + ' < prev=' + prevNodes); }
    prevNodes = n;
  }
  assert(monotonicOk, 'Node count is non-decreasing in first 5 events');

  // --- Final error check ---
  console.log('\n--- Final error check ---');
  assert(consoleErrors.length === 0, 'No accumulated JS errors');

  await browser.close();

  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
