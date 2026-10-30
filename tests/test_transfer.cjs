// Exercise the real page scripts and wire packets without camera hardware or CDN access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page(filename) {
    const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const elements = new Map();
    const downloads = [];
    const blobs = [];
    const timers = new Map();
    let nextTimer = 0;
    function element(id, classes = '') {
        const names = new Set(classes.split(/\s+/));
        const el = {
            id, value: '', style: {}, textContent: '', innerText: '',
            classList: {
                add: name => names.add(name), remove: name => names.delete(name),
                contains: name => names.has(name),
                toggle(name, force) {
                    if (force ?? !names.has(name)) names.add(name); else names.delete(name);
                },
            },
            appendChild(child) { elements.set(child.id, child); },
            focus() { el.focused = true; },
            select() { el.selected = true; },
            setSelectionRange(start, end) { el.selection = [start, end]; },
            click() { downloads.push(el.download); },
        };
        return el;
    }
    for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        elements.set(tag[1], element(tag[1], tag[0].match(/class="([^"]*)"/)?.[1]));
    }
    let randomSeed = 12345;
    const math = Object.create(Math);
    math.random = () => ((randomSeed = randomSeed * 16807 % 2147483647) - 1) / 2147483646;
    const context = vm.createContext({
        document: {
            getElementById: id => elements.get(id), createElement: () => element(''),
            execCommand: () => true,
        },
        window: {}, navigator: {}, TextEncoder, TextDecoder, Uint8Array, Blob,
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; } },
        atob, btoa, Math: math, console,
        setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearInterval(id) { timers.delete(id); },
        QRious: function () {}, alert(message) { throw new Error(message); },
        FileReader: class {
            readAsArrayBuffer(file) { this.onload({ target: { result: file.bytes.buffer } }); }
        },
    });
    const run = code => vm.runInContext(code, context, { timeout: 1500 });
    // Only the app script is needed, including when exercising the embedded HTML.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    vm.runInContext(scripts.at(-1)[1], context);
    run('if (window.onload) window.onload()');
    return { run, context, elements, downloads, blobs, timers, fountain: filename.includes('fountain') };
}

function transfer(tx, rx, { text, bytes, filename, legacy = false, shortSeed = false, usePrepared = false }) {
    if (!usePrepared) {
        tx.run('resetFile()');
        if (bytes) {
            tx.context.testFile = { name: filename, bytes: Uint8Array.from(bytes) };
            tx.run("document.getElementById('fileInput').onchange({target: {files: [testFile]}})");
        } else {
            tx.elements.get('inputText').value = text;
        }
    }
    rx.run('recv.active = true; recv.isFinishing = false');
    tx.run(tx.fountain ? 'startSending()' : 'prepareSending()');
    const receive = packet => {
        if (legacy) {
            const parts = packet.split('|');
            if (tx.fountain) parts[4] = parts[4].split(':').slice(0, 2).join(':');
            else parts.pop();
            packet = parts.join('|');
        }
        rx.context.packet = packet;
        rx.run(tx.fountain ? 'handleFountainPacket(packet)' : 'handleDecoded(packet)');
    };
    if (tx.fountain) {
        if (shortSeed) tx.run('Math.random = () => 0.07'); // Seed 70000 selects degree 2 before clamping.
        for (let i = 0; i < 2000 && !rx.run('recv.isFinishing'); i++) {
            tx.run('tick()');
            for (const packet of tx.run('sender.qrs.map(q => q.value)')) receive(packet);
        }
        assert.equal(rx.run('recv.isFinishing'), true, 'fountain reconstruction completes');
    } else {
        const count = tx.run('state.chunks.length');
        // Receive out of order with a duplicate to exercise reassembly.
        for (const i of [count - 1, ...Array.from({ length: count }, (_, i) => i)]) {
            tx.run(`state.frameIdx = ${i}; renderFrame()`);
            receive(tx.run('state.qr.value'));
        }
    }
    assert.equal(rx.elements.get('successCard').classList.contains('hidden'), false);
}

for (const filename of ['index.html', 'airscan-fountain.html',
    'release/index-embedded.html', 'release/airscan-fountain-embedded.html']) {
    test(`${filename}: receive, switch tab, forward text/files without reselecting`, async () => {
        const source = page(filename), relay = page(filename), destination = page(filename);
        const sender = relay.fountain ? 'sender' : 'state';
        const fileCard = relay.elements.get(relay.fountain ? 'fileInfo' : 'fileCard');
        // Leave an existing broadcast running: importing new content must stop its timer.
        transfer(relay, page(filename), { text: '中转手机之前发送的内容' });
        if (!relay.fountain) relay.run('state.isPaused = true');
        relay.run("switchTab('receive')");
        const text = '  中转文字🙂\n第二行 | : <b>原文</b>  '.repeat(30);
        transfer(source, relay, { text });
        assert.notEqual(relay.elements.get('inputText').value, text, 'load on switch, not during receiving');
        relay.run("switchTab('send')");
        assert.equal(relay.elements.get('inputText').value, text);
        assert.equal(relay.run(`${sender}.rawData`), null);
        assert.equal(relay.run(`${sender}.timer`), null);
        assert.equal(relay.run(`${sender}.chunks.length`), 0);
        assert.equal(relay.elements.get('playerBox').classList.contains('hidden'), true);
        assert.equal(fileCard.classList.contains('hidden'), true);
        if (!relay.fountain) {
            assert.equal(relay.run('state.isSending'), false);
            assert.equal(relay.run('state.isPaused'), false);
        }
        transfer(relay, destination, { usePrepared: true });
        assert.equal(destination.elements.get('receivedText').value, text);
        relay.elements.get('inputText').value = '手动编辑后的文字';
        relay.run("switchTab('receive'); switchTab('send')");
        assert.equal(relay.elements.get('inputText').value, '手动编辑后的文字');

        // A text file stays a file, and arbitrary binary bytes survive two transfers.
        for (const [name, bytes] of [
            ['中文中转.txt', new TextEncoder().encode('这是文件内容🙂\n仍作为文件转发')],
            ['原始数据.bin', Uint8Array.from({ length: 2048 }, (_, i) => i % 256)],
        ]) {
            transfer(source, relay, { filename: name, bytes });
            relay.run("switchTab('send')");
            assert.equal(relay.elements.get('inputText').value, '');
            assert.equal(relay.run(`${sender}.fileName`), name);
            assert.equal(fileCard.classList.contains('hidden'), false);
            transfer(relay, destination, { usePrepared: true });
            assert.equal(destination.elements.get('textResult').classList.contains('hidden'), true);
            destination.elements.get('dlBtn').onclick();
            assert.equal(destination.downloads.at(-1), name);
            assert.deepEqual(new Uint8Array(await destination.blobs.at(-1).arrayBuffer()), bytes);
            relay.run("resetFile(); switchTab('receive'); switchTab('send')");
            assert.equal(relay.run(`${sender}.rawData`), null, 'cancelled file is not restored');
            assert.equal(fileCard.classList.contains('hidden'), true);
        }
        // A new text reception replaces the preceding file on the next switch.
        transfer(source, relay, { filename: '旧文件.txt', bytes: new TextEncoder().encode('旧文件') });
        relay.run("switchTab('send')");
        transfer(source, relay, { text: '文件之后的新文字' });
        relay.run("switchTab('send')");
        assert.equal(relay.run(`${sender}.rawData`), null);
        assert.equal(fileCard.classList.contains('hidden'), true);
        transfer(relay, destination, { usePrepared: true });
        assert.equal(destination.elements.get('receivedText').value, '文件之后的新文字');
    });

    test(`${filename}: text round trip, copy, file transitions, legacy fallback`, async () => {
        const tx = page(filename), rx = page(filename);
        const text = '  中文🙂 | : <script>alert("安全")</script>\n\n第二行\t空白  '.repeat(20);
        transfer(tx, rx, { text });
        assert.equal(rx.elements.get('receivedText').value, text);
        assert.equal(rx.elements.get('textResult').classList.contains('hidden'), false);
        assert.equal(rx.elements.get('dlBtn').classList.contains('hidden'), true);
        assert.equal(rx.blobs.length, 0, 'text creates no download blob');
        let copied;
        rx.context.navigator.clipboard = { async writeText(value) { copied = value; } };
        await rx.run('copyReceivedText()');
        assert.equal(copied, text);
        assert.equal(rx.elements.get('copyStatus').textContent, '已复制');
        // Unavailable or rejected Clipboard API falls back for offline/HTTP pages.
        rx.context.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
        await rx.run('copyReceivedText()');
        assert.equal(rx.elements.get('receivedText').selected, true);
        rx.context.navigator.clipboard = undefined;
        rx.context.document.execCommand = () => false;
        await rx.run('copyReceivedText()');
        assert.match(rx.elements.get('copyStatus').textContent, /Ctrl\/Cmd\+C/);

        for (const [name, bytes] of [
            ['note_1234.txt', new TextEncoder().encode('文件内的文字🙂')],
            ['binary.bin', Uint8Array.from([0, 255, 128, 13, 10, 0, 42])],
        ]) {
            transfer(tx, rx, { filename: name, bytes });
            assert.equal(rx.elements.get('textResult').classList.contains('hidden'), true);
            assert.equal(rx.elements.get('receivedText').value, '');
            assert.equal(rx.elements.get('dlBtn').classList.contains('hidden'), false);
            rx.elements.get('dlBtn').onclick();
            assert.equal(rx.downloads.at(-1), name);
            assert.deepEqual(new Uint8Array(await rx.blobs.at(-1).arrayBuffer()), bytes);
        }
        transfer(tx, rx, { text: '再次发送文字' });
        assert.equal(rx.elements.get('receivedText').value, '再次发送文字');
        assert.equal(rx.elements.get('dlBtn').onclick, null);
        assert.equal(rx.elements.get('copyStatus').textContent, '');
        transfer(tx, rx, { text: '旧发送端文字', legacy: true });
        assert.equal(rx.elements.get('textResult').classList.contains('hidden'), true);
        assert.equal(rx.elements.get('dlBtn').classList.contains('hidden'), false);
    });

    if (filename.includes('fountain')) {
        test(`${filename}: pending equations advance progress before cascading decode`, async () => {
            const tx = page(filename), rx = page(filename);
            const bytes = Uint8Array.from({ length: 8 * 220 }, (_, i) => (i * 17 + Math.floor(i / 220)) % 256);
            tx.context.testFile = { name: 'progress.bin', bytes };
            tx.run("document.getElementById('fileInput').onchange({target: {files: [testFile]}}); startSending()");
            // Find real encoder seeds for a chain of dependent-on-neighbours equations.
            // Seven independent pairs contain information but cannot yet expose any block.
            const seeds = tx.run(`(() => {
                const wanted = new Set(['0,1', '1,2', '2,3', '3,4', '4,5', '5,6', '6,7', '7', '0,2']);
                const found = {};
                for (let seed = 1; seed < 1000000 && wanted.size; seed++) {
                    const rng = Utils.PRNG(seed);
                    const degree = Math.min(8, Utils.getDegree(8, rng));
                    if (degree > 2) continue;
                    const indices = [];
                    while (indices.length < degree) {
                        const index = Math.floor(rng() * 8);
                        if (!indices.includes(index)) indices.push(index);
                    }
                    const key = indices.sort((a, b) => a - b).join(',');
                    if (wanted.delete(key)) found[key] = seed;
                }
                if (wanted.size) throw new Error('Missing packet seeds');
                return found;
            })()`);
            rx.run('recv.active = true');
            function deliver(key) {
                tx.context.seed = seeds[key];
                tx.run('Math.random = () => seed / 1000000; tick()');
                rx.context.packet = tx.run('sender.qrs[0].value');
                rx.run('handleFountainPacket(packet)');
            }
            for (let i = 0; i < 7; i++) {
                deliver(`${i},${i + 1}`);
                assert.equal(rx.run('Object.keys(recv.solved).length'), 0);
                assert.equal(rx.elements.get('pctText').innerText, Math.floor((i + 1) / 8 * 100));
                assert.equal(rx.elements.get('successCard').classList.contains('hidden'), true);
                if (i === 1) {
                    deliver('0,1'); // Duplicate equation.
                    deliver('0,2'); // Different packet, but redundant with the first two pairs.
                    assert.equal(rx.elements.get('pctText').innerText, 25);
                }
            }
            assert.match(rx.elements.get('recvRank').innerText, /有效数据: 7 \/ 8 · 已还原: 0 \/ 8/);
            deliver('7'); // One final block unlocks all eight blocks at once.
            assert.equal(rx.elements.get('pctText').innerText, 100);
            assert.equal(rx.run('Object.keys(recv.solved).length'), 8);
            rx.elements.get('dlBtn').onclick();
            assert.deepEqual(new Uint8Array(await rx.blobs.at(-1).arrayBuffer()), bytes);
        });

        test(`${filename}: slower default and live speed changes keep a single broadcast timer`, () => {
            const tx = page(filename);
            assert.equal(tx.run('sender.fps'), 6);
            tx.elements.get('inputText').value = '慢速摄像头测试';
            tx.run('startSending()');
            assert.equal(tx.timers.size, 1);
            assert.equal([...tx.timers.values()][0].delay, 1000 / 6);
            const tid = tx.run('sender.tid');
            tx.run('setSendingFps(3)');
            assert.equal(tx.run('sender.tid'), tid, 'speed changes preserve transfer identity');
            assert.equal(tx.timers.size, 1);
            assert.equal([...tx.timers.values()][0].delay, 1000 / 3);
            assert.equal(tx.elements.get('fpsVal').innerText, 3);
            tx.run('startSending()');
            assert.equal(tx.timers.size, 1, 'restarting must not accumulate timers');
            tx.run('stopSending(); setSendingFps(5)');
            assert.equal(tx.timers.size, 0, 'adjusting after stop must not resume broadcasting');
            assert.equal(tx.run('sender.timer'), null);
        });

        test(`${filename}: single-chunk short sentence completes for degree 2 seed`, () => {
            const tx = page(filename), rx = page(filename);
            transfer(tx, rx, { text: '一句话🙂', shortSeed: true });
            assert.equal(rx.elements.get('receivedText').value, '一句话🙂');
        });
    }
}
