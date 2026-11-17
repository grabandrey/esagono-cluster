'use strict';
/*
 * Esagono cluster widget for BMW iDrive 8 (MGU), a root tool installed by MGU Store.
 *
 * Draws a supercar-style hexagon rev ring in the middle of the instrument cluster
 * through cluster-render (its `effect` layer on an iDrive 8 widget target). The whole
 * picture is one fragment shader (shader.js); this service only feeds it uniforms.
 *
 * Engine speed: read over SOME/IP from CDS 0xB513 event 0x8019 (statusEngineSpeed2,
 * u16 x 0.25 rpm) through an `hmictl serve` helper when one is installed on the head
 * unit (IterioDev's Overlays tool ships one). Esagono does not ship its own SOME/IP
 * client. Without one it shows 0 rpm, or a demo sweep when settings.demo is true.
 *
 * Node 8 compatible (the head unit's /usr/bin/node).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FS } = require('./shader');

const CLIENT = process.env.CLUSTER_RENDER_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const DATA_DIR = process.env.ESAGONO_DATA || '/var/opt/esagono-cluster';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HMICTL_CANDIDATES = [
    process.env.ESAGONO_HMICTL,
    '/var/opt/iteriodev-overlays/current/hmictl',
    '/var/opt/iteriodev-comfort/current/hmictl',
].filter(Boolean);

const RPM_SVC = 0xb513, RPM_EV = 0x8019;
const RPM_POLL = 'poll 0xb513 1 25 1 50 0x8019';
const STALE_MS = 3000;
const TICK_MS = 33;

const MODES = {
    comfort: { idx: 0, accent: [0.31, 0.85, 1.0] },
    sport:   { idx: 1, accent: [1.0, 0.77, 0.0] },
    track:   { idx: 2, accent: [1.0, 0.23, 0.12] },
};

/* the widget's safe rect on iDrive 8: the union of layout 4 (630x570@805,125) and
 * layout 5 (612x527@814,170), in the 2240x896 widget canvas (cluster-render README) */
const DEFAULTS = {
    mode: 'sport',
    rpmMax: 9000,
    redline: 7500,
    flashRpm: 7800,
    demo: false,
    backdrop: true,
    target: 'esagono',
    fallbackTarget: 'widget',
    x: 805, y: 125, w: 632, h: 572,
};

function log(msg) { process.stdout.write(new Date().toISOString() + ' esagono: ' + msg + '\n'); }

function loadSettings() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') log('settings.json unreadable, using defaults: ' + e.message);
    }
    const out = Object.assign({}, DEFAULTS, s);
    if (!MODES[out.mode]) out.mode = DEFAULTS.mode;
    const n = (v, lo, hi, d) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    out.rpmMax = Math.round(n(out.rpmMax, 4000, 10000, DEFAULTS.rpmMax) / 1000) * 1000;
    out.redline = n(out.redline, 2000, out.rpmMax, Math.min(DEFAULTS.redline, out.rpmMax));
    out.flashRpm = n(out.flashRpm, 2000, out.rpmMax, Math.min(out.redline + 300, out.rpmMax));
    return out;
}

function writeDefaultSettings() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        if (!fs.existsSync(SETTINGS_FILE)) {
            const d = { mode: DEFAULTS.mode, rpmMax: DEFAULTS.rpmMax, redline: DEFAULTS.redline,
                flashRpm: DEFAULTS.flashRpm, demo: DEFAULTS.demo, backdrop: DEFAULTS.backdrop };
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(d, null, 2) + '\n');
        }
    } catch (e) { log('could not write default settings: ' + e.message); }
}

/* ---- engine speed source ---- */
function startRpmSource(onRpm) {
    const bin = HMICTL_CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } });
    if (!bin) { log('no hmictl found (' + HMICTL_CANDIDATES.join(', ') + '): no live rpm'); return; }
    let child = null, buf = '';
    const start = () => {
        log('rpm source: ' + bin + ' serve');
        child = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
        child.on('error', (e) => log('hmictl: ' + e.message));
        child.stdin.on('error', (e) => log('hmictl stdin: ' + e.message));
        child.stdout.on('data', (d) => {
            buf += d;
            for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
                const line = buf.slice(0, n).trim();
                if (line.indexOf('ev ') === 0) {
                    const w = line.split(/\s+/);
                    if (parseInt(w[1], 16) === RPM_SVC && parseInt(w[2], 16) === RPM_EV && w[3] && w[3].length >= 4) {
                        onRpm(parseInt(w[3].slice(0, 4), 16) * 0.25);
                    }
                } else if (/^error\b/.test(line)) log('hmictl: ' + line);
            }
        });
        child.on('exit', (c) => { log('hmictl exited ' + c + ', restarting in 5 s'); child = null; buf = ''; setTimeout(start, 5000); });
        child.stdin.write(RPM_POLL + '\n');
    };
    start();
    process.on('exit', () => { if (child) try { child.kill(); } catch (e) { /* exiting */ } });
}

/* ---- the renderer ---- */
function main() {
    writeDefaultSettings();
    let S = loadSettings();
    fs.watchFile(SETTINGS_FILE, { interval: 2000 }, () => { S = loadSettings(); log('settings reloaded: ' + S.mode); pushStatic(); });

    let ClusterRender;
    try { ClusterRender = require(CLIENT).ClusterRender; } catch (e) {
        log('cluster-render client not found at ' + CLIENT + ' (' + e.message + '); retrying in 30 s');
        setTimeout(main, 30000);
        return;
    }

    const cr = new ClusterRender('esagono-cluster', process.env.CLUSTER_RENDER_SOCKET);
    let layer = 0, target = S.target, triedFallback = false;

    function makeLayer() {
        layer = cr.effect({ target: target, klass: 'content', x: S.x, y: S.y, w: S.w, h: S.h, fs: FS, visible: 1 });
        if (!layer) { log('effect layer rejected by the client'); return; }
        log('layer ' + layer + ' on target ' + target);
        last = {};
        pushStatic();
    }
    function fallback(why) {
        if (triedFallback || target === S.fallbackTarget) return;
        triedFallback = true;
        log('target ' + target + ' unusable (' + why + '); falling back to ' + S.fallbackTarget);
        if (layer) cr.drop(layer);
        target = S.fallbackTarget;
        makeLayer();
    }

    let last = {};
    function uni(name, values) {
        const key = values.map((v) => v.toFixed(3)).join(' ');
        if (last[name] === key || !layer) return;
        last[name] = key;
        cr.uniform(layer, name, values);
    }
    function pushStatic() {
        if (!layer) return;
        const M = MODES[S.mode];
        uni('u_size', [S.w, S.h]);
        uni('u_red', [S.redline / S.rpmMax]);
        uni('u_divs', [S.rpmMax / 1000]);
        uni('u_accent', M.accent);
        uni('u_mode', [M.idx]);
        uni('u_bg', [S.backdrop ? 1 : 0]);
    }

    cr.on('ready', () => {
        log('connected, backend ' + cr.backend + ', targets ' + JSON.stringify(cr.targets));
        if (cr.backend && cr.backend !== 'id8') log('warning: built for iDrive 8, this head unit is ' + cr.backend);
        if (Array.isArray(cr.targets) && cr.targets.indexOf(target) < 0) fallback('not offered by this renderer yet (restart the head unit once)');
    });
    cr.on('disconnected', () => log('renderer went away; the client reconnects'));
    cr.on('layer', (ref, state, reason) => {
        if (ref !== layer) return;
        log('layer ' + state + (reason ? ' (' + reason + ')' : ''));
        if (state === 'error') fallback(reason || 'error');
    });
    cr.on('target', (name, state, holder, reason) => {
        log('target ' + name + ' ' + state + (reason ? ' (' + reason + ')' : ''));
        if (name === target && state === 'unavailable') fallback(reason || 'unavailable');
    });
    cr.on('refused', (op, ref, reason) => {
        log('refused ' + op + ' ' + ref + ': ' + reason);
        if (ref === layer && (op === 'layer' || op === 'effect')) fallback(reason);
    });
    cr.connect();
    makeLayer();

    /* rpm: live, demo or none */
    let rawRpm = 0, rawAt = 0, shown = 0;
    startRpmSource((r) => { rawRpm = r; rawAt = Date.now(); });
    const t0 = Date.now();

    setInterval(() => {
        const now = Date.now();
        let want;
        if (now - rawAt < STALE_MS) want = rawRpm;
        else if (S.demo) {
            const ph = ((now - t0) / 1000) % 7;
            want = ph < 5 ? 1000 + (S.rpmMax - 1200) * Math.pow(ph / 5, 1.4) : 1000 + (S.rpmMax - 1200) * (1 - (ph - 5) / 2);
        } else want = 0;
        shown += (want - shown) * 0.35;
        if (Math.abs(want - shown) < 5) shown = want;

        const flash = shown >= S.flashRpm && Math.floor(now / 80) % 2 === 0;
        const k = Math.max(0, Math.min(99, Math.round(shown / 100)));
        uni('u_rpm', [Math.max(0, Math.min(1, shown / S.rpmMax))]);
        uni('u_flash', [flash ? 1 : 0]);
        uni('u_num', [Math.floor(k / 10) % 10, k % 10, 1]);
    }, TICK_MS);

    process.on('SIGTERM', () => { try { cr.close(); } catch (e) { /* exiting */ } process.exit(0); });
}

if (require.main === module) main();
module.exports = { main, loadSettings, DEFAULTS, MODES };
