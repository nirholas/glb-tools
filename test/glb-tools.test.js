import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlbTools, ThreeWsError, PaymentRequiredError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A synthetic $THREE-style mint; never a real third-party address.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

test('inspect() passes the url as a query param and shapes the report', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				url: 'https://three.ws/sample.glb',
				fetchedBytes: 1572864,
				model: { container: 'glb', counts: { skins: 1, totalTriangles: 24812 }, textures: [], materials: [] },
				suggestions: [{ id: 'ok', severity: 'info', message: 'looks good' }],
			},
		},
	]);
	const client = createGlbTools({ fetch, baseUrl: 'https://three.ws' });
	const report = await client.inspect('https://three.ws/sample.glb');

	assert.equal(calls[0].url.pathname, '/api/x402/model-check');
	assert.equal(calls[0].url.searchParams.get('url'), 'https://three.ws/sample.glb');
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(report.fetchedBytes, 1572864);
	assert.equal(report.model.counts.skins, 1);
	assert.equal(report.suggestions[0].id, 'ok');
	assert.equal(report.raw.model.container, 'glb');
});

test('inspect() forwards payWith as a billing-lane header', async () => {
	const { fetch, calls } = stubFetch([{ body: { url: 'x', fetchedBytes: 1, model: {}, suggestions: [] } }]);
	const client = createGlbTools({ fetch });
	await client.inspect('https://three.ws/a.glb', { payWith: 'credits' });
	assert.equal(calls[0].init.headers['x-pay-with'], 'credits');
});

test('theme() decodes the base64 GLB into bytes and shapes the theme', async () => {
	const glbBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00]); // "glTF" + ver
	const base64 = Buffer.from(glbBytes).toString('base64');
	const { fetch, calls } = stubFetch([
		{
			body: {
				mint: THREE_MINT,
				theme: { name: 'three', symbol: 'THREE', color: [0.92, 0.45, 0.18], imageUrl: null, hasImage: false },
				glb: { mimeType: 'model/gltf-binary', bytes: glbBytes.length, base64 },
			},
		},
	]);
	const client = createGlbTools({ fetch });
	const out = await client.theme(THREE_MINT);

	assert.equal(calls[0].url.pathname, '/api/x402/mint-to-mesh');
	assert.equal(calls[0].url.searchParams.get('mint'), THREE_MINT);
	assert.equal(out.theme.symbol, 'THREE');
	assert.deepEqual(out.theme.color, [0.92, 0.45, 0.18]);
	assert.equal(out.glb.bytes, glbBytes.length);
	assert.ok(out.bytes instanceof Uint8Array);
	assert.deepEqual([...out.bytes], [...glbBytes]);
});

test('theme() rejects a non-base58 mint before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createGlbTools({ fetch });
	await assert.rejects(() => client.theme('not a mint!'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_mint');
		return true;
	});
	await assert.rejects(() => client.theme(''), (e) => {
		assert.equal(e.code, 'invalid_input');
		return true;
	});
	assert.equal(calls.length, 0);
});

test('bake() PATCHes the appearance and reads baked fields off the avatar', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				avatar: {
					id: 'avatar_8f3a',
					baked_storage_key: 'u/u1/slug/baked-abc123.glb',
					appearance_hash: 'deadbeef',
					size_bytes: 50768,
				},
			},
		},
	]);
	const client = createGlbTools({ fetch });
	const res = await client.bake('avatar_8f3a', { outfit: 'streetwear-01' }, { token: 'owner_tok' });

	assert.equal(calls[0].url.pathname, '/api/avatars/avatar_8f3a');
	assert.equal(calls[0].init.method, 'PATCH');
	assert.equal(calls[0].init.headers.authorization, 'Bearer owner_tok');
	assert.deepEqual(JSON.parse(calls[0].init.body), { appearance: { outfit: 'streetwear-01' } });
	assert.equal(res.bakedStorageKey, 'u/u1/slug/baked-abc123.glb');
	assert.equal(res.appearanceHash, 'deadbeef');
	assert.equal(res.sizeBytes, 50768);
	assert.equal(res.cleared, false);
});

test('bake(null) clears the baked GLB and reports cleared=true', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { avatar: { id: 'a1', baked_storage_key: null, appearance_hash: null } } },
	]);
	const client = createGlbTools({ fetch });
	const res = await client.bake('a1', null, { token: 't' });
	assert.deepEqual(JSON.parse(calls[0].init.body), { appearance: null });
	assert.equal(res.cleared, true);
	assert.equal(res.bakedStorageKey, null);
});

test('402 surfaces as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '1000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createGlbTools({ fetch });
	await assert.rejects(() => client.inspect('https://three.ws/a.glb'), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('invalid_url (400) surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 400, body: { error: 'invalid_url', message: 'not fetchable' } }]);
	const client = createGlbTools({ fetch });
	await assert.rejects(() => client.theme(THREE_MINT), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_url');
		assert.equal(e.status, 400);
		return true;
	});
});

test('missing inputs reject before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createGlbTools({ fetch });
	await assert.rejects(() => client.inspect(''), /needs a GLB/);
	await assert.rejects(() => client.bake('', {}), /needs an avatar id/);
	await assert.rejects(() => client.bake('a1', [1, 2]), /must be an object/);
	assert.equal(calls.length, 0);
});
