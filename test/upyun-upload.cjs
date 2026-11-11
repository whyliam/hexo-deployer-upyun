'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const UpYun = require('upyun');
const isUploadResult = require('../lib/upload-result');

test('accepts real SDK image metadata and ordinary-file success without accepting failures', async t => {
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume upload */ }
    const image = req.url.endsWith('.png');
    res.writeHead(200, image ? { 'x-upyun-file-type': 'PNG', 'x-upyun-width': '16', 'x-upyun-height': '16' } : {});
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new UpYun.Client(new UpYun.Service('fixture', 'test-operator', 'test-password'), {
    protocol: 'http', domain: `127.0.0.1:${server.address().port}`, proxy: false
  });
  const ordinary = await client.putFile('index.html', Buffer.from('html'));
  const image = await client.putFile('image.png', Buffer.from('fixture'));
  assert.equal(ordinary, true);
  assert.equal(typeof image, 'object');
  assert.equal(image.width, 16);
  assert.equal(isUploadResult(ordinary), true);
  assert.equal(isUploadResult(image), true);
  for (const failure of [false, null, undefined, {}, { error: 'failed' }]) assert.equal(isUploadResult(failure), false);
});
