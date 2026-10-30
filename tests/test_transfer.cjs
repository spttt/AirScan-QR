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
        atob, btoa, Math: math, console, setInterval: () => 1, clearInterval() {},
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
    return { run, context, elements, downloads, blobs, fountain: filename.includes('fountain') };
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
        test(`${filename}: single-chunk short sentence completes for degree 2 seed`, () => {
            const tx = page(filename), rx = page(filename);
            transfer(tx, rx, { text: '一句话🙂', shortSeed: true });
            assert.equal(rx.elements.get('receivedText').value, '一句话🙂');
        });
    }
}
