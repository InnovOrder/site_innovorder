#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const origin = 'https://staging.innovorder.io';
const site = JSON.parse(await readFile(new URL('../src/site.json', import.meta.url), 'utf8'));
const attempts = process.argv.includes('--wait') ? 30 : 1;

async function request(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
}

async function verify() {
  for (const path of ['/', '/prix', '/en/price', '/blog/comment-ouvrir-une-dark-kitchen']) {
    const response = await request(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, path);
    assert.match(await response.text(), /<meta name="robots" content="noindex"/, path);
  }
  const asset = await request(new URL(site.favicon, origin));
  assert.equal(asset.status, 200, 'favicon');
  assert.match(asset.headers.get('content-type') ?? '', /^image\//, 'favicon');
  await asset.arrayBuffer();

  const missing = await request(origin + '/__staging-smoke-missing__');
  assert.equal(missing.status, 404, 'missing page');
  await missing.text();

  for (const [url, destination] of [
    ['http://staging.innovorder.io/prix?test=1', origin + '/prix?test=1'],
    [origin + '/frigo-connecte', origin + '/frigo-connecte-entreprise'],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 301, url);
    assert.equal(new URL(response.headers.get('location'), url).href, destination, url);
    await response.text();
  }
}

for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    await verify();
    console.log('Staging verified: HTTPS, FR/EN pages, nested route, asset, noindex, 301 and 404.');
    break;
  } catch (error) {
    if (attempt === attempts) throw error;
    console.log(`Staging not ready (${attempt}/${attempts}): ${error.message}`);
    await setTimeout(10_000);
  }
}
