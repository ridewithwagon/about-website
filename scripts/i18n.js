#!/usr/bin/env node
/*
 * i18n tool for the Wagon presentation site.
 *
 * - Extracts every French verbatim (element text, alt, title, aria-label,
 *   meta description/title) from the source HTML pages and includes.
 * - Maintains i18n/strings.json  { "<FR text>": { "en": "...", "cs": "..." } }
 *   Existing translations are never overwritten; new verbatims are added.
 * - Generates localized pages under ./en and ./cs (index.html, advertise.html,
 *   legal.html, regions.html, nav.html, footer.html).
 * - Rewrites relative/absolute URLs to work from the locale subdirectory.
 * - Injects a language-switch banner that detects the browser language.
 *
 * Usage:
 *   node scripts/i18n.js            # extract + generate (default)
 *   node scripts/i18n.js --extract  # only refresh strings.json
 *   node scripts/i18n.js --generate # only (re)build locale folders
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const I18N_DIR = path.join(ROOT, "i18n");
const STRINGS_FILE = path.join(I18N_DIR, "strings.json");

const LOCALES = ["en", "cs"];
const SOURCE_LANG = "fr";

// Full pages (have <html>/<body>) that become standalone localized pages.
const PAGES = ["index.html", "advertise.html", "legal.html", "regions.html"];
// HTML fragments included at runtime via fetch(); they live in the same dir
// as the page that loads them, so we must emit localized copies per locale.
const INCLUDES = ["nav.html", "footer.html"];

// ---------------------------------------------------------------------------
// Tiny HTML helpers
// ---------------------------------------------------------------------------

function readText(file) {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// Extract the verbatim strings from a piece of HTML.
// We collect:
//   - <title>…</title> content
//   - <meta name="description" content="…"> and property="og:*"
//   - text nodes that are not inside <script>/<style>
//   - alt, title, aria-label attribute values
function extractStrings(html) {
    const strings = new Set();

    // 0. Strip HTML comments and any previously injected banner so re-running
    //    the tool never extracts the banner copy as new verbatims.
    const cleaned = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<div id="lang-banner"[\s\S]*?<\/div>\s*<script id="lang-banner-script">[\s\S]*?<\/script>/gi, "");

    // 1. Drop <script>...</script> and <style>...</style> for text extraction.
    //    but keep a copy for attribute scanning (scripts rarely carry titles).
    const noCode = cleaned
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "");

    // 2. <title>…</title>
    for (const m of noCode.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)) {
        add(strings, m[1]);
    }

    // 3. meta descriptions / og tags
    for (const m of cleaned.matchAll(
        /<meta\s+[^>]*?(?:name|property)\s*=\s*"(?:description|og:title|og:description|twitter:title|twitter:description)"[^>]*?>/gi,
    )) {
        const tag = m[0];
        const cm = tag.match(/content\s*=\s*"([^"]*)"/i);
        if (cm) add(strings, cm[1]);
    }

    // 4. Attributes: alt, title, aria-label — anywhere in the document
    //    (including raw fragments, before any body parsing).
    for (const m of cleaned.matchAll(
        /\b(?:alt|title|aria-label)\s*=\s*"([^"]*)"/gi,
    )) {
        add(strings, m[1]);
    }

    // 5. Text nodes between > and < (using the code-stripped version).
    for (const m of noCode.matchAll(/>([^<]+)</g)) {
        add(strings, m[1]);
    }

    return strings;
}

function add(set, value) {
    const v = value == null ? "" : String(value);
    const trimmed = v.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    // Skip pure punctuation / standalone symbols.
    if (/^[—–·•.,;:!?()'"\s-]+$/.test(trimmed)) return;
    set.add(trimmed);
}

// ---------------------------------------------------------------------------
// strings.json maintenance
// ---------------------------------------------------------------------------

function loadStrings() {
    if (!fs.existsSync(STRINGS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(STRINGS_FILE, "utf8"));
    } catch (e) {
        console.warn("strings.json unreadable, starting fresh:", e.message);
        return {};
    }
}

function extractAll() {
    const db = loadStrings();
    let added = 0;
    for (const f of [...PAGES, ...INCLUDES]) {
        const html = readText(f);
        for (const s of extractStrings(html)) {
            if (!(s in db)) {
                db[s] = { en: "", cs: "" };
                added++;
            }
        }
    }
    // Save deterministically (sorted by French key).
    const out = {};
    for (const k of Object.keys(db).sort((a, b) => a.localeCompare(b, "fr"))) {
        out[k] = {
            en: (db[k] && db[k].en) || "",
            cs: (db[k] && db[k].cs) || "",
        };
    }
    fs.mkdirSync(I18N_DIR, { recursive: true });
    fs.writeFileSync(STRINGS_FILE, JSON.stringify(out, null, 4) + "\n", "utf8");
    const total = Object.keys(out).length;
    console.log(`Extracted. ${added} new key(s), ${total} total. Written to i18n/strings.json`);
    return out;
}

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

const PAGES_SET = new Set(PAGES.map((p) => "/" + p));

function rewriteUrl(url, locale) {
    if (!url) return url;
    if (locale === SOURCE_LANG) return url; // FR pages live at the root, keep URLs untouched
    const t = url.trim();
    if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(t)) return url;
    if (t.startsWith("//")) return url;
    let hashQuery = "";
    let core = t;
    // keep ?query and #hash aside
    const qm = core.search(/[?#]/);
    if (qm !== -1) {
        hashQuery = core.slice(qm);
        core = core.slice(0, qm);
    }
    if (core === "/") return "/" + locale + "/" + hashQuery;
    if (PAGES_SET.has(core) || core === "/index.html") {
        return "/" + locale + core.replace(/^\/index\.html$/, "/") + hashQuery;
    }
    if (core.startsWith("/")) return url; // root-absolute asset, keep as-is
    // relative URL: page lives in /{locale}/ so it must climb one level
    return "../" + url;
}

// Replace attribute values for src / href so they resolve locally.
function rewriteUrlsInHtml(html, locale) {
    return html.replace(
        /(<[a-z][\w:-]*(?![^>]*\bdata-localization\s*=\s*"false")[^>]*\b(?:href|src)\s*=\s*")([^"]*)"/gi,
        (full, prefix, url) => `${prefix}${rewriteUrl(url, locale)}"`,
    );
}

// ---------------------------------------------------------------------------
// Translation substitution
// ---------------------------------------------------------------------------

function buildReplacer(db, locale) {
    // Order keys by length desc so longer sentences are replaced before any
    // potential substring match.
    const keys = Object.keys(db).sort((a, b) => b.length - a.length);

    return function translate(html) {
        // --- attributes first (alt/title/aria-label) ---
        html = html.replace(
            /\b(alt|title|aria-label)\s*=\s*"([^"]*)"/gi,
            (full, attr, val) => {
                const key = val.replace(/\s+/g, " ").trim();
                if (!key) return full;
                const tr = lookup(db, locale, key);
                if (tr == null || tr === "") return full;
                return `${attr}="${escapeAttr(tr)}"`;
            },
        );

        // --- text nodes: >...<  (ignore <script>/<style> blocks) ---
        // We split the document around inline code blocks so we never touch
        // their contents.
        const parts = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/gi);
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) continue; // code block, leave alone
            parts[i] = parts[i].replace(/>([^<]+)</g, (full, txt) => {
                const key = txt.replace(/\s+/g, " ").trim();
                if (!key) return full;
                const tr = lookup(db, locale, key);
                if (tr == null || tr === "") return full;
                // Preserve surrounding leading/trailing whitespace.
                const lead = txt.length - txt.replace(/^\s+/, "").length;
                const trail = txt.length - txt.replace(/\s+$/, "").length;
                return (
                    ">" +
                    txt.slice(0, lead) +
                    escapeText(tr) +
                    txt.slice(txt.length - trail) +
                    "<"
                );
            });
        }
        return parts.join("");
    };
}

function lookup(db, locale, key) {
    const entry = db[key];
    if (!entry) return null;
    const v = entry[locale];
    if (typeof v === "string" && v.trim() !== "") return v;
    return ""; // signal "absent"; caller falls back to original French
}

function escapeAttr(s) {
    return s.replace(/"/g, "&quot;");
}
function escapeText(s) {
    return s; // keep as-is (we don't introduce <, >, & from translations)
}

// ---------------------------------------------------------------------------
// Page generation
// ---------------------------------------------------------------------------

function setHtmlLang(html, locale) {
    return html.replace(
        /<html\s+lang\s*=\s*"[^"]*"/i,
        `<html lang="${locale}"`,
    );
}

function generateAll(db) {
    const allLocales = [SOURCE_LANG, ...LOCALES];
    for (const locale of allLocales) {
        const dir = locale === SOURCE_LANG ? ROOT : path.join(ROOT, locale);
        fs.mkdirSync(dir, { recursive: true });

        const translate = buildReplacer(db, locale);

        for (const src of [...PAGES, ...INCLUDES]) {
            let html = readText(src);

            html = setHtmlLang(html, locale);

            // Translate strings (no-op for FR: no fr translations stored).
            html = translate(html);

            // Rewrite URLs so assets/includes resolve from /{locale}/.
            // For FR this is a no-op (urls stay root-relative).
            html = rewriteUrlsInHtml(html, locale);

            fs.writeFileSync(path.join(dir, src), html, "utf8");
        }
        console.log(`Generated /${locale === SOURCE_LANG ? "" : locale + "/"} (${PAGES.length + INCLUDES.length} files)`);
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
    const arg = process.argv[2] || "";
    let db;
    if (arg === "--extract") {
        extractAll();
        return;
    }
    if (arg === "--generate") {
        db = loadStrings();
    } else {
        db = extractAll();
    }
    generateAll(db);
    console.log("Done.");
}

main();